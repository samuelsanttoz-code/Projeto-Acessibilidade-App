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

function createBackgroundHarness({ deferSessionGet = false } = {}) {
  let commandListener;
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
    runtime: {},
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

  loadScript("background.js", { chrome, console });

  return {
    sentMessages,
    sessionStorage,
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

function createContentHarness({ recognitionAvailable = true, audioAvailable = true, audioState = "running", autoAudio = true, autoAbort = true } = {}) {
  let messageListener;
  let nextTimerId = 1;
  const timers = new Map();
  const spoken = [];
  const storage = {};
  const events = [];
  const overlaps = [];
  const oscillators = [];
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
      onMessage: {
        addListener(listener) {
          messageListener = listener;
        },
      },
    },
    storage: {
      local: {
        get(key, callback) {
          callback({ [key]: storage[key] });
        },
        set(values, callback) {
          Object.assign(storage, values);
          callback?.();
        },
      },
    },
  };

  const context = {
    chrome,
    console,
    document: { title: "YouTube" },
    location: { hostname: "youtube.com" },
    speechSynthesis: synth,
    SpeechSynthesisUtterance: FakeUtterance,
    Date,
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
    timers,
    events,
    overlaps,
    oscillators,
    finishAudio,
    FakeRecognition,
    activate,
    activateAndListen,
    finishSpeech,
    runSessionTimer,
  };
}

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
