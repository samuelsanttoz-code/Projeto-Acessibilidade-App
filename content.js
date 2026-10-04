(() => {
  const ACTIVATE_MESSAGE = "ACCESSIBLE_ASSISTANT_ACTIVATE";
  const SESSION_TIMEOUT_MS = 30_000;
  const PREFERENCES_KEY = "jarvisPreferences";
  const DEFAULT_PREFERENCES = {
    voiceURI: null,
    rate: 1.02,
    pitch: 0.9,
    volume: 1,
    mode: "dynamic",
  };
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
  const jarvisPreferences = { ...DEFAULT_PREFERENCES };

  let recognition = null;
  let sessionTimer = null;
  let activationSequence = 0;
  let speechSequence = 0;
  let speechInProgress = false;
  let earcon = null;
  let afterRecognitionStops = null;
  let isEnding = false;
  let preferencesLoaded = false;
  const afterPreferencesLoad = [];

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

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function validNumber(value, fallback) {
    return typeof value === "number" && Number.isFinite(value)
      ? value
      : fallback;
  }

  function loadPreferences() {
    chrome.storage.local.get(PREFERENCES_KEY, (saved) => {
      const stored = saved?.[PREFERENCES_KEY] || {};
      Object.assign(jarvisPreferences, {
        voiceURI: typeof stored.voiceURI === "string" && stored.voiceURI
          ? stored.voiceURI
          : null,
        rate: clamp(validNumber(stored.rate, DEFAULT_PREFERENCES.rate), 0.7, 1.5),
        pitch: DEFAULT_PREFERENCES.pitch,
        volume: clamp(validNumber(stored.volume, DEFAULT_PREFERENCES.volume), 0.2, 1),
        mode: ["dynamic", "dense"].includes(stored.mode)
          ? stored.mode
          : DEFAULT_PREFERENCES.mode,
      });
      assistantState.mode = jarvisPreferences.mode;
      preferencesLoaded = true;
      for (const callback of afterPreferencesLoad.splice(0)) callback();
    });
  }

  function savePreferences(after) {
    chrome.storage.local.set({
      [PREFERENCES_KEY]: {
        voiceURI: jarvisPreferences.voiceURI,
        rate: jarvisPreferences.rate,
        pitch: DEFAULT_PREFERENCES.pitch,
        volume: jarvisPreferences.volume,
        mode: jarvisPreferences.mode,
      },
    }, after);
  }

  function getVoices() {
    return globalThis.speechSynthesis?.getVoices?.() || [];
  }

  function getCompatibleVoices() {
    const voices = getVoices();
    const brazilianPortuguese = voices.filter(
      (voice) => voice.lang?.toLowerCase() === "pt-br",
    );
    const otherPortuguese = voices.filter((voice) => {
      const language = voice.lang?.toLowerCase();
      return language === "pt" || (language?.startsWith("pt-") && language !== "pt-br");
    });
    return [...brazilianPortuguese, ...otherPortuguese];
  }

  function selectVoice() {
    const voices = getVoices();
    const savedVoice = voices.find(
      (voice) => voice.voiceURI === jarvisPreferences.voiceURI,
    );
    if (savedVoice) return savedVoice;

    const compatibleVoice = getCompatibleVoices()[0];
    return compatibleVoice || voices.find((voice) => voice.default) || null;
  }

  function applySpeechPreferences(utterance) {
    utterance.lang = "pt-BR";
    utterance.rate = jarvisPreferences.rate;
    utterance.pitch = DEFAULT_PREFERENCES.pitch;
    utterance.volume = jarvisPreferences.volume;
    const voice = selectVoice();
    if (voice) utterance.voice = voice;
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
    applySpeechPreferences(utterance);
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
    const normalized = command
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return normalized.replace(/^jarvis(?:\s+|$)/, "").trim();
  }

  function roundPreference(value) {
    return Math.round(value * 100) / 100;
  }

  function handleSettingsCommand(command, sequence, respond) {
    const persistAndRespond = (text) => {
      savePreferences(() => {
        if (!assistantState.isActive || sequence !== activationSequence) return;
        respond(text);
      });
    };

    if (command.includes("fale mais rapido")) {
      jarvisPreferences.rate = clamp(
        roundPreference(jarvisPreferences.rate + 0.1),
        0.7,
        1.5,
      );
      persistAndRespond("Velocidade aumentada.");
      return true;
    }

    if (command.includes("fale mais devagar")) {
      jarvisPreferences.rate = clamp(
        roundPreference(jarvisPreferences.rate - 0.1),
        0.7,
        1.5,
      );
      persistAndRespond("Velocidade reduzida.");
      return true;
    }

    if (command.includes("velocidade normal")) {
      jarvisPreferences.rate = DEFAULT_PREFERENCES.rate;
      persistAndRespond("Velocidade normal.");
      return true;
    }

    if (command.includes("fale mais alto")) {
      jarvisPreferences.volume = clamp(
        roundPreference(jarvisPreferences.volume + 0.1),
        0.2,
        1,
      );
      persistAndRespond("Volume aumentado.");
      return true;
    }

    if (command.includes("fale mais baixo")) {
      jarvisPreferences.volume = clamp(
        roundPreference(jarvisPreferences.volume - 0.1),
        0.2,
        1,
      );
      persistAndRespond("Volume reduzido.");
      return true;
    }

    if (command.includes("troque sua voz")) {
      const voices = getCompatibleVoices();
      const currentVoice = selectVoice();
      const currentIndex = voices.findIndex(
        (voice) => voice.voiceURI === currentVoice?.voiceURI,
      );
      const nextVoice = voices.length
        ? voices[(currentIndex + 1) % voices.length]
        : null;
      jarvisPreferences.voiceURI = nextVoice?.voiceURI || null;
      persistAndRespond(nextVoice
        ? "Voz alterada."
        : "Nenhuma voz em português está disponível.");
      return true;
    }

    if (command.includes("modo dinamico")) {
      jarvisPreferences.mode = "dynamic";
      assistantState.mode = "dynamic";
      persistAndRespond("Modo dinâmico ativado.");
      return true;
    }

    if (command.includes("modo denso")) {
      jarvisPreferences.mode = "dense";
      assistantState.mode = "dense";
      persistAndRespond("Modo denso ativado.");
      return true;
    }

    return false;
  }

  function handleSessionCommand(command, sequence, respond) {
    if (command.includes("encerrar assistente")) {
      clearSessionTimer();
      isEnding = true;
      speak("Até mais.", {
        after: () => playEarcon("OFF", sequence, () => endSession()),
      });
      return true;
    }

    if (command === "pare") {
      cancelSpeech();
      assistantState.status = STATUS.LISTENING;
      resumeListening(sequence);
      return true;
    }

    if (command === "repita") {
      const response = assistantState.lastResponse;
      if (response) {
        respond(response, { remember: false });
      } else {
        respond("Não há resposta anterior para repetir.");
      }
      return true;
    }

    return false;
  }

  function handleAssistantCommand(command, respond) {
    const greetings = {
      oi: "Olá! Como posso ajudar?",
      ola: "Olá! Como posso ajudar?",
      "bom dia": "Bom dia! Como posso ajudar?",
      "boa tarde": "Boa tarde! Como posso ajudar?",
      "boa noite": "Boa noite! Como posso ajudar?",
    };
    const greeting = greetings[command];
    if (typeof greeting === "string") {
      respond(greeting);
      return true;
    }

    if (command === "tudo bem") {
      respond("Tudo bem e pronto para ajudar.");
      return true;
    }

    if (command === "quem e voce") {
      respond("Sou Jarvis, um assistente de acessibilidade para ajudar você a navegar na web.");
      return true;
    }

    if (["ajuda", "o que voce faz", "o que voce consegue fazer"].includes(command)) {
      respond("Posso ajudar com voz, modo, data e hora, descrever a página, listar botões, links e campos, ler conteúdo, rolar, voltar e avançar, repetição e controle da sessão.");
      return true;
    }

    return false;
  }

  function handleDateTimeCommand(command, respond) {
    const timeCommands = ["que horas sao", "qual e a hora", "qual a hora", "me diga a hora"];
    if (timeCommands.includes(command)) {
      const now = new Date();
      respond(`Agora são ${now.getHours()} horas e ${now.getMinutes()} minutos.`);
      return true;
    }

    const dateCommands = ["que dia e hoje", "qual a data de hoje", "que data e hoje", "qual o dia de hoje"];
    if (dateCommands.includes(command)) {
      const date = new Intl.DateTimeFormat("pt-BR", {
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
      }).format(new Date());
      respond(`Hoje é ${date}.`);
      return true;
    }

    return false;
  }

  function normalizePageText(text) {
    return (text || "").replace(/\s+/g, " ").trim();
  }

  function isElementVisible(element) {
    if (!element) return false;
    for (let current = element; current; current = current.parentElement) {
      const style = window.getComputedStyle(current);
      if (style.display === "none" || style.visibility === "hidden" ||
          style.visibility === "collapse" || style.opacity === "0") return false;
    }
    return Array.from(element.getClientRects()).some(
      (rect) => rect.width > 0 && rect.height > 0,
    );
  }

  function getAccessibleName(element) {
    const ariaLabel = normalizePageText(element.getAttribute("aria-label"));
    if (ariaLabel) return ariaLabel;
    const labelledBy = normalizePageText(element.getAttribute("aria-labelledby"));
    if (labelledBy) {
      const referencedText = normalizePageText(labelledBy.split(" ").map(
        (id) => document.getElementById(id)?.textContent || "",
      ).join(" "));
      if (referencedText) return referencedText;
    }
    const labelText = normalizePageText(Array.from(element.labels || [])
      .filter(isElementVisible).map((label) => label.innerText || "").join(" "));
    if (labelText) return labelText;
    const visibleText = normalizePageText(element.innerText);
    if (visibleText) return visibleText;
    for (const attribute of ["alt", "title", "placeholder"]) {
      const text = normalizePageText(element.getAttribute(attribute));
      if (text) return text;
    }
    // Never even access password values; unnamed toggles must not become "on".
    const safeInputTypes = ["text", "search", "email", "tel", "url", "number", "button", "submit", "reset"];
    if (element.tagName === "TEXTAREA" ||
        (element.tagName === "INPUT" && safeInputTypes.includes(element.type))) {
      return normalizePageText(element.value);
    }
    return "";
  }

  function collectPageContext() {
    const visibleElements = (selector) => Array.from(document.querySelectorAll(selector))
      .filter(isElementVisible);
    const namedElements = (selector) => visibleElements(selector).map((element) => ({
      name: getAccessibleName(element),
      type: element.type || element.getAttribute("role") || element.tagName.toLowerCase(),
    })).filter((element) => element.name);
    const main = visibleElements("main")[0] || visibleElements("article")[0] ||
      visibleElements('[role="main"]')[0] || null;
    return {
      title: normalizePageText(document.title) || location.hostname,
      domain: location.hostname,
      headings: namedElements('h1, h2, h3, h4, h5, h6, [role="heading"]'),
      buttons: namedElements('button, [role="button"], input[type="button"], input[type="submit"], input[type="reset"]'),
      links: namedElements('a[href], [role="link"]'),
      fields: namedElements('input, select, textarea').filter((field) =>
        !["button", "submit", "reset", "hidden", "image"].includes(field.type)),
      main,
    };
  }

  function describePage(context, mode) {
    const count = (items, singular, plural) => `${items.length} ${items.length === 1 ? singular : plural}`;
    const counts = [count(context.buttons, "botão", "botões"),
      count(context.links, "link", "links"), count(context.fields, "campo", "campos")].join(", ");
    const parts = [`Página: ${context.title}.`];
    if (mode === "dense") parts.push(`Domínio: ${context.domain}.`);
    const headings = context.headings.slice(0, mode === "dense" ? 8 : 1);
    if (headings.length) parts.push(`Títulos: ${headings.map((heading) => heading.name).join("; ")}.`);
    parts.push(context.main ? "Há conteúdo principal identificado." : "Nenhuma região de conteúdo principal identificada.");
    parts.push(`${counts}.`);
    if (mode === "dense") {
      const controls = [...context.buttons, ...context.links, ...context.fields].slice(0, 15);
      if (controls.length) parts.push(`Controles: ${controls.map((control) => control.name).join("; ")}.`);
    }
    return parts.join(" ");
  }

  function listNamedElements(kind, mode) {
    const elements = collectPageContext()[kind];
    const labels = { buttons: ["botão", "botões"], links: ["link", "links"], fields: ["campo", "campos"] };
    const [singular, plural] = labels[kind];
    if (!elements.length) return `Não encontrei nenhum ${singular} visível com nome.`;
    const names = elements.slice(0, mode === "dense" ? 15 : 5).map(
      (element) => kind === "fields" ? `${element.name} (${element.type})` : element.name,
    );
    return `${elements.length} ${elements.length === 1 ? singular : plural} com nome: ${names.join("; ")}.`;
  }

  function readMainContent(mode) {
    const source = collectPageContext().main || document.body;
    if (!source) return "Não encontrei conteúdo principal para ler.";
    const content = source.cloneNode ? source.cloneNode(true) : source;
    if (content !== source) {
      for (const element of content.querySelectorAll("script, style, nav, footer, noscript")) element.remove();
    }
    const text = normalizePageText(content.innerText || content.textContent);
    return text ? text.slice(0, mode === "dense" ? 2000 : 700) : "Não encontrei conteúdo principal para ler.";
  }

  function handlePageCommand(command, respond) {
    if (command.includes("onde estou") ||
        /^(qual (?:e )?o titulo (?:da|desta) pagina|titulo da pagina)$/.test(command)) {
      const pageName = normalizePageText(document.title) || location.hostname;
      respond(`Você está em ${pageName}, no endereço ${location.hostname}.`);
      return true;
    }
    if (/^(descreva (?:a|esta) pagina|descrever (?:a )?pagina|o que ha (?:na|nesta) pagina)$/.test(command)) {
      respond(describePage(collectPageContext(), assistantState.mode));
      return true;
    }
    const list = command.match(/^(?:liste|listar|quais(?: sao)?)(?: os)? (botoes|links|campos)(?: (?:da pagina|de formulario))?$/);
    if (list) {
      const kind = { botoes: "buttons", links: "links", campos: "fields" }[list[1]];
      respond(listNamedElements(kind, assistantState.mode));
      return true;
    }
    if (/^(leia|ler) (?:o )?conteudo(?: principal| da pagina)?$/.test(command)) {
      respond(readMainContent(assistantState.mode));
      return true;
    }
    return false;
  }

  function handleNavigationCommand(command, respond) {
    if (["role para baixo", "role baixo", "desca"].includes(command)) {
      window.scrollBy({ top: window.innerHeight * 0.8, behavior: "smooth" });
      respond("Rolando para baixo.");
      return true;
    }
    if (["role para cima", "role cima", "suba"].includes(command)) {
      window.scrollBy({ top: window.innerHeight * -0.8, behavior: "smooth" });
      respond("Rolando para cima.");
      return true;
    }
    if (["volte", "voltar"].includes(command)) {
      history.back();
      respond("Voltando.");
      return true;
    }
    if (["avance", "avancar"].includes(command)) {
      history.forward();
      respond("Avançando.");
      return true;
    }
    return false;
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
      if (!assistantState.isActive || sequence !== activationSequence) return;
      speak(text, {
        ...options,
        after: () => resumeListening(sequence),
      });
    };

    if (handleSessionCommand(normalizedCommand, sequence, respond)) return;
    if (handleSettingsCommand(normalizedCommand, sequence, respond)) return;

    if (handleAssistantCommand(normalizedCommand, respond)) return;

    if (handleDateTimeCommand(normalizedCommand, respond)) return;

    if (handlePageCommand(normalizedCommand, respond)) return;
    if (handleNavigationCommand(normalizedCommand, respond)) return;

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

  loadPreferences();

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== ACTIVATE_MESSAGE) {
      return false;
    }

    const activate = () => {
      activateAssistant(message.introduce === true);
      sendResponse({ ok: true, status: assistantState.status });
    };
    if (!preferencesLoaded) {
      afterPreferencesLoad.push(activate);
      return true;
    }
    activate();
    return false;
  });
})();
