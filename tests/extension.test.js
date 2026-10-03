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

function createContentHarness({ recognitionAvailable = true } = {}) {
  let messageListener;
  let nextTimerId = 1;
  const timers = new Map();
  const spoken = [];
  const storage = {};
  const audio = { startCount: 0, stopCount: 0, closeCount: 0 };
  const synth = {
    cancelCount: 0,
    cancel() {
      this.cancelCount += 1;
    },
    speak(utterance) {
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
      this.abortCount = 0;
      FakeRecognition.instances.push(this);
    }

    start() {
      this.startCount += 1;
      this.onstart?.();
    }

    abort() {
      this.abortCount += 1;
      this.onend?.();
    }

    emitResult(transcript) {
      this.onresult?.({ results: [[{ transcript }]] });
    }

    emitError(error = "no-speech") {
      this.onerror?.({ error });
    }
  }

  class FakeAudioContext {
    constructor() {
      this.currentTime = 0;
      this.destination = {};
    }

    close() {
      audio.closeCount += 1;
    }

    createOscillator() {
      return {
        frequency: { value: 0 },
        connect() {},
        start() {
          audio.startCount += 1;
        },
        stop() {
          audio.stopCount += 1;
          this.onended?.();
        },
      };
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
    AudioContext: FakeAudioContext,
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
  if (recognitionAvailable) {
    context.SpeechRecognition = FakeRecognition;
  }

  loadScript("content.js", context);

  function activate() {
    let response;
    messageListener(
      { type: "ACCESSIBLE_ASSISTANT_ACTIVATE" },
      {},
      (value) => {
        response = value;
      },
    );
    return response;
  }

  function finishSpeech(index = spoken.length - 1) {
    spoken[index].onend?.();
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
  let commandListener;
  const sentMessages = [];
  const chrome = {
    commands: {
      onCommand: {
        addListener(listener) {
          commandListener = listener;
        },
      },
    },
    runtime: {},
    tabs: {
      query(queryInfo, callback) {
        assert.equal(queryInfo.active, true);
        assert.equal(queryInfo.currentWindow, true);
        callback([{ id: 42 }]);
      },
      sendMessage(tabId, message, callback) {
        sentMessages.push({ tabId, message });
        callback();
      },
    },
  };

  loadScript("background.js", { chrome, console });
  commandListener("activate-assistant");

  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].tabId, 42);
  assert.equal(sentMessages[0].message.type, "ACCESSIBLE_ASSISTANT_ACTIVATE");
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
  assert.match(harness.spoken[0].text, /Assistente de acessibilidade ativado/);
  assert.equal(harness.storage.accessibleAssistantOnboardingShown, true);
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

  assert.equal(harness.context.__accessibleWebAssistantState.mode, "dynamic");
  assert.equal(harness.context.__accessibleWebAssistantState.lastCommand, "por favor, modo dinâmico");
  assert.equal(harness.spoken.at(-1).text, "Modo dinâmico ativado.");
});

test("ativa modo denso por comando local", () => {
  const harness = createContentHarness();
  const { recognition } = harness.activateAndListen();

  recognition.emitResult("modo denso");

  assert.equal(harness.context.__accessibleWebAssistantState.mode, "dense");
  assert.equal(harness.spoken.at(-1).text, "Modo denso ativado.");
});

test("informa título e hostname para onde estou", () => {
  const harness = createContentHarness();
  const { recognition } = harness.activateAndListen();

  recognition.emitResult("onde estou?");

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

  assert.equal(harness.synth.cancelCount, cancelCount + 1);
  assert.equal(harness.context.__accessibleWebAssistantState.status, "LISTENING");
  assert.equal(harness.context.__accessibleWebAssistantState.isActive, true);
});

test("encerra assistente e interrompe microfone", () => {
  const harness = createContentHarness();
  const { recognition } = harness.activateAndListen();

  recognition.emitResult("encerrar assistente");

  assert.equal(harness.context.__accessibleWebAssistantState.status, "SPEAKING");
  harness.finishSpeech();
  assert.equal(harness.context.__accessibleWebAssistantState.status, "INACTIVE");
  assert.equal(harness.context.__accessibleWebAssistantState.isActive, false);
  assert.equal(recognition.abortCount, 1);
  assert.equal(harness.spoken.at(-1).text, "Assistente encerrado.");
});

test("repete a última resposta sem substituir a memória", () => {
  const harness = createContentHarness();
  let interaction = harness.activateAndListen();
  interaction.recognition.emitResult("modo denso");
  harness.finishSpeech();

  interaction = harness.activateAndListen();
  interaction.recognition.emitResult("repita");

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
  assert.equal(harness.spoken.at(-1).text, "Estou ouvindo.");
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

test("erro aborted do reconhecimento atual não gera alerta falso", () => {
  const harness = createContentHarness();
  const { recognition } = harness.activateAndListen();
  const spokenCount = harness.spoken.length;

  recognition.emitError("aborted");

  assert.equal(harness.spoken.length, spokenCount);
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

  assert.equal(
    harness.spoken.at(-1).text,
    "Não foi possível reconhecer sua fala. Tente novamente.",
  );
});

test("timer encerra sessão e microfone após 30 segundos", () => {
  const harness = createContentHarness();
  const { recognition } = harness.activateAndListen();

  harness.runSessionTimer();

  assert.equal(harness.context.__accessibleWebAssistantState.status, "INACTIVE");
  assert.equal(harness.context.__accessibleWebAssistantState.isActive, false);
  assert.equal(recognition.abortCount, 1);
});
