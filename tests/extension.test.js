const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const projectRoot = path.resolve(__dirname, "..");

function readProjectFile(relativePath) {
  const filePath = path.join(projectRoot, relativePath);
  assert.ok(fs.existsSync(filePath), `${relativePath} deve existir`);
  return fs.readFileSync(filePath, "utf8");
}

function loadScript(relativePath, context) {
  const source = readProjectFile(relativePath);
  vm.runInNewContext(source, context, { filename: relativePath });
}

// Minimal DOM fixture with subtree queries, rendered text, labels and cloning.
function pageElement(tag, text = "", attributes = {}, children = []) {
  const element = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    attributes,
    children,
    labels: [],
    style: { display: "block", visibility: "visible", opacity: "1" },
    geometry: true,
    value: attributes.value || "",
    type: attributes.type || (tag === "input" ? "text" : ""),
    getAttribute(name) { return attributes[name] ?? null; },
    get childNodes() { return [...(text ? [{ nodeType: 3, textContent: text, parentElement: this }] : []), ...children]; },
    get textContent() { return [text, ...children.map((child) => child.textContent)].join(""); },
    get innerText() {
      if (this.detached) return this.textContent;
      if (this.style.display === "none" || this.style.visibility === "hidden") return "";
      return [text, ...children.map((child) => child.innerText)].join(" ");
    },
    getClientRects() { return this.geometry ? [{ width: 100, height: 20 }] : []; },
    querySelectorAll(selector) {
      const matches = (child) => selector.split(",").some((part) => {
        const match = part.trim().match(/^(\w+)?(?:\[([\w-]+)(?:=["']?([^\]"']+)["']?)?\])?$/);
        assert.ok(match, `seletor DOM suportado: ${part}`);
        return (!match[1] || child.tagName === match[1].toUpperCase()) &&
          (!match[2] || (child.getAttribute(match[2]) !== null &&
            (match[3] === undefined || child.getAttribute(match[2]) === match[3])));
      });
      return children.flatMap((child) => [
        ...(matches(child) ? [child] : []), ...child.querySelectorAll(selector),
      ]);
    },
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
    cloneNode() {
      const clone = pageElement(tag, text, { ...attributes }, children.map((child) => child.cloneNode(true)));
      clone.style = { ...this.style };
      clone.geometry = this.geometry;
      clone.detached = true;
      return clone;
    },
    remove() {
      const siblings = this.parentElement?.children;
      if (siblings) siblings.splice(siblings.indexOf(this), 1);
    },
  };
  for (const child of children) child.parentElement = element;
  return element;
}

function pageDocument(children = []) {
  const body = pageElement("body", "", {}, children);
  return {
    title: "YouTube", body,
    querySelectorAll: (selector) => body.querySelectorAll(selector),
    querySelector: (selector) => body.querySelector(selector),
    getElementById: (id) => body.querySelectorAll("[id]").find((element) => element.getAttribute("id") === id) || null,
  };
}

function createBackgroundHarness({ deferSessionGet = false, fetchImpl } = {}) {
  let commandListener;
  let messageListener;
  const sentMessages = [];
  const sessionStorage = {};
  const pendingSessionGets = [];
  const chrome = {
    commands: {
      onCommand: {
        addListener(listener) {
          commandListener = listener;
        },
      },
    },
    runtime: { onMessage: { addListener(listener) { messageListener = listener; } } },
    storage: {
      session: {
        get(key, callback) {
          const respond = () => callback({ [key]: sessionStorage[key] });
          if (deferSessionGet) {
            pendingSessionGets.push(respond);
            return;
          }
          respond();
        },
        set(values, callback) {
          Object.assign(sessionStorage, values);
          callback?.();
        },
      },
    },
    tabs: {
      query(queryInfo, callback) {
        assert.equal(queryInfo.active, true);
        assert.equal(queryInfo.currentWindow, true);
        callback([{ id: 42 }]);
      },
      sendMessage(tabId, message, callback) {
        sentMessages.push({ tabId, message: JSON.parse(JSON.stringify(message)) });
        callback();
      },
    },
  };

  loadScript("background.js", { chrome, console, URL, fetch: fetchImpl });

  return {
    sentMessages,
    sessionStorage,
    requestWeather(city) {
      assert.equal(typeof messageListener, "function", "weather listener registered");
      return new Promise((resolve) => {
        assert.equal(messageListener({ type: "JARVIS_WEATHER_REQUEST", city }, {},
          (result) => resolve(JSON.parse(JSON.stringify(result)))), true);
      });
    },
    activate() {
      commandListener("activate-assistant");
    },
    resolveNextSessionGet() {
      const respond = pendingSessionGets.shift();
      assert.ok(respond, "deve haver uma leitura de storage.session pendente");
      respond();
    },
  };
}

function createContentHarness({
  recognitionAvailable = true,
  audioAvailable = true,
  audioState = "running",
  autoAudio = true,
  autoAbort = true,
  storedPreferences,
  deferLocalGet = false,
  deferLocalSet = false,
  voices = [],
  fixedNow,
  page = pageDocument(),
} = {}) {
  let messageListener;
  let nextTimerId = 1;
  const timers = new Map();
  const spoken = [];
  const storage = storedPreferences === undefined
    ? {}
    : { jarvisPreferences: structuredClone(storedPreferences) };
  const storageWrites = [];
  const pendingLocalGets = [];
  const pendingLocalSets = [];
  const activationResponses = [];
  const runtimeMessages = [];
  const weatherCallbacks = [];
  const events = [];
  const overlaps = [];
  const oscillators = [];
  const scrollCalls = [];
  const history = {
    backCount: 0, forwardCount: 0,
    back() { this.backCount += 1; },
    forward() { this.forwardCount += 1; },
  };
  let activeAudio = null;
  let activeSpeech = null;
  let activeRecognition = null;
  function checkOverlap(kind) {
    if (activeAudio || activeSpeech || activeRecognition) overlaps.push(kind);
  }
  const audio = { startCount: 0, stopCount: 0, closeCount: 0 };
  const synth = {
    cancelCount: 0,
    cancel() {
      this.cancelCount += 1;
      activeSpeech = null;
    },
    speak(utterance) {
      checkOverlap("speech");
      activeSpeech = utterance;
      events.push(utterance.text === "Olá, sou Jarvis, à sua disposição." ? "speech:intro" : `speech:${utterance.text}`);
      spoken.push(utterance);
      utterance.onstart?.();
    },
    getVoices() {
      return voices;
    },
  };

  class FakeUtterance {
    constructor(text) {
      this.text = text;
      this.lang = "";
    }
  }

  class FakeRecognition {
    static instances = [];

    constructor() {
      this.lang = "";
      this.continuous = true;
      this.interimResults = true;
      this.startCount = 0;
      this.stopCount = 0;
      this.abortCount = 0;
      FakeRecognition.instances.push(this);
    }

    start() {
      checkOverlap("recognition");
      activeRecognition = this;
      events.push("recognition:start");
      this.startCount += 1;
      this.onstart?.();
    }

    stop() {
      this.stopCount += 1;
    }

    abort() {
      this.abortCount += 1;
      if (autoAbort) this.emitEnd();
    }

    emitResult(transcript) {
      this.onresult?.({ results: [[{ transcript }]] });
    }

    emitError(error = "no-speech") {
      this.onerror?.({ error });
    }

    emitEnd() {
      if (activeRecognition === this) activeRecognition = null;
      events.push("recognition:end");
      this.onend?.();
    }
  }

  class FakeAudioContext {
    constructor() {
      this.state = audioState;
      this.currentTime = 0;
      this.destination = {};
    }

    close() {
      audio.closeCount += 1;
    }

    createOscillator() {
      const oscillator = {
        frequency: { value: 0 },
        connect() {},
        start() {
          checkOverlap("earcon");
          activeAudio = this;
          audio.startCount += 1;
        },
        stop(when) {
          audio.stopCount += 1;
          if (when === undefined) {
            if (activeAudio === this) activeAudio = null;
            return;
          }
          this.kind = { "0.2": "ON", "0.07": "LISTENING", "0.09": "PROCESSING", "0.18": "OFF" }[when] || "UNKNOWN";
          events.push(`earcon:${this.kind}`);
          if (autoAudio) finishAudio(oscillators.indexOf(this));
        },
      };
      oscillators.push(oscillator);
      return oscillator;
    }

    createGain() {
      return {
        gain: {
          setValueAtTime() {},
          exponentialRampToValueAtTime() {},
        },
        connect() {},
      };
    }
  }

  const chrome = {
    runtime: {
      sendMessage(message, callback) {
        checkOverlap("network");
        runtimeMessages.push(JSON.parse(JSON.stringify(message)));
        weatherCallbacks.push(callback);
      },
      onMessage: {
        addListener(listener) {
          messageListener = listener;
        },
      },
    },
    storage: {
      local: {
        get(key, callback) {
          const respond = () => callback({ [key]: storage[key] });
          if (deferLocalGet) {
            pendingLocalGets.push(respond);
            return;
          }
          respond();
        },
        set(values, callback) {
          const saved = structuredClone(values);
          const persist = () => {
            Object.assign(storage, saved);
            storageWrites.push(saved);
            events.push("storage:set");
            callback?.();
          };
          if (deferLocalSet) {
            pendingLocalSets.push(persist);
            return;
          }
          persist();
        },
      },
    },
  };

  const ContextDate = fixedNow === undefined
    ? Date
    : class FixedDate extends Date {
      constructor(...args) {
        super(...(args.length ? args : [fixedNow]));
      }

      static now() {
        return new Date(fixedNow).getTime();
      }
    };
  const context = {
    chrome,
    console,
    document: page,
    location: { hostname: "youtube.com" },
    history,
    innerHeight: 1000,
    scrollBy(options) { scrollCalls.push(structuredClone(options)); },
    getComputedStyle: (element) => element.style,
    speechSynthesis: synth,
    SpeechSynthesisUtterance: FakeUtterance,
    Date: ContextDate,
    setTimeout(callback, delay) {
      const id = nextTimerId++;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  };

  context.globalThis = context;
  context.window = context;
  if (audioAvailable) context.AudioContext = FakeAudioContext;
  if (recognitionAvailable) {
    context.SpeechRecognition = FakeRecognition;
  }

  loadScript("content.js", context);

  function activate(introduce = true) {
    let response;
    messageListener(
      { type: "ACCESSIBLE_ASSISTANT_ACTIVATE", introduce },
      {},
      (value) => {
        response = value;
        activationResponses.push(value);
      },
    );
    return response;
  }

  function finishSpeech(index = spoken.length - 1) {
    if (activeSpeech === spoken[index]) activeSpeech = null;
    events.push("speech:end");
    spoken[index].onend?.();
  }

  function finishAudio(index = oscillators.length - 1) {
    const oscillator = oscillators[index];
    if (activeAudio === oscillator) activeAudio = null;
    events.push(`earcon:${oscillator.kind}:end`);
    oscillator.onended?.();
  }

  function activateAndListen() {
    const response = activate();
    finishSpeech();
    return { response, recognition: FakeRecognition.instances.at(-1) };
  }

  function runSessionTimer() {
    const sessionTimer = [...timers.values()].find(({ delay }) => delay === 30_000);
    assert.ok(sessionTimer, "timer de sessão deve estar ativo");
    sessionTimer.callback();
  }

  return {
    context,
    synth,
    audio,
    spoken,
    storage,
    storageWrites,
    activationResponses,
    runtimeMessages,
    weatherCallbacks,
    timers,
    events,
    overlaps,
    oscillators,
    scrollCalls,
    history,
    finishAudio,
    FakeRecognition,
    activate,
    activateAndListen,
    finishSpeech,
    runSessionTimer,
    resolveNextLocalGet() {
      const respond = pendingLocalGets.shift();
      assert.ok(respond, "deve haver uma leitura de storage.local pendente");
      respond();
    },
    resolveNextLocalSet() {
      const persist = pendingLocalSets.shift();
      assert.ok(persist, "deve haver uma escrita de storage.local pendente");
      persist();
    },
  };
}

test("clima: manifesto autoriza somente os dois hosts Open-Meteo", () => {
  assert.deepEqual(JSON.parse(readProjectFile("manifest.json")).host_permissions, [
    "https://geocoding-api.open-meteo.com/*", "https://api.open-meteo.com/*",
  ]);
});

function weatherBackground(responses) {
  const calls = [];
  const harness = createBackgroundHarness({ fetchImpl: async (url) => {
    calls.push(String(url));
    const response = responses.shift();
    if (response instanceof Error) throw response;
    return { ok: true, json: async () => response };
  } });
  return { ...harness, calls };
}

const weatherCity = { results: [{ name: "São Luís", latitude: 0, longitude: -44.3 }] };

test("clima: background codifica cidade e consulta apenas campos autorizados preservando zero", async () => {
  const h = weatherBackground([weatherCity, {
    current: { temperature_2m: 0, apparent_temperature: 0, weather_code: 0, wind_speed_10m: 0 },
    daily: { temperature_2m_max: [0], temperature_2m_min: [0] },
  }]);
  const result = await h.requestWeather("São Luís");
  assert.deepEqual(result, { ok: true, city: "São Luís", temperature: 0,
    apparentTemperature: 0, weatherCode: 0, windSpeed: 0, maximum: 0, minimum: 0 });
  const geo = new URL(h.calls[0]);
  assert.equal(geo.origin + geo.pathname, "https://geocoding-api.open-meteo.com/v1/search");
  assert.deepEqual(Object.fromEntries(geo.searchParams), {
    name: "São Luís", count: "1", language: "pt", format: "json",
  });
  const forecast = new URL(h.calls[1]);
  assert.equal(forecast.origin + forecast.pathname, "https://api.open-meteo.com/v1/forecast");
  assert.deepEqual(Object.fromEntries(forecast.searchParams), {
    latitude: "0", longitude: "-44.3",
    current: "temperature_2m,apparent_temperature,weather_code,wind_speed_10m",
    daily: "temperature_2m_max,temperature_2m_min", timezone: "auto", forecast_days: "1",
  });
});

test("clima: background omite valores e arrays diários ausentes", async () => {
  const h = weatherBackground([weatherCity, { current: { temperature_2m: 22.6,
    apparent_temperature: null, weather_code: "0", wind_speed_10m: null } }]);
  assert.deepEqual(await h.requestWeather("São Luís"), { ok: true, city: "São Luís", temperature: 22.6 });
});

test("clima: background distingue cidade ausente de respostas malformadas e falhas", async () => {
  for (const [responses, reason] of [
    [{ results: [] }, "city-not-found"], [{}, "city-not-found"],
    [null, "network"], [{ error: true, reason: "invalid query" }, "network"],
    [{ results: "invalid" }, "network"],
    [{ results: [{ name: "X", latitude: null, longitude: 0 }] }, "network"],
    [new Error("offline"), "network"],
  ]) {
    const h = weatherBackground([responses]);
    assert.deepEqual(await h.requestWeather("X"), { ok: false, reason });
    assert.equal(h.calls.length, 1);
  }
  for (const forecast of [null, {}, { current: {} }, { current: { temperature_2m: "warm" } }, new Error("offline")]) {
    const h = weatherBackground([weatherCity, forecast]);
    assert.deepEqual(await h.requestWeather("X"), { ok: false, reason: "network" });
  }
  for (const failAt of [1, 2]) {
    let count = 0;
    const h = createBackgroundHarness({ fetchImpl: async () => ({
      ok: ++count !== failAt, json: async () => weatherCity,
    }) });
    assert.deepEqual(await h.requestWeather("X"), { ok: false, reason: "network" });
  }
  const invalidJson = createBackgroundHarness({ fetchImpl: async () => ({
    ok: true, json: async () => { throw new SyntaxError("invalid json"); },
  }) });
  assert.deepEqual(await invalidJson.requestWeather("X"), { ok: false, reason: "network" });
});

test("clima: background rejeita cidade inválida sem rede", async () => {
  for (const city of [null, {}, "   "]) {
    const h = weatherBackground([]);
    assert.deepEqual(await h.requestWeather(city), { ok: false, reason: "city-not-found" });
    assert.equal(h.calls.length, 0);
  }
});

test("clima: formas diretas enviam somente cidade e mantêm PROCESSING sem microfone", () => {
  for (const command of ["tempo em São Luís", "Jarvis, qual o clima em São Luís?", "previsão do tempo em São Luís", "previsão em São Luís"]) {
    const h = createContentHarness();
    runRecognizedCommand(h, command);
    assert.deepEqual(h.runtimeMessages, [{ type: "JARVIS_WEATHER_REQUEST", city: "São Luís" }]);
    assert.equal(h.context.__accessibleWebAssistantState.status, "PROCESSING");
    assert.equal(h.FakeRecognition.instances.length, 1);
    assert.deepEqual(h.overlaps, []);
    assert.deepEqual(h.storageWrites, []);
  }
});

test("clima: pergunta cidade, consome próxima fala e permite cancelar antes de qualquer comando", () => {
  const h = createContentHarness();
  runRecognizedCommand(h, "como está o tempo?");
  assert.equal(h.context.__accessibleWebAssistantState.pendingIntent, "weatherCity");
  assert.equal(h.spoken.at(-1).text, "De qual cidade?");
  h.finishSpeech();
  let mic = h.FakeRecognition.instances.at(-1);
  mic.emitResult("Anápolis"); mic.emitEnd();
  assert.deepEqual(h.runtimeMessages.at(-1), { type: "JARVIS_WEATHER_REQUEST", city: "Anápolis" });
  assert.equal(h.context.__accessibleWebAssistantState.pendingIntent, null);
  h.weatherCallbacks[0]({ ok: false, reason: "city-not-found" });
  h.finishSpeech();
  mic = h.FakeRecognition.instances.at(-1);
  mic.emitResult("clima"); mic.emitEnd(); h.finishSpeech();
  mic = h.FakeRecognition.instances.at(-1);
  mic.emitResult("Jarvis, cancelar!"); mic.emitEnd();
  assert.equal(h.spoken.at(-1).text, "Cancelado.");
  assert.equal(h.context.__accessibleWebAssistantState.pendingIntent, null);
  assert.equal(h.runtimeMessages.length, 1);
  assert.deepEqual(h.storageWrites, []);
});

test("clima: resposta arredonda valores presentes, traduz código e continua conversa", () => {
  const h = createContentHarness();
  runRecognizedCommand(h, "clima em Anápolis");
  h.weatherCallbacks[0]({ ok: true, city: "Anápolis", temperature: 22.6,
    apparentTemperature: 0, weatherCode: 0, windSpeed: 0, maximum: 29.8, minimum: 0 });
  assert.equal(h.spoken.at(-1).text,
    "Em Anápolis. Céu limpo. Temperatura de 23 graus. Sensação de 0 graus. Vento de 0 quilômetros por hora. Máxima de 30 graus. Mínima de 0 graus.");
  h.finishSpeech();
  const mic = h.FakeRecognition.instances.at(-1);
  mic.emitResult("que horas são"); mic.emitEnd();
  assert.match(h.spoken.at(-1).text, /^Agora são/);
  assert.deepEqual(h.overlaps, []);
});

test("clima: cidade pendente usa a próxima fala exclusivamente como cidade", () => {
  for (const command of ["modo denso", "encerrar assistente", "que horas são"]) {
    const h = createContentHarness();
    runRecognizedCommand(h, "clima"); h.finishSpeech();
    const mic = h.FakeRecognition.instances.at(-1);
    mic.emitResult(command); mic.emitEnd();
    assert.deepEqual(h.runtimeMessages, [{ type: "JARVIS_WEATHER_REQUEST", city: command }]);
    assert.equal(h.context.__accessibleWebAssistantState.mode, "dynamic");
    assert.equal(h.context.__accessibleWebAssistantState.isActive, true);
    assert.deepEqual(h.storageWrites, []);
  }
});

test("clima: traduz as famílias de códigos WMO sem depender da rede", () => {
  for (const [weatherCode, expected] of [
    [3, "Nublado"], [45, "Nevoeiro"], [53, "Garoa moderada"],
    [65, "Chuva forte"], [71, "Neve leve"], [82, "Pancadas de chuva fortes"],
    [86, "Pancadas de neve fortes"], [95, "Trovoadas"], [99, "Trovoadas com granizo forte"],
  ]) {
    const h = createContentHarness();
    runRecognizedCommand(h, "clima em X");
    h.weatherCallbacks[0]({ ok: true, city: "X", weatherCode });
    assert.equal(h.spoken.at(-1).text, `Em X. ${expected}.`);
  }
});

test("clima: runtime desconectado informa falha e resposta duplicada não duplica fala", () => {
  const h = createContentHarness();
  runRecognizedCommand(h, "tempo em X");
  h.context.chrome.runtime.lastError = { message: "port closed" };
  h.weatherCallbacks[0]({ ok: true, city: "X", temperature: 12 });
  assert.equal(h.spoken.at(-1).text, "Não consegui consultar o clima agora.");
  const count = h.spoken.length;
  delete h.context.chrome.runtime.lastError;
  h.weatherCallbacks[0]({ ok: true, city: "X", temperature: 12 });
  assert.equal(h.spoken.length, count);
  h.finishSpeech();
  assert.equal(h.context.__accessibleWebAssistantState.status, "LISTENING");
  const thrown = createContentHarness();
  thrown.context.chrome.runtime.sendMessage = () => { throw new Error("disconnected"); };
  runRecognizedCommand(thrown, "clima em X");
  assert.equal(thrown.spoken.at(-1).text, "Não consegui consultar o clima agora.");
});

test("clima: valores ausentes e códigos desconhecidos não inventam informação", () => {
  const h = createContentHarness();
  runRecognizedCommand(h, "tempo em X");
  h.weatherCallbacks[0]({ ok: true, city: "X", temperature: 0, weatherCode: 999 });
  assert.equal(h.spoken.at(-1).text, "Em X. Temperatura de 0 graus.");
});

test("clima: falhas respondem cópias exatas e retomam escuta", () => {
  for (const [result, text] of [
    [{ ok: false, reason: "city-not-found" }, "Não encontrei essa cidade."],
    [{ ok: false, reason: "network" }, "Não consegui consultar o clima agora."],
    [undefined, "Não consegui consultar o clima agora."],
  ]) {
    const h = createContentHarness();
    runRecognizedCommand(h, "tempo em X");
    h.weatherCallbacks[0](result);
    assert.equal(h.spoken.at(-1).text, text);
    h.finishSpeech();
    assert.equal(h.context.__accessibleWebAssistantState.status, "LISTENING");
    assert.equal(h.FakeRecognition.instances.length, 2);
  }
});

test("clima: timeout, reativação e encerramento ignoram respostas antigas", () => {
  for (const action of ["timeout", "reactivate", "end"]) {
    const h = createContentHarness();
    runRecognizedCommand(h, "tempo em X");
    if (action === "timeout") h.runSessionTimer();
    else {
      h.activate(false);
      if (action === "end") {
        const mic = h.FakeRecognition.instances.at(-1);
        mic.emitResult("encerrar assistente"); mic.emitEnd(); h.finishSpeech();
      }
    }
    const speeches = h.spoken.length;
    const mics = h.FakeRecognition.instances.length;
    h.weatherCallbacks[0]({ ok: true, city: "X", temperature: 22 });
    assert.equal(h.spoken.length, speeches);
    assert.equal(h.FakeRecognition.instances.length, mics);
  }
});

test("clima: intenção pendente é apagada ao reativar e expirar sessão", () => {
  for (const action of ["reactivate", "timeout"]) {
    const h = createContentHarness();
    runRecognizedCommand(h, "previsão do tempo");
    assert.equal(h.context.__accessibleWebAssistantState.pendingIntent, "weatherCity");
    if (action === "reactivate") h.activate(false);
    else h.runSessionTimer();
    assert.equal(h.context.__accessibleWebAssistantState.pendingIntent, null);
  }
});

test("manifesto MV3 referencia arquivos, atalho e somente permissões necessárias", () => {
  const manifest = JSON.parse(readProjectFile("manifest.json"));

  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.background.service_worker, "background.js");
  assert.deepEqual(Array.from(manifest.permissions), ["storage"]);
  assert.deepEqual(
    Array.from(manifest.content_scripts[0].matches),
    ["http://*/*", "https://*/*"],
  );
  assert.deepEqual(Array.from(manifest.content_scripts[0].js), ["content.js"]);
  assert.equal(
    manifest.commands["activate-assistant"].suggested_key.default,
    "Alt+Shift+A",
  );

  assert.ok(fs.existsSync(path.join(projectRoot, manifest.background.service_worker)));
  for (const contentScript of manifest.content_scripts) {
    for (const scriptPath of contentScript.js) {
      assert.ok(fs.existsSync(path.join(projectRoot, scriptPath)));
    }
  }
});

test("service worker continua enviando ativação para a aba ativa", () => {
  const harness = createBackgroundHarness();
  harness.activate();

  assert.equal(harness.sentMessages.length, 1);
  assert.equal(harness.sentMessages[0].tabId, 42);
  assert.equal(
    harness.sentMessages[0].message.type,
    "ACCESSIBLE_ASSISTANT_ACTIVATE",
  );
});

test("primeira ativação da sessão apresenta Jarvis", () => {
  const harness = createBackgroundHarness();

  harness.activate();

  const { sentMessages } = harness;
  assert.deepEqual(sentMessages[0].message, {
    type: "ACCESSIBLE_ASSISTANT_ACTIVATE",
    introduce: true,
  });
});

test("segunda ativação não repete introdução", () => {
  const harness = createBackgroundHarness();

  harness.activate();
  harness.activate();

  const { sentMessages } = harness;
  assert.equal(sentMessages[1].message.introduce, false);
});

test("nova storage.session identifica nova primeira ativação", () => {
  const firstSession = createBackgroundHarness();
  const newSession = createBackgroundHarness();

  firstSession.activate();
  newSession.activate();

  assert.equal(firstSession.sentMessages[0].message.introduce, true);
  assert.equal(newSession.sentMessages[0].message.introduce, true);
});

test("ativações rápidas reservam uma única introdução", () => {
  const harness = createBackgroundHarness({ deferSessionGet: true });

  harness.activate();
  harness.activate();
  harness.resolveNextSessionGet();

  const rapidMessages = harness.sentMessages;
  assert.equal(
    rapidMessages.filter(({ message }) => message.introduce).length,
    1,
  );
});

test("content script inicia INACTIVE e ativação abre escuta configurada", () => {
  const harness = createContentHarness();

  assert.equal(harness.context.__accessibleWebAssistantState.status, "INACTIVE");
  assert.equal(harness.context.__accessibleWebAssistantState.isActive, false);
  assert.equal(harness.context.__accessibleWebAssistantState.mode, "dynamic");

  const { response, recognition } = harness.activateAndListen();

  assert.equal(response.ok, true);
  assert.equal(harness.context.__accessibleWebAssistantState.status, "LISTENING");
  assert.equal(harness.context.__accessibleWebAssistantState.isActive, true);
  assert.match(harness.context.__accessibleWebAssistantState.lastActivatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(recognition.lang, "pt-BR");
  assert.equal(recognition.continuous, false);
  assert.equal(recognition.interimResults, false);
  assert.equal(harness.spoken[0].text, "Olá, sou Jarvis, à sua disposição.");
  assert.deepEqual(harness.storage, {});
});

test("perfil vocal padrão prioriza voz pt-BR e configura toda fala", () => {
  const ptVoice = { voiceURI: "pt-pt", lang: "pt-PT", default: false };
  const defaultVoice = { voiceURI: "default-en", lang: "en-US", default: true };
  const brVoice = { voiceURI: "pt-br", lang: "pt-BR", default: false };
  const harness = createContentHarness({ voices: [ptVoice, defaultVoice, brVoice] });

  harness.activate();

  const utterance = harness.spoken[0];
  assert.equal(utterance.lang, "pt-BR");
  assert.equal(utterance.rate, 1.02);
  assert.equal(utterance.pitch, 0.9);
  assert.equal(utterance.volume, 1);
  assert.equal(utterance.voice.voiceURI, "pt-br");
});

test("ativação aguarda preferências e valida valores salvos", () => {
  const brVoice = { voiceURI: "pt-br", lang: "pt-BR", default: false };
  const harness = createContentHarness({
    deferLocalGet: true,
    voices: [brVoice],
    storedPreferences: {
      voiceURI: "voz-removida",
      rate: 99,
      pitch: 1.7,
      volume: -4,
      mode: "verbose",
      extra: "não persistir",
    },
  });

  assert.equal(harness.activate(), undefined);
  assert.equal(harness.spoken.length, 0);
  assert.equal(harness.audio.startCount, 0);
  assert.equal(harness.activationResponses.length, 0);

  harness.resolveNextLocalGet();

  assert.equal(harness.activationResponses[0].ok, true);
  assert.equal(harness.context.__accessibleWebAssistantState.mode, "dynamic");
  assert.equal(harness.spoken[0].rate, 1.5);
  assert.equal(harness.spoken[0].pitch, 0.9);
  assert.equal(harness.spoken[0].volume, 0.2);
  assert.equal(harness.spoken[0].voice.voiceURI, "pt-br");
});

test("voz salva instalada tem prioridade sobre pt-BR", () => {
  const savedVoice = { voiceURI: "saved-en", lang: "en-US", default: false };
  const brVoice = { voiceURI: "pt-br", lang: "pt-BR", default: true };
  const harness = createContentHarness({
    voices: [brVoice, savedVoice],
    storedPreferences: { voiceURI: "saved-en" },
  });

  harness.activate();

  assert.equal(harness.spoken[0].voice.voiceURI, "saved-en");
});

test("seleção de voz usa pt, depois padrão, e tolera lista vazia", () => {
  const ptVoice = { voiceURI: "pt", lang: "pt-PT", default: false };
  const ptHarness = createContentHarness({
    voices: [{ voiceURI: "en", lang: "en-US", default: true }, ptVoice],
  });
  ptHarness.activate();
  assert.equal(ptHarness.spoken[0].voice.voiceURI, "pt");

  const defaultVoice = { voiceURI: "default", lang: "en-US", default: true };
  const defaultHarness = createContentHarness({
    voices: [{ voiceURI: "other", lang: "es-ES", default: false }, defaultVoice],
  });
  defaultHarness.activate();
  assert.equal(defaultHarness.spoken[0].voice.voiceURI, "default");

  const emptyHarness = createContentHarness({ voices: [] });
  assert.doesNotThrow(() => emptyHarness.activate());
  assert.equal(emptyHarness.spoken[0].voice, undefined);
});

test("preferências de velocidade, volume e modo persistem o objeto único", () => {
  const scenarios = [
    { command: "fale mais rápido", stored: {}, expectedRate: 1.12, expectedVolume: 1, expectedMode: "dynamic" },
    { command: "fale mais devagar", stored: {}, expectedRate: 0.92, expectedVolume: 1, expectedMode: "dynamic" },
    { command: "velocidade normal", stored: { rate: 0.8 }, expectedRate: 1.02, expectedVolume: 1, expectedMode: "dynamic" },
    { command: "fale mais alto", stored: { volume: 0.5 }, expectedRate: 1.02, expectedVolume: 0.6, expectedMode: "dynamic" },
    { command: "fale mais baixo", stored: { volume: 0.5 }, expectedRate: 1.02, expectedVolume: 0.4, expectedMode: "dynamic" },
    { command: "modo dinâmico", stored: { mode: "dense" }, expectedRate: 1.02, expectedVolume: 1, expectedMode: "dynamic" },
    { command: "modo denso", stored: { extra: "não persistir" }, expectedRate: 1.02, expectedVolume: 1, expectedMode: "dense" },
  ];

  for (const scenario of scenarios) {
    const harness = createContentHarness({ storedPreferences: scenario.stored });
    const { recognition } = harness.activateAndListen();
    recognition.emitResult(scenario.command);
    recognition.emitEnd();

    assert.deepEqual(harness.storage.jarvisPreferences, {
      voiceURI: null,
      rate: scenario.expectedRate,
      pitch: 0.9,
      volume: scenario.expectedVolume,
      mode: scenario.expectedMode,
    });
    assert.equal(harness.context.__accessibleWebAssistantState.mode, scenario.expectedMode);
    assert.equal(harness.spoken.at(-1).rate, scenario.expectedRate);
    assert.equal(harness.spoken.at(-1).volume, scenario.expectedVolume);
    assert.equal(harness.spoken.at(-1).pitch, 0.9);
  }
});

test("velocidade e volume respeitam os limites configurados", () => {
  const scenarios = [
    { command: "fale mais rápido", stored: { rate: 1.49 }, key: "rate", expected: 1.5 },
    { command: "fale mais devagar", stored: { rate: 0.71 }, key: "rate", expected: 0.7 },
    { command: "fale mais alto", stored: { volume: 0.95 }, key: "volume", expected: 1 },
    { command: "fale mais baixo", stored: { volume: 0.21 }, key: "volume", expected: 0.2 },
  ];

  for (const scenario of scenarios) {
    const harness = createContentHarness({ storedPreferences: scenario.stored });
    const { recognition } = harness.activateAndListen();
    recognition.emitResult(scenario.command);
    recognition.emitEnd();

    assert.equal(harness.storage.jarvisPreferences[scenario.key], scenario.expected);
  }
});

test("confirmação só começa depois de persistir a preferência", () => {
  const harness = createContentHarness({ deferLocalSet: true });
  const { recognition } = harness.activateAndListen();
  const spokenBeforeCommand = harness.spoken.length;

  recognition.emitResult("modo denso");
  recognition.emitEnd();

  assert.equal(harness.spoken.length, spokenBeforeCommand);
  assert.equal(harness.storage.jarvisPreferences, undefined);
  harness.resolveNextLocalSet();
  assert.equal(harness.events.at(-2), "storage:set");
  assert.equal(harness.spoken.length, spokenBeforeCommand + 1);
  assert.equal(harness.spoken.at(-1).text, "Modo denso ativado.");
});

test("confirmação tardia de preferência não interfere após reativação", () => {
  const harness = createContentHarness({ deferLocalSet: true });
  const { recognition } = harness.activateAndListen();
  recognition.emitResult("modo denso");
  recognition.emitEnd();
  const spokenBeforeReactivation = harness.spoken.length;

  harness.activate(false);
  harness.resolveNextLocalSet();

  assert.equal(harness.spoken.length, spokenBeforeReactivation);
  assert.equal(harness.context.__accessibleWebAssistantState.status, "LISTENING");
  assert.equal(harness.FakeRecognition.instances.length, 2);
});

test("troca de voz percorre somente vozes pt-BR e pt com retorno ao início", () => {
  const voices = [
    { voiceURI: "pt-pt", lang: "pt-PT", default: false },
    { voiceURI: "br-1", lang: "pt-BR", default: false },
    { voiceURI: "en", lang: "en-US", default: true },
    { voiceURI: "br-2", lang: "pt-BR", default: false },
  ];
  const harness = createContentHarness({
    voices,
    storedPreferences: { voiceURI: "br-1" },
  });
  let { recognition } = harness.activateAndListen();

  for (const expectedVoiceURI of ["br-2", "pt-pt", "br-1"]) {
    recognition.emitResult("troque sua voz");
    recognition.emitEnd();
    assert.equal(harness.storage.jarvisPreferences.voiceURI, expectedVoiceURI);
    assert.equal(harness.spoken.at(-1).voice.voiceURI, expectedVoiceURI);
    harness.finishSpeech();
    recognition = harness.FakeRecognition.instances.at(-1);
  }
});

test("primeira troca de voz avança da voz efetiva para usuário novo", () => {
  const voices = [
    { voiceURI: "br-1", lang: "pt-BR", default: false },
    { voiceURI: "br-2", lang: "pt-BR", default: false },
  ];
  const harness = createContentHarness({ voices });
  const { recognition } = harness.activateAndListen();
  assert.equal(harness.spoken[0].voice.voiceURI, "br-1");

  recognition.emitResult("troque sua voz");
  recognition.emitEnd();

  assert.equal(harness.storage.jarvisPreferences.voiceURI, "br-2");
  assert.equal(harness.spoken.at(-1).voice.voiceURI, "br-2");
});

test("primeira troca de voz avança da voz efetiva quando salva foi removida", () => {
  const voices = [
    { voiceURI: "br-1", lang: "pt-BR", default: false },
    { voiceURI: "br-2", lang: "pt-BR", default: false },
  ];
  const harness = createContentHarness({
    voices,
    storedPreferences: { voiceURI: "voz-removida" },
  });
  const { recognition } = harness.activateAndListen();
  assert.equal(harness.spoken[0].voice.voiceURI, "br-1");

  recognition.emitResult("troque sua voz");
  recognition.emitEnd();

  assert.equal(harness.storage.jarvisPreferences.voiceURI, "br-2");
  assert.equal(harness.spoken.at(-1).voice.voiceURI, "br-2");
});

test("troca de voz sem candidata compatível mantém padrão com segurança", () => {
  const defaultVoice = { voiceURI: "default-en", lang: "en-US", default: true };
  const harness = createContentHarness({
    voices: [defaultVoice],
    storedPreferences: { voiceURI: "voz-removida" },
  });
  const { recognition } = harness.activateAndListen();

  recognition.emitResult("troque sua voz");
  recognition.emitEnd();

  assert.equal(harness.storage.jarvisPreferences.voiceURI, null);
  assert.equal(harness.spoken.at(-1).voice.voiceURI, "default-en");
});

test("ativação emite feedback sonoro curto", () => {
  const harness = createContentHarness();

  harness.activate();

  assert.equal(harness.audio.startCount, 1);
  assert.equal(harness.audio.stopCount, 1);
  assert.equal(harness.audio.closeCount, 1);
});

test("ativa modo dinâmico por comando local", () => {
  const harness = createContentHarness();
  const { recognition } = harness.activateAndListen();

  recognition.emitResult("por favor, modo dinâmico");
  assert.equal(recognition.stopCount, 1);
  recognition.emitEnd();

  assert.equal(harness.context.__accessibleWebAssistantState.mode, "dynamic");
  assert.equal(harness.context.__accessibleWebAssistantState.lastCommand, "por favor, modo dinâmico");
  assert.equal(harness.spoken.at(-1).text, "Modo dinâmico ativado.");
});

test("ativa modo denso por comando local", () => {
  const harness = createContentHarness();
  const { recognition } = harness.activateAndListen();

  recognition.emitResult("modo denso");
  recognition.emitEnd();

  assert.equal(harness.context.__accessibleWebAssistantState.mode, "dense");
  assert.equal(harness.spoken.at(-1).text, "Modo denso ativado.");
});

test("informa título e hostname para onde estou", () => {
  const harness = createContentHarness();
  const { recognition } = harness.activateAndListen();

  recognition.emitResult("onde estou?");
  recognition.emitEnd();

  assert.equal(
    harness.spoken.at(-1).text,
    "Você está em YouTube, no endereço youtube.com.",
  );
});

function runRecognizedCommand(harness, command) {
  const { recognition } = harness.activateAndListen();
  recognition.emitResult(command);
  recognition.emitEnd();
  return recognition;
}

function pageResponse(page, command, mode = "dynamic") {
  const h = createContentHarness({ page, storedPreferences: { mode } });
  runRecognizedCommand(h, command);
  const response = h.spoken.at(-1).text;
  h.finishSpeech();
  assert.equal(h.context.__accessibleWebAssistantState.status, "LISTENING");
  assert.equal(h.FakeRecognition.instances.length, 2);
  assert.deepEqual(h.overlaps, []);
  return response;
}

test("página resolve nomes na precedência acessível e ignora aria-labelledby quebrado", () => {
  const reference = pageElement("span", "Nome referenciado", { id: "nome" });
  const label = pageElement("label", "Rótulo associado");
  const cases = [
    [{ "aria-label": "Nome ARIA", "aria-labelledby": "nome", title: "Título inferior" }, "Nome ARIA"],
    [{ "aria-labelledby": "ausente nome" }, "Nome referenciado"],
    [{ "aria-labelledby": "ausente" }, "Texto visível"],
  ];
  for (const [attributes, expected] of cases) {
    const response = pageResponse(pageDocument([reference, pageElement("button", "Texto visível", attributes)]), "liste os botões");
    assert.match(response, new RegExp(expected));
    if (expected !== "Texto visível") assert.doesNotMatch(response, /Texto visível/);
    assert.doesNotMatch(response, /Título inferior/);
  }
  const field = pageElement("input", "", { alt: "Alternativo", title: "Título", placeholder: "Dica", value: "Valor" });
  field.labels = [label];
  assert.match(pageResponse(pageDocument([label, field]), "liste os campos"), /Rótulo associado/);
  label.style.display = "none";
  for (const [attribute, expected] of [["alt", "Alternativo"], ["title", "Título"], ["placeholder", "Dica"], ["value", "Valor"]]) {
    assert.match(pageResponse(pageDocument([label, field]), "liste os campos"), new RegExp(expected));
    if (attribute !== "value") delete field.attributes[attribute];
  }
});

test("página omite controles ocultos por estilo, geometria ou ancestral e nomes vazios", () => {
  const display = pageElement("button", "Oculto display");
  display.style.display = "none";
  const visibility = pageElement("button", "Oculto visibility");
  visibility.style.visibility = "hidden";
  const opacity = pageElement("button", "Oculto opacity");
  opacity.style.opacity = "0";
  const geometry = pageElement("button", "Oculto geometria");
  geometry.geometry = false;
  const parent = pageElement("div", "", {}, [pageElement("button", "Oculto ancestral")]);
  parent.style.display = "none";
  const page = pageDocument([display, visibility, opacity, geometry, parent, pageElement("button"), pageElement("button", "Visível")]);
  const response = pageResponse(page, "quais são os botões");
  assert.match(response, /Visível/);
  assert.doesNotMatch(response, /Oculto/);
  assert.match(response, /1 botão/);
});

test("página inclui filho com visibility visible sob ancestral visibility hidden", () => {
  const button = pageElement("button", "Reexibido");
  button.style.visibility = "visible";
  const parent = pageElement("div", "", {}, [button]);
  parent.style.visibility = "hidden";
  assert.match(pageResponse(pageDocument([parent]), "liste os botões"), /Reexibido/);
  assert.equal(pageResponse(pageDocument([parent]), "leia o conteúdo"), "Reexibido");
  parent.style.display = "none";
  assert.doesNotMatch(pageResponse(pageDocument([parent]), "liste os botões"), /Reexibido/);
  parent.style.display = "block";
  parent.style.opacity = "0";
  assert.doesNotMatch(pageResponse(pageDocument([parent]), "liste os botões"), /Reexibido/);
});

test("página lê somente texto visível do DOM conectado e separa parágrafos", () => {
  const hidden = pageElement("p", "Texto invisível");
  hidden.style.display = "none";
  const invisible = pageElement("span", "Também invisível");
  invisible.style.visibility = "hidden";
  const main = pageElement("main", "", {}, [
    pageElement("p", "Primeiro parágrafo"), hidden, invisible,
    pageElement("p", "Segundo parágrafo"),
  ]);
  const page = pageDocument([main]);
  for (const mode of ["dynamic", "dense"]) {
    assert.equal(pageResponse(page, "leia o conteúdo principal", mode), "Primeiro parágrafo Segundo parágrafo");
  }
  assert.equal(main.children.length, 4);
  assert.equal(hidden.style.display, "none");
});

test("página nunca lê valor de senha, nem usa value inseguro como nome", () => {
  const password = pageElement("input", "", { type: "password", "aria-label": "Senha" });
  Object.defineProperty(password, "value", { get() { throw new Error("valor de senha foi lido"); } });
  const unnamedPassword = pageElement("input", "", { type: "password", value: "segredo-digitado" });
  const checkbox = pageElement("input", "", { type: "checkbox", value: "on" });
  const page = pageDocument([password, unnamedPassword, checkbox]);
  const response = pageResponse(page, "quais são os campos");
  assert.match(response, /Senha.*password/);
  assert.doesNotMatch(response, /segredo-digitado|\bon\b/);
  assert.doesNotMatch(pageResponse(page, "descreva a página", "dense"), /segredo-digitado/);
});

test("página informa título e domínio nas perguntas de localização e título", () => {
  for (const command of ["onde estou", "qual o título da página", "qual é o título desta página"]) {
    const page = pageDocument();
    page.title = "Biblioteca Municipal";
    const response = pageResponse(page, command);
    assert.match(response, /Biblioteca Municipal/);
    assert.match(response, /youtube\.com/);
  }
});

test("página limita listas dinâmicas a 5 nomes e densas a 15, mantendo o total", () => {
  for (const [tag, command, attributes] of [["button", "liste botões", {}], ["a", "liste links", { href: "/" }], ["input", "liste campos", { type: "email" }]]) {
    const page = pageDocument(Array.from({ length: 17 }, (_, i) => pageElement(tag, tag === "input" ? "" : `Item-${i + 1}`, { ...attributes, "aria-label": `Item-${i + 1}` })));
    const dynamic = pageResponse(page, command);
    const dense = pageResponse(page, command, "dense");
    assert.match(dynamic, /17/);
    assert.match(dense, /17/);
    assert.equal((dynamic.match(/Item-\d+/g) || []).length, 5);
    assert.equal((dense.match(/Item-\d+/g) || []).length, 15);
    assert.doesNotMatch(dynamic, /Item-6\b/);
    assert.doesNotMatch(dense, /Item-16\b/);
    if (tag === "input") assert.match(dense, /email/);
  }
});

test("página responde explicitamente a listas e conteúdo vazios", () => {
  for (const command of ["liste os botões", "liste os links", "liste os campos", "leia o conteúdo principal"]) {
    assert.match(pageResponse(pageDocument(), command), /nenhum|não (?:há|encontrei)/i, command);
  }
});

test("página descreve fatos DOM por modo, com 8 títulos e 15 controles no denso", () => {
  const page = pageDocument([
    pageElement("main", "Conteúdo observável"),
    ...Array.from({ length: 10 }, (_, i) => pageElement(i ? "h2" : "h1", `Seção-${i + 1}`)),
    ...Array.from({ length: 17 }, (_, i) => pageElement("button", `Ação-${i + 1}`)),
    pageElement("a", "Contato", { href: "/contato" }),
    pageElement("input", "", { "aria-label": "Email" }),
  ]);
  const dynamic = pageResponse(page, "descreva a página");
  const dense = pageResponse(page, "descreva esta página", "dense");
  assert.match(dynamic, /YouTube/);
  assert.match(dynamic, /Seção-1\b/);
  assert.match(dynamic, /conteúdo principal/i);
  assert.match(dynamic, /17 botões/);
  assert.doesNotMatch(dynamic, /Seção-2\b/);
  assert.match(dense, /youtube\.com/);
  assert.equal((dense.match(/Seção-\d+/g) || []).length, 8);
  assert.equal((dense.match(/Ação-\d+/g) || []).length, 15);
  assert.match(dense, /1 link/);
  assert.match(dense, /1 campo/);
  assert.ok(dense.length > dynamic.length);
});

test("página escolhe main, article, role main e body nessa ordem e ignora regiões ocultas", () => {
  const hiddenMain = pageElement("main", "Região oculta");
  hiddenMain.style.display = "none";
  const main = pageElement("main", "Primeira região");
  const article = pageElement("article", "Segunda região");
  const role = pageElement("section", "Terceira região", { role: "main" });
  const children = [hiddenMain, role, article, main];
  assert.equal(pageResponse(pageDocument(children), "leia o conteúdo principal"), "Primeira região");
  children.pop();
  assert.equal(pageResponse(pageDocument(children), "leia o conteúdo"), "Segunda região");
  children.pop();
  assert.equal(pageResponse(pageDocument(children), "ler conteúdo principal"), "Terceira região");
  assert.equal(pageResponse(pageDocument([pageElement("p", "Texto do corpo")]), "leia o conteúdo"), "Texto do corpo");
});

test("página normaliza conteúdo, remove regiões excluídas sem alterar DOM e limita 700/2000", () => {
  const main = pageElement("main", " \n " + "a".repeat(2500), {},
    ["script", "style", "nav", "footer", "noscript"].map((tag) => pageElement(tag, `excluído-${tag}`)));
  const page = pageDocument([main]);
  assert.equal(pageResponse(page, "leia o conteúdo principal").length, 700);
  assert.equal(pageResponse(page, "leia o conteúdo principal", "dense").length, 2000);
  assert.equal(main.children.length, 5);
  const shortMain = pageElement("main", " Texto \n principal ", {},
    ["script", "style", "nav", "footer", "noscript"].map((tag) => pageElement(tag, `excluído-${tag}`)));
  assert.equal(pageResponse(pageDocument([shortMain]), "leia o conteúdo"), "Texto principal");
  assert.equal(shortMain.children.length, 5);
});

test("navegação rola 80% da janela e percorre histórico, retomando o ciclo comum", () => {
  const h = createContentHarness();
  for (const command of ["role para baixo", "desça", "role para cima", "suba", "volte", "voltar", "avance", "avançar"]) {
    runRecognizedCommand(h, command);
    assert.doesNotMatch(h.spoken.at(-1).text, /Ainda não/);
    h.finishSpeech();
    assert.equal(h.context.__accessibleWebAssistantState.status, "LISTENING");
  }
  assert.deepEqual(h.scrollCalls, [
    { top: 800, behavior: "smooth" }, { top: 800, behavior: "smooth" },
    { top: -800, behavior: "smooth" }, { top: -800, behavior: "smooth" },
  ]);
  assert.equal(h.history.backCount, 2);
  assert.equal(h.history.forwardCount, 2);
  assert.deepEqual(h.overlaps, []);
});

test("remove Jarvis somente no início, ignorando caixa e pontuação", () => {
  const harness = createContentHarness();

  runRecognizedCommand(harness, "JARVIS, quem é você?");

  assert.equal(
    harness.spoken.at(-1).text,
    "Sou Jarvis, um assistente de acessibilidade para ajudar você a navegar na web.",
  );
});

test("mantém Jarvis fora do início como parte do comando desconhecido", () => {
  const harness = createContentHarness();

  runRecognizedCommand(harness, "me chame de Jarvis");

  assert.equal(harness.spoken.at(-1).text, "Ainda não consigo executar esse comando.");
});

test("mantém o fallback para palavras que existem no protótipo do objeto", () => {
  const harness = createContentHarness();

  runRecognizedCommand(harness, "__proto__");

  assert.equal(harness.spoken.at(-1).text, "Ainda não consigo executar esse comando.");
});

test("responde a cumprimentos e ao estado funcional do assistente", () => {
  const expectedResponses = new Map([
    ["oi", "Olá! Como posso ajudar?"],
    ["olá", "Olá! Como posso ajudar?"],
    ["bom dia", "Bom dia! Como posso ajudar?"],
    ["boa tarde", "Boa tarde! Como posso ajudar?"],
    ["boa noite", "Boa noite! Como posso ajudar?"],
    ["tudo bem", "Tudo bem e pronto para ajudar."],
  ]);

  for (const [command, expected] of expectedResponses) {
    const harness = createContentHarness();
    runRecognizedCommand(harness, command);
    assert.equal(harness.spoken.at(-1).text, expected, command);
  }
});

test("explica de forma curta apenas os recursos já implementados", () => {
  for (const command of ["ajuda", "o que você faz", "o que você consegue fazer"]) {
    const harness = createContentHarness();
    runRecognizedCommand(harness, command);
    const response = harness.spoken.at(-1).text;
    for (const group of [/voz/, /modo/, /data e hora/, /página/, /botões/, /links/, /campos/, /conteúdo/, /rolar/, /voltar/, /avançar/, /repetição/, /sessão/]) {
      assert.match(response, group, command);
    }
    assert.match(response, /clima/);
    assert.doesNotMatch(response, /imagem/);
  }
});

test("informa a hora local em todas as variantes suportadas", () => {
  for (const command of ["que horas são", "qual é a hora", "qual a hora", "me diga a hora"]) {
    const harness = createContentHarness({ fixedNow: "2026-10-04T18:32:00" });
    runRecognizedCommand(harness, command);
    assert.match(harness.spoken.at(-1).text, /^Agora são 18 horas e 32 minutos\.$/, command);
  }
});

test("informa a data local em todas as variantes suportadas", () => {
  for (const command of ["que dia é hoje", "qual a data de hoje", "que data é hoje", "qual o dia de hoje"]) {
    const harness = createContentHarness({ fixedNow: "2026-10-04T18:32:00" });
    runRecognizedCommand(harness, command);
    assert.equal(harness.spoken.at(-1).text, "Hoje é domingo, 4 de outubro de 2026.", command);
  }
});

test("repita, pare e encerramento continuam disponíveis pelo roteador", () => {
  const harness = createContentHarness();
  runRecognizedCommand(harness, "Jarvis, quem é você");
  harness.finishSpeech();

  let recognition = harness.FakeRecognition.instances.at(-1);
  recognition.emitResult("Jarvis, repita!");
  recognition.emitEnd();
  assert.equal(
    harness.spoken.at(-1).text,
    "Sou Jarvis, um assistente de acessibilidade para ajudar você a navegar na web.",
  );
  harness.finishSpeech();

  recognition = harness.FakeRecognition.instances.at(-1);
  recognition.emitResult("Jarvis, pare!");
  recognition.emitEnd();
  assert.equal(harness.context.__accessibleWebAssistantState.status, "LISTENING");

  recognition = harness.FakeRecognition.instances.at(-1);
  recognition.emitResult("Jarvis: encerrar assistente");
  recognition.emitEnd();
  assert.equal(harness.spoken.at(-1).text, "Até mais.");
});

test("pare interrompe fala e mantém sessão disponível", () => {
  const harness = createContentHarness();
  const { recognition } = harness.activateAndListen();
  const cancelCount = harness.synth.cancelCount;

  recognition.emitResult("pare");
  recognition.emitEnd();

  assert.equal(harness.synth.cancelCount, cancelCount + 1);
  assert.equal(harness.context.__accessibleWebAssistantState.status, "LISTENING");
  assert.equal(harness.context.__accessibleWebAssistantState.isActive, true);
  assert.equal(harness.FakeRecognition.instances.length, 2);
});

test("encerra assistente e interrompe microfone", () => {
  const harness = createContentHarness();
  const { recognition } = harness.activateAndListen();

  recognition.emitResult("encerrar assistente");
  recognition.emitEnd();

  assert.equal(harness.context.__accessibleWebAssistantState.status, "SPEAKING");
  harness.finishSpeech();
  assert.equal(harness.context.__accessibleWebAssistantState.status, "INACTIVE");
  assert.equal(harness.context.__accessibleWebAssistantState.isActive, false);
  assert.equal(recognition.abortCount, 0);
  assert.equal(harness.spoken.at(-1).text, "Até mais.");
  recognition.emitEnd();
  assert.equal(harness.FakeRecognition.instances.length, 1);
});

test("mantém três comandos consecutivos na mesma ativação", () => {
  const harness = createContentHarness();
  const { recognition: firstRecognition } = harness.activateAndListen();

  const spokenAfterActivation = harness.spoken.length;
  firstRecognition.emitResult("onde estou");
  assert.equal(harness.spoken.length, spokenAfterActivation);
  assert.equal(harness.FakeRecognition.instances.length, 1);
  firstRecognition.emitEnd();
  assert.equal(
    harness.spoken.at(-1).text,
    "Você está em YouTube, no endereço youtube.com.",
  );
  assert.equal(harness.FakeRecognition.instances.length, 1);
  harness.finishSpeech();
  assert.equal(harness.FakeRecognition.instances.length, 2);

  const secondRecognition = harness.FakeRecognition.instances[1];
  secondRecognition.emitResult("modo denso");
  assert.equal(harness.FakeRecognition.instances.length, 2);
  secondRecognition.emitEnd();
  assert.equal(harness.spoken.at(-1).text, "Modo denso ativado.");
  harness.finishSpeech();
  assert.equal(harness.FakeRecognition.instances.length, 3);

  const thirdRecognition = harness.FakeRecognition.instances[2];
  thirdRecognition.emitResult("repita");
  thirdRecognition.emitEnd();
  assert.equal(harness.spoken.at(-1).text, "Modo denso ativado.");
  harness.finishSpeech();
  assert.equal(harness.FakeRecognition.instances.length, 4);
  assert.equal(harness.events.filter((event) => event === "earcon:PROCESSING").length, 3);
  assert.equal(harness.events.filter((event) => event === "earcon:LISTENING").length, 4);
  assert.deepEqual(harness.overlaps, []);
});

test("não reabre reconhecimento enquanto resposta está falando", () => {
  const harness = createContentHarness();
  const { recognition } = harness.activateAndListen();

  recognition.emitResult("onde estou");
  recognition.emitEnd();

  assert.equal(harness.context.__accessibleWebAssistantState.status, "SPEAKING");
  assert.equal(harness.FakeRecognition.instances.length, 1);
});

test("não cria reconhecimento duplicado antes do onend anterior", () => {
  const harness = createContentHarness();
  const { recognition } = harness.activateAndListen();
  const spokenCount = harness.spoken.length;

  recognition.emitResult("modo denso");

  assert.equal(harness.spoken.length, spokenCount);
  assert.equal(harness.FakeRecognition.instances.length, 1);
  recognition.emitEnd();
  assert.equal(harness.FakeRecognition.instances.length, 1);
  harness.finishSpeech();
  assert.equal(harness.FakeRecognition.instances.length, 2);
});

test("repete a última resposta sem substituir a memória", () => {
  const harness = createContentHarness();
  let interaction = harness.activateAndListen();
  interaction.recognition.emitResult("modo denso");
  interaction.recognition.emitEnd();
  harness.finishSpeech();

  interaction = harness.activateAndListen();
  interaction.recognition.emitResult("repita");
  interaction.recognition.emitEnd();

  assert.equal(harness.spoken.at(-1).text, "Modo denso ativado.");
  assert.equal(
    harness.context.__accessibleWebAssistantState.lastResponse,
    "Modo denso ativado.",
  );
});

test("responde sem fingir IA para comando desconhecido", () => {
  const harness = createContentHarness();
  const { recognition } = harness.activateAndListen();

  recognition.emitResult("compre uma passagem");
  recognition.emitEnd();

  assert.equal(
    harness.spoken.at(-1).text,
    "Ainda não consigo executar esse comando.",
  );
});

test("nova ativação cancela fala anterior imediatamente", () => {
  const harness = createContentHarness();
  harness.activate();
  const cancelCountAfterFirstActivation = harness.synth.cancelCount;

  harness.activate();

  assert.equal(harness.synth.cancelCount, cancelCountAfterFirstActivation + 1);
  assert.equal(harness.spoken.at(-1).text, "Olá, sou Jarvis, à sua disposição.");
});

test("fim tardio de fala cancelada não abre microfone antigo", () => {
  const harness = createContentHarness();
  harness.activate();
  harness.activate();

  harness.finishSpeech(0);

  assert.equal(harness.FakeRecognition.instances.length, 0);
  harness.finishSpeech(1);
  assert.equal(harness.FakeRecognition.instances.length, 1);
});

test("erro tardio de reconhecimento abortado não interfere na nova ativação", () => {
  const harness = createContentHarness();
  const { recognition } = harness.activateAndListen();
  harness.activate();
  const spokenCount = harness.spoken.length;

  recognition.emitError("aborted");

  assert.equal(harness.spoken.length, spokenCount);
});

test("nova ativação invalida fim tardio da resposta e reconhecimento antigos", () => {
  const harness = createContentHarness();
  const { recognition } = harness.activateAndListen();
  recognition.emitResult("onde estou");
  harness.activate();

  recognition.emitEnd();
  assert.equal(harness.FakeRecognition.instances.length, 1);
  assert.equal(harness.spoken.at(-1).text, "Olá, sou Jarvis, à sua disposição.");
  harness.finishSpeech();
  assert.equal(harness.FakeRecognition.instances.length, 2);
});

test("nova ativação ignora resultado tardio do reconhecimento antigo", () => {
  const harness = createContentHarness();
  const { recognition } = harness.activateAndListen();
  harness.activate();
  const spokenCount = harness.spoken.length;

  recognition.emitResult("modo denso");
  recognition.emitEnd();

  assert.equal(harness.context.__accessibleWebAssistantState.mode, "dynamic");
  assert.equal(harness.spoken.length, spokenCount);
});

test("erro aborted do reconhecimento atual não gera alerta falso", () => {
  const harness = createContentHarness();
  const { recognition } = harness.activateAndListen();
  const spokenCount = harness.spoken.length;

  recognition.emitError("aborted");
  recognition.emitEnd();

  assert.equal(harness.spoken.length, spokenCount);
  assert.equal(harness.FakeRecognition.instances.length, 1);
});

test("ausência de SpeechRecognition informa limitação sem erro fatal", () => {
  const harness = createContentHarness({ recognitionAvailable: false });

  assert.doesNotThrow(() => {
    harness.activate();
    harness.finishSpeech();
  });

  assert.equal(
    harness.spoken.at(-1).text,
    "O reconhecimento de voz não está disponível neste navegador.",
  );
  assert.equal(harness.context.__accessibleWebAssistantState.isActive, true);
});

test("falha do reconhecimento produz feedback por voz", () => {
  const harness = createContentHarness();
  const { recognition } = harness.activateAndListen();

  recognition.emitError();
  recognition.emitEnd();

  assert.equal(
    harness.spoken.at(-1).text,
    "Não foi possível reconhecer sua fala. Tente novamente.",
  );
});

test("falha recuperável volta a escutar após feedback", () => {
  const harness = createContentHarness();
  const { recognition } = harness.activateAndListen();
  const spokenCount = harness.spoken.length;

  recognition.emitError("no-speech");
  assert.equal(harness.spoken.length, spokenCount);
  recognition.emitEnd();
  assert.equal(harness.spoken.length, spokenCount + 1);
  assert.equal(harness.FakeRecognition.instances.length, 1);
  harness.finishSpeech();

  assert.equal(harness.FakeRecognition.instances.length, 2);
  assert.equal(harness.context.__accessibleWebAssistantState.status, "LISTENING");
});

test("timer encerra sessão e microfone após 30 segundos", () => {
  const harness = createContentHarness();
  const { recognition } = harness.activateAndListen();

  harness.runSessionTimer();

  assert.equal(harness.context.__accessibleWebAssistantState.status, "INACTIVE");
  assert.equal(harness.context.__accessibleWebAssistantState.isActive, false);
  assert.equal(recognition.abortCount, 1);
});

test("timeout invalida callbacks tardios sem reabrir microfone", () => {
  const harness = createContentHarness();
  const { recognition } = harness.activateAndListen();
  recognition.emitResult("onde estou");
  recognition.emitEnd();

  harness.runSessionTimer();
  harness.finishSpeech();

  assert.equal(harness.context.__accessibleWebAssistantState.status, "INACTIVE");
  assert.equal(harness.FakeRecognition.instances.length, 1);
});

test("Jarvis serializa ON, introdução, LISTENING, PROCESSING, resposta e OFF", () => {
  const h = createContentHarness({ autoAudio: false });
  h.activate();
  assert.deepEqual(h.events, ["earcon:ON"]);
  assert.equal(h.spoken.length, 0);
  h.finishAudio();
  assert.equal(h.spoken[0].text, "Olá, sou Jarvis, à sua disposição.");
  h.finishSpeech();
  assert.equal(h.events.at(-1), "earcon:LISTENING");
  assert.equal(h.FakeRecognition.instances.length, 0);
  h.finishAudio();
  const recognition = h.FakeRecognition.instances[0];
  recognition.emitResult("onde estou");
  assert.equal(h.events.at(-1), "recognition:start");
  recognition.emitEnd();
  assert.deepEqual(h.events.slice(-2), ["recognition:end", "earcon:PROCESSING"]);
  assert.equal(h.spoken.length, 1);
  h.finishAudio();
  assert.match(h.spoken.at(-1).text, /Você está em YouTube/);
  h.finishSpeech();
  h.finishAudio();
  const next = h.FakeRecognition.instances[1];
  next.emitResult("encerrar assistente");
  next.emitEnd();
  h.finishAudio();
  assert.equal(h.spoken.at(-1).text, "Até mais.");
  h.finishSpeech();
  assert.equal(h.events.at(-1), "earcon:OFF");
  assert.notEqual(h.context.__accessibleWebAssistantState.status, "INACTIVE");
  h.finishAudio();
  assert.equal(h.context.__accessibleWebAssistantState.status, "INACTIVE");
  assert.equal(h.FakeRecognition.instances.length, 2);
  assert.equal(h.audio.closeCount, h.oscillators.length);
  assert.deepEqual(h.overlaps, []);
});

test("introduce false passa de ON para LISTENING sem fala", () => {
  const h = createContentHarness({ autoAudio: false });
  h.activate(false);
  h.finishAudio();
  assert.equal(h.spoken.length, 0);
  assert.equal(h.events.at(-1), "earcon:LISTENING");
  h.finishAudio();
  assert.equal(h.FakeRecognition.instances.length, 1);
  assert.deepEqual(h.overlaps, []);
});

test("reativação aguarda onend do microfone abortado antes de ON", () => {
  const h = createContentHarness({ autoAbort: false });
  const { recognition } = h.activateAndListen();
  const audioCount = h.audio.startCount;
  h.activate(false);
  assert.equal(recognition.abortCount, 1);
  assert.equal(h.audio.startCount, audioCount);
  recognition.emitResult("modo denso");
  recognition.emitEnd();
  assert.equal(h.FakeRecognition.instances.length, 2);
  assert.equal(h.context.__accessibleWebAssistantState.mode, "dynamic");
  assert.deepEqual(h.overlaps, []);
});

for (const phase of ["ON", "LISTENING", "PROCESSING", "OFF"]) {
  test(`${phase === "OFF" ? "reativação" : "timeout"} invalida earcon ${phase} pendente`, () => {
    const h = createContentHarness({ autoAudio: false });
    h.activate(false);
    if (phase !== "ON") h.finishAudio();
    if (["PROCESSING", "OFF"].includes(phase)) {
      h.finishAudio();
      const recognition = h.FakeRecognition.instances[0];
      recognition.emitResult(phase === "OFF" ? "encerrar assistente" : "modo denso");
      recognition.emitEnd();
    }
    if (phase === "OFF") {
      // The command invalidates the session timer: use reactivation during OFF.
      h.finishAudio();
      h.finishSpeech();
      const oldAudio = h.oscillators.length - 1;
      h.activate(false);
      h.finishAudio(oldAudio);
      assert.equal(h.events.at(-1), "earcon:OFF:end");
      assert.equal(h.spoken.length, 1);
      assert.equal(h.FakeRecognition.instances.length, 1);
    } else {
      const count = h.FakeRecognition.instances.length;
      h.runSessionTimer();
      h.finishAudio();
      assert.equal(h.context.__accessibleWebAssistantState.status, "INACTIVE");
      assert.equal(h.FakeRecognition.instances.length, count);
      assert.equal(h.spoken.length, 0);
    }
    assert.deepEqual(h.overlaps, []);
  });
}

test("reativação invalida earcon antigo e timer antigo", () => {
  const h = createContentHarness({ autoAudio: false });
  h.activate();
  const oldTimer = [...h.timers.values()].find(({ delay }) => delay === 30_000).callback;
  h.activate(false);
  h.finishAudio(0);
  oldTimer();
  assert.equal(h.spoken.length, 0);
  assert.equal(h.context.__accessibleWebAssistantState.isActive, true);
  h.finishAudio(1);
  h.finishAudio(2);
  assert.equal(h.FakeRecognition.instances.length, 1);
  assert.deepEqual(h.overlaps, []);
});

test("ausência de Web Audio mantém ativação, comandos e encerramento", () => {
  const h = createContentHarness({ audioAvailable: false });
  const { recognition } = h.activateAndListen();
  recognition.emitResult("encerrar assistente");
  recognition.emitEnd();
  assert.equal(h.spoken.at(-1).text, "Até mais.");
  h.finishSpeech();
  assert.equal(h.context.__accessibleWebAssistantState.status, "INACTIVE");
  assert.deepEqual(h.overlaps, []);
});

test("Web Audio suspenso não bloqueia a introdução nem o microfone", () => {
  const h = createContentHarness({ audioState: "suspended", autoAudio: false });
  h.activate();
  assert.equal(h.spoken.length, 1);
  h.finishSpeech();
  assert.equal(h.FakeRecognition.instances.length, 1);
  assert.equal(h.audio.startCount, 0);
  assert.equal(h.audio.closeCount, 2);
  assert.deepEqual(h.overlaps, []);
});

test("no-speech aguarda onend e retoma LISTENING sem PROCESSING", () => {
  const h = createContentHarness({ autoAudio: false });
  h.activate(false);
  h.finishAudio();
  h.finishAudio();
  const recognition = h.FakeRecognition.instances[0];
  recognition.emitError("no-speech");
  assert.equal(h.spoken.length, 0);
  recognition.emitEnd();
  assert.equal(h.events.includes("earcon:PROCESSING"), false);
  assert.equal(h.spoken.length, 1);
  assert.match(h.spoken.at(-1).text, /Tente novamente/);
  assert.deepEqual(h.events.slice(-2), [
    "recognition:end",
    "speech:Não foi possível reconhecer sua fala. Tente novamente.",
  ]);
  h.finishSpeech();
  assert.equal(h.events.at(-1), "earcon:LISTENING");
  assert.equal(h.FakeRecognition.instances.length, 1);
  h.finishAudio();
  assert.equal(h.FakeRecognition.instances.length, 2);
  assert.equal(h.events.includes("earcon:PROCESSING"), false);
  assert.deepEqual(h.overlaps, []);
});

test("fim duplicado de earcon não duplica fala nem microfone", () => {
  const h = createContentHarness({ autoAudio: false });
  h.activate();
  h.finishAudio(0);
  h.finishAudio(0);
  assert.equal(h.spoken.length, 1);
  h.finishSpeech();
  h.finishAudio(1);
  h.finishAudio(1);
  assert.equal(h.FakeRecognition.instances.length, 1);
  assert.deepEqual(h.overlaps, []);
});
