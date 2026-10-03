(() => {
  const ACTIVATE_MESSAGE = "ACCESSIBLE_ASSISTANT_ACTIVATE";
  const ONBOARDING_KEY = "accessibleAssistantOnboardingShown";
  const SESSION_TIMEOUT_MS = 30_000;
  const STATUS = {
    INACTIVE: "INACTIVE",
    LISTENING: "LISTENING",
    PROCESSING: "PROCESSING",
    SPEAKING: "SPEAKING",
  };

  const assistantState = {
    status: STATUS.INACTIVE,
    isActive: false,
    mode: "dynamic",
    lastResponse: null,
    lastCommand: null,
    lastActivatedAt: null,
  };

  let recognition = null;
  let sessionTimer = null;
  let activationSequence = 0;

  globalThis.__accessibleWebAssistantState = assistantState;

  function cancelSpeech() {
    globalThis.speechSynthesis?.cancel();
  }

  function stopRecognition() {
    const activeRecognition = recognition;
    recognition = null;

    if (!activeRecognition) {
      return;
    }

    try {
      activeRecognition.abort();
    } catch (error) {
      console.warn("[Assistente Acessível] Falha ao encerrar microfone.", error);
    }
  }

  function clearSessionTimer() {
    if (sessionTimer !== null) {
      clearTimeout(sessionTimer);
      sessionTimer = null;
    }
  }

  function endSession({ interruptSpeech = false } = {}) {
    activationSequence += 1;
    clearSessionTimer();
    assistantState.isActive = false;
    stopRecognition();

    if (interruptSpeech) {
      cancelSpeech();
    }

    assistantState.status = STATUS.INACTIVE;
  }

  function scheduleSessionTimeout() {
    clearSessionTimer();
    sessionTimer = setTimeout(() => {
      endSession({ interruptSpeech: true });
    }, SESSION_TIMEOUT_MS);
  }

  function speak(text, { remember = true, after = null } = {}) {
    if (remember) {
      assistantState.lastResponse = text;
    }

    const Utterance = globalThis.SpeechSynthesisUtterance;
    const synthesis = globalThis.speechSynthesis;
    if (!Utterance || !synthesis) {
      assistantState.status = assistantState.isActive
        ? STATUS.LISTENING
        : STATUS.INACTIVE;
      after?.();
      return;
    }

    const utterance = new Utterance(text);
    utterance.lang = "pt-BR";
    let finished = false;

    const finish = () => {
      if (finished) {
        return;
      }
      finished = true;
      assistantState.status = assistantState.isActive
        ? STATUS.LISTENING
        : STATUS.INACTIVE;
      after?.();
    };

    utterance.onstart = () => {
      assistantState.status = STATUS.SPEAKING;
    };
    utterance.onend = finish;
    utterance.onerror = finish;
    synthesis.speak(utterance);
  }

  function playActivationTone() {
    const AudioContext = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AudioContext) {
      return;
    }

    try {
      const audioContext = new AudioContext();
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      oscillator.frequency.value = 660;
      gain.gain.setValueAtTime(0.08, audioContext.currentTime);
      gain.gain.exponentialRampToValueAtTime(
        0.001,
        audioContext.currentTime + 0.08,
      );
      oscillator.connect(gain);
      gain.connect(audioContext.destination);
      oscillator.onended = () => {
        audioContext.close()?.catch(() => {});
      };
      oscillator.start();
      oscillator.stop(audioContext.currentTime + 0.08);
    } catch (error) {
      console.warn("[Assistente Acessível] Feedback sonoro indisponível.", error);
    }
  }

  function normalizeCommand(command) {
    return command
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function processCommand(command) {
    assistantState.status = STATUS.PROCESSING;
    assistantState.lastCommand = command;
    scheduleSessionTimeout();

    const normalizedCommand = normalizeCommand(command);

    if (normalizedCommand.includes("encerrar assistente")) {
      clearSessionTimer();
      assistantState.isActive = false;
      stopRecognition();
      speak("Assistente encerrado.");
      return;
    }

    if (normalizedCommand === "pare") {
      cancelSpeech();
      assistantState.status = STATUS.LISTENING;
      return;
    }

    if (normalizedCommand.includes("modo dinamico")) {
      assistantState.mode = "dynamic";
      speak("Modo dinâmico ativado.");
      return;
    }

    if (normalizedCommand.includes("modo denso")) {
      assistantState.mode = "dense";
      speak("Modo denso ativado.");
      return;
    }

    if (normalizedCommand.includes("onde estou")) {
      const pageName = document.title.trim() || location.hostname;
      speak(`Você está em ${pageName}, no endereço ${location.hostname}.`);
      return;
    }

    if (normalizedCommand === "repita") {
      const response = assistantState.lastResponse;
      if (response) {
        speak(response, { remember: false });
      } else {
        speak("Não há resposta anterior para repetir.");
      }
      return;
    }

    speak("Ainda não consigo executar esse comando.");
  }

  function startListening() {
    if (!assistantState.isActive) {
      return;
    }

    const Recognition =
      globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
    if (!Recognition) {
      speak("O reconhecimento de voz não está disponível neste navegador.");
      return;
    }

    const currentRecognition = new Recognition();
    recognition = currentRecognition;
    currentRecognition.lang = "pt-BR";
    currentRecognition.continuous = false;
    currentRecognition.interimResults = false;

    currentRecognition.onstart = () => {
      if (assistantState.isActive) {
        assistantState.status = STATUS.LISTENING;
      }
    };

    currentRecognition.onresult = (event) => {
      const transcript = event.results?.[0]?.[0]?.transcript?.trim();
      if (!transcript || !assistantState.isActive) {
        return;
      }
      processCommand(transcript);
    };

    currentRecognition.onerror = (event) => {
      if (
        !assistantState.isActive ||
        recognition !== currentRecognition ||
        event.error === "aborted"
      ) {
        return;
      }

      speak("Não foi possível reconhecer sua fala. Tente novamente.");
      scheduleSessionTimeout();
    };

    currentRecognition.onend = () => {
      if (recognition === currentRecognition) {
        recognition = null;
      }
    };

    try {
      currentRecognition.start();
    } catch (error) {
      recognition = null;
      console.warn("[Assistente Acessível] Falha ao iniciar microfone.", error);
      speak("Não foi possível iniciar o reconhecimento de voz.");
    }
  }

  function announceActivation(sequence) {
    const onboardingMessage =
      "Assistente de acessibilidade ativado. Você pode pedir para descrever a página, perguntar onde está ou alterar o modo de leitura. Estou ouvindo.";
    const startCurrentListening = () => {
      if (assistantState.isActive && sequence === activationSequence) {
        startListening();
      }
    };

    chrome.storage.local.get(ONBOARDING_KEY, (result) => {
      if (!assistantState.isActive || sequence !== activationSequence) {
        return;
      }

      if (result?.[ONBOARDING_KEY]) {
        speak("Estou ouvindo.", {
          remember: false,
          after: startCurrentListening,
        });
        return;
      }

      chrome.storage.local.set({ [ONBOARDING_KEY]: true });
      speak(onboardingMessage, {
        remember: false,
        after: startCurrentListening,
      });
    });
  }

  function activateAssistant() {
    activationSequence += 1;
    const sequence = activationSequence;
    cancelSpeech();
    stopRecognition();
    assistantState.isActive = true;
    assistantState.status = STATUS.LISTENING;
    assistantState.lastActivatedAt = new Date().toISOString();
    playActivationTone();
    scheduleSessionTimeout();
    announceActivation(sequence);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== ACTIVATE_MESSAGE) {
      return false;
    }

    activateAssistant();
    sendResponse({ ok: true, status: assistantState.status });
    return false;
  });
})();
