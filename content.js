(() => {
  const ACTIVATE_MESSAGE = "ACCESSIBLE_ASSISTANT_ACTIVATE";
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
  let speechSequence = 0;
  let speechInProgress = false;
  let earcon = null;
  let afterRecognitionStops = null;
  let isEnding = false;

  globalThis.__accessibleWebAssistantState = assistantState;

  function cancelSpeech() {
    speechSequence += 1;
    speechInProgress = false;
    globalThis.speechSynthesis?.cancel();
  }

  function stopRecognition(after = null) {
    const activeRecognition = recognition;
    afterRecognitionStops = after;

    if (!activeRecognition) {
      afterRecognitionStops = null;
      after?.();
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
    isEnding = false;
    cancelEarcon();
    stopRecognition();

    if (interruptSpeech) {
      cancelSpeech();
    }

    assistantState.status = STATUS.INACTIVE;
  }

  function scheduleSessionTimeout() {
    clearSessionTimer();
    const sequence = activationSequence;
    sessionTimer = setTimeout(() => {
      if (sequence !== activationSequence) return;
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
      speechInProgress = false;
      assistantState.status = assistantState.isActive
        ? STATUS.LISTENING
        : STATUS.INACTIVE;
      after?.();
      return;
    }

    const utterance = new Utterance(text);
    const sequence = ++speechSequence;
    const activation = activationSequence;
    utterance.lang = "pt-BR";
    speechInProgress = true;
    let finished = false;

    const finish = () => {
      if (finished || sequence !== speechSequence || activation !== activationSequence) {
        return;
      }
      finished = true;
      speechInProgress = false;
      assistantState.status = assistantState.isActive
        ? STATUS.LISTENING
        : STATUS.INACTIVE;
      after?.();
    };

    utterance.onstart = () => {
      if (sequence === speechSequence && activation === activationSequence) {
        assistantState.status = STATUS.SPEAKING;
      }
    };
    utterance.onend = finish;
    utterance.onerror = finish;
    synthesis.speak(utterance);
  }

  function cancelEarcon() {
    const activeEarcon = earcon;
    earcon = null;
    activeEarcon?.cancel();
  }

  function playEarcon(kind, sequence, after) {
    if (sequence !== activationSequence || recognition || speechInProgress || earcon) return;
    const AudioContext = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AudioContext) {
      after?.();
      return;
    }

    const tones = {
      ON: [660, 0.2],
      LISTENING: [880, 0.07],
      PROCESSING: [440, 0.09],
      OFF: [330, 0.18],
    };
    let audioContext;
    let oscillator;
    let finished = false;
    const close = () => {
      try { audioContext?.close()?.catch(() => {}); } catch {}
    };
    const currentEarcon = {
      cancel() {
        if (finished) return;
        finished = true;
        try { oscillator?.stop(); } catch {}
        close();
      },
    };
    const finish = () => {
      if (finished) return;
      finished = true;
      close();
      if (earcon !== currentEarcon) return;
      earcon = null;
      if (sequence === activationSequence) after?.();
    };
    earcon = currentEarcon;
    try {
      audioContext = new AudioContext();
      // Autoplay can suspend Web Audio without ever firing oscillator.onended.
      // Continue the interaction without a tone when playback is unavailable.
      if (audioContext.state === "suspended" || audioContext.state === "closed") {
        finish();
        return;
      }
      oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      const [frequency, duration] = tones[kind];
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.04, audioContext.currentTime);
      gain.gain.exponentialRampToValueAtTime(
        0.001,
        audioContext.currentTime + duration,
      );
      oscillator.connect(gain);
      gain.connect(audioContext.destination);
      oscillator.onended = finish;
      oscillator.start();
      oscillator.stop(audioContext.currentTime + duration);
    } catch (error) {
      console.warn("[Assistente Acessível] Feedback sonoro indisponível.", error);
      try { oscillator?.stop(); } catch {}
      finish();
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

  function canResumeListening(sequence) {
    return assistantState.isActive && !isEnding &&
      sequence === activationSequence && recognition === null &&
      !speechInProgress && earcon === null;
  }

  function resumeListening(sequence) {
    if (!canResumeListening(sequence)) return;
    assistantState.status = STATUS.LISTENING;
    playEarcon("LISTENING", sequence, () => {
      if (canResumeListening(sequence)) startListening(sequence);
    });
  }

  function processCommand(command, sequence) {
    if (!assistantState.isActive || sequence !== activationSequence) {
      return;
    }

    assistantState.status = STATUS.PROCESSING;
    assistantState.lastCommand = command;
    scheduleSessionTimeout();

    const normalizedCommand = normalizeCommand(command);
    const respond = (text, options = {}) => {
      speak(text, {
        ...options,
        after: () => resumeListening(sequence),
      });
    };

    if (normalizedCommand.includes("encerrar assistente")) {
      clearSessionTimer();
      isEnding = true;
      speak("Até mais.", {
        after: () => playEarcon("OFF", sequence, () => endSession()),
      });
      return;
    }

    if (normalizedCommand === "pare") {
      cancelSpeech();
      assistantState.status = STATUS.LISTENING;
      resumeListening(sequence);
      return;
    }

    if (normalizedCommand.includes("modo dinamico")) {
      assistantState.mode = "dynamic";
      respond("Modo dinâmico ativado.");
      return;
    }

    if (normalizedCommand.includes("modo denso")) {
      assistantState.mode = "dense";
      respond("Modo denso ativado.");
      return;
    }

    if (normalizedCommand.includes("onde estou")) {
      const pageName = document.title.trim() || location.hostname;
      respond(`Você está em ${pageName}, no endereço ${location.hostname}.`);
      return;
    }

    if (normalizedCommand === "repita") {
      const response = assistantState.lastResponse;
      if (response) {
        respond(response, { remember: false });
      } else {
        respond("Não há resposta anterior para repetir.");
      }
      return;
    }

    respond("Ainda não consigo executar esse comando.");
  }

  function startListening(sequence) {
    if (!canResumeListening(sequence)) return;

    const Recognition =
      globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
    if (!Recognition) {
      speak("O reconhecimento de voz não está disponível neste navegador.");
      return;
    }

    const currentRecognition = new Recognition();
    let pendingCommand = null;
    let pendingFeedback = null;
    let wasAborted = false;
    recognition = currentRecognition;
    currentRecognition.lang = "pt-BR";
    currentRecognition.continuous = false;
    currentRecognition.interimResults = false;

    currentRecognition.onstart = () => {
      if (
        assistantState.isActive &&
        sequence === activationSequence &&
        recognition === currentRecognition
      ) {
        assistantState.status = STATUS.LISTENING;
      }
    };

    currentRecognition.onresult = (event) => {
      const transcript = event.results?.[0]?.[0]?.transcript?.trim();
      if (
        !transcript ||
        !assistantState.isActive ||
        sequence !== activationSequence ||
        recognition !== currentRecognition
      ) {
        return;
      }

      pendingCommand = transcript;
      assistantState.status = STATUS.PROCESSING;

      try {
        currentRecognition.stop();
      } catch (error) {
        console.warn("[Assistente Acessível] Falha ao encerrar escuta.", error);
      }
    };

    currentRecognition.onerror = (event) => {
      if (
        !assistantState.isActive ||
        sequence !== activationSequence ||
        recognition !== currentRecognition ||
        wasAborted
      ) {
        return;
      }

      if (event.error === "aborted") {
        wasAborted = true;
        return;
      }

      pendingFeedback = "Não foi possível reconhecer sua fala. Tente novamente.";
      assistantState.status = STATUS.PROCESSING;
      scheduleSessionTimeout();
    };

    currentRecognition.onend = () => {
      if (recognition !== currentRecognition) {
        return;
      }

      recognition = null;
      const afterStop = afterRecognitionStops;
      afterRecognitionStops = null;
      if (afterStop) {
        afterStop();
        return;
      }
      if (
        !assistantState.isActive ||
        sequence !== activationSequence ||
        wasAborted
      ) {
        return;
      }

      if (pendingCommand) {
        playEarcon("PROCESSING", sequence, () => processCommand(pendingCommand, sequence));
        return;
      }

      if (pendingFeedback) {
        speak(pendingFeedback, { after: () => resumeListening(sequence) });
        return;
      }

      resumeListening(sequence);
    };

    try {
      currentRecognition.start();
    } catch (error) {
      recognition = null;
      console.warn("[Assistente Acessível] Falha ao iniciar microfone.", error);
      speak("Não foi possível iniciar o reconhecimento de voz.");
    }
  }

  function activateAssistant(introduce) {
    activationSequence += 1;
    const sequence = activationSequence;
    cancelSpeech();
    cancelEarcon();
    isEnding = false;
    assistantState.isActive = true;
    assistantState.status = STATUS.LISTENING;
    assistantState.lastActivatedAt = new Date().toISOString();
    scheduleSessionTimeout();
    stopRecognition(() => {
      if (!assistantState.isActive || sequence !== activationSequence) return;
      playEarcon("ON", sequence, () => {
        if (introduce) {
          speak("Olá, sou Jarvis, à sua disposição.", {
            remember: false,
            after: () => resumeListening(sequence),
          });
        } else {
          resumeListening(sequence);
        }
      });
    });
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== ACTIVATE_MESSAGE) {
      return false;
    }

    activateAssistant(message.introduce === true);
    sendResponse({ ok: true, status: assistantState.status });
    return false;
  });
})();
