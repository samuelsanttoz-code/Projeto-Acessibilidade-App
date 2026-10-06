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
    pendingIntent: null,
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
    assistantState.pendingIntent = null;
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
      const start = audioContext.currentTime;
      oscillator.frequency.setValueAtTime(frequency, start);
      gain.gain.setValueAtTime(0.04, start);
      if (kind === "ON") {
        // A short pulse precedes the brighter rising tone.
        gain.gain.exponentialRampToValueAtTime(0.001, start + 0.045);
        gain.gain.setValueAtTime(0.001, start + 0.055);
        gain.gain.exponentialRampToValueAtTime(0.04, start + 0.065);
        oscillator.frequency.setValueAtTime(740, start + 0.055);
        oscillator.frequency.exponentialRampToValueAtTime(1040, start + duration);
      } else if (kind === "OFF") {
        oscillator.frequency.exponentialRampToValueAtTime(180, start + duration);
      }
      gain.gain.exponentialRampToValueAtTime(
        0.001,
        start + duration,
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
      .replace(/_/g, " ")
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
      assistantState.pendingIntent = null;
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
      respond("Posso ajudar com voz, modo, data e hora, clima por cidade, descrever a página, listar botões, links e campos, ler conteúdo, rolar, voltar e avançar, repetição e controle da sessão.");
      return true;
    }

    return false;
  }

  function handleDateTimeCommand(command, respond) {
    const timeCommands = ["que horas sao", "qual e a hora", "qual a hora", "me diga a hora"];
    if (timeCommands.includes(command)) {
      const now = new Date();
      const hours = now.getHours();
      const minutes = now.getMinutes();
      respond(`${hours === 1 ? "É" : "Agora são"} ${hours} ${hours === 1 ? "hora" : "horas"} e ${minutes} ${minutes === 1 ? "minuto" : "minutos"}.`);
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

  function describeWeather(data) {
    const conditions = {
      0: "Céu limpo", 1: "Predominantemente limpo", 2: "Parcialmente nublado", 3: "Nublado",
      45: "Nevoeiro", 48: "Nevoeiro com geada",
      51: "Garoa leve", 53: "Garoa moderada", 55: "Garoa intensa",
      56: "Garoa congelante leve", 57: "Garoa congelante intensa",
      61: "Chuva leve", 63: "Chuva moderada", 65: "Chuva forte",
      66: "Chuva congelante leve", 67: "Chuva congelante forte",
      71: "Neve leve", 73: "Neve moderada", 75: "Neve forte", 77: "Grãos de neve",
      80: "Pancadas de chuva leves", 81: "Pancadas de chuva moderadas", 82: "Pancadas de chuva fortes",
      85: "Pancadas de neve leves", 86: "Pancadas de neve fortes",
      95: "Trovoadas", 96: "Trovoadas com granizo leve", 99: "Trovoadas com granizo forte",
    };
    const parts = [`Em ${data.city}.`];
    if (Number.isFinite(data.weatherCode) && conditions[data.weatherCode]) {
      parts.push(`${conditions[data.weatherCode]}.`);
    }
    for (const [key, label, unit] of [
      ["temperature", "Temperatura", "graus"],
      ["apparentTemperature", "Sensação", "graus"],
      ["windSpeed", "Vento", "quilômetros por hora"],
      ["maximum", "Máxima", "graus"], ["minimum", "Mínima", "graus"],
    ]) {
      if (Number.isFinite(data[key])) parts.push(`${label} de ${Math.round(data[key])} ${unit}.`);
    }
    return parts.join(" ");
  }

  function requestWeather(city, sequence) {
    assistantState.status = STATUS.PROCESSING;
    let finished = false;
    const finish = (result) => {
      const runtimeError = chrome.runtime.lastError;
      if (finished || !assistantState.isActive || isEnding || sequence !== activationSequence) return;
      finished = true;
      const text = !runtimeError && result?.ok === true
        ? describeWeather(result)
        : !runtimeError && result?.reason === "city-not-found"
          ? "Não encontrei essa cidade."
          : "Não consegui consultar o clima agora.";
      speak(text, { after: () => resumeListening(sequence) });
    };
    try {
      chrome.runtime.sendMessage({ type: "JARVIS_WEATHER_REQUEST", city }, finish);
    } catch {
      finish();
    }
  }

  function handleWeatherCommand(command, original, sequence, respond) {
    if (!/\b(?:tempo|clima|previsao)\b/.test(command)) return false;
    const direct = original.match(/\b(?:tempo|clima|previs[aã]o(?:\s+do\s+tempo)?)\s+em\s+(.+)/i);
    const city = direct?.[1].replace(/[?!.,;:]+$/g, "").trim();
    if (city) requestWeather(city, sequence);
    else {
      assistantState.pendingIntent = "weatherCity";
      respond("De qual cidade?");
    }
    return true;
  }

  function normalizePageText(text) {
    return (text || "").replace(/\s+/g, " ").trim();
  }

  function isElementVisible(element) {
    if (!element) return false;
    const visibility = window.getComputedStyle(element).visibility;
    if (visibility === "hidden" || visibility === "collapse") return false;
    for (let current = element; current; current = current.parentElement) {
      const style = window.getComputedStyle(current);
      if (style.display === "none" || style.opacity === "0") return false;
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
    const parts = [];
    const readNode = (node) => {
      if (node.nodeType === 3) {
        if (isElementVisible(node.parentElement)) parts.push(node.textContent);
        return;
      }
      if (node.nodeType !== 1 || ["SCRIPT", "STYLE", "NAV", "FOOTER", "NOSCRIPT"].includes(node.tagName)) return;
      const style = window.getComputedStyle(node);
      if (style.display === "none" || style.opacity === "0") return;
      const separate = node.tagName === "BR" ||
        !["inline", "contents", "inline-block", "inline-flex", "inline-grid", "inline-table", "ruby"].includes(style.display);
      if (separate) parts.push(" ");
      // Read the connected tree: a detached clone loses rendered text semantics.
      // Hidden parents may contain children that restore visibility: visible.
      for (const child of node.childNodes) readNode(child);
      if (separate) parts.push(" ");
    };
    readNode(source);
    const text = normalizePageText(parts.join(""));
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

  function performSilentAction(action, sequence) {
    if (!assistantState.isActive || sequence !== activationSequence) return;
    try {
      action();
    } catch (error) {
      console.warn("[Assistente Acessível] Falha ao executar ação.", error);
    }
    scheduleSessionTimeout();
    setTimeout(() => {
      if (assistantState.isActive && sequence === activationSequence) {
        resumeListening(sequence);
      }
    }, 0);
  }

  function handleNavigationCommand(command, sequence) {
    const down = ["role para baixo", "role baixo", "desca", "scroll down",
      "descer para baixo", "descer pra baixo", "descer", "desce", "pra baixo",
      "para baixo", "baixo", "vai pra baixo"];
    const up = ["role para cima", "role cima", "suba", "scroll up",
      "subir para cima", "subir pra cima", "subir", "sobe", "pra cima",
      "para cima", "cima", "em cima", "vai pra cima"];
    if (down.includes(command)) {
      performSilentAction(() => window.scrollBy({
        top: window.innerHeight * 0.8, behavior: "smooth",
      }), sequence);
      return true;
    }
    if (up.includes(command)) {
      performSilentAction(() => window.scrollBy({
        top: window.innerHeight * -0.8, behavior: "smooth",
      }), sequence);
      return true;
    }
    if (["volte", "voltar"].includes(command)) {
      performSilentAction(() => history.back(), sequence);
      return true;
    }
    if (["avance", "avancar"].includes(command)) {
      performSilentAction(() => history.forward(), sequence);
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

    if (normalizedCommand.includes("encerrar assistente")) {
      handleSessionCommand(normalizedCommand, sequence, respond);
      return;
    }
    if (normalizedCommand === "cancelar") {
      assistantState.pendingIntent = null;
      respond("Cancelado.");
      return;
    }
    if (assistantState.pendingIntent === "weatherCity") {
      assistantState.pendingIntent = null;
      const city = command.trim().replace(/^jarvis(?:[\s.,;:!?]+|$)/i, "").trim();
      requestWeather(city, sequence);
      return;
    }

    if (handleSessionCommand(normalizedCommand, sequence, respond)) return;
    if (handleSettingsCommand(normalizedCommand, sequence, respond)) return;

    if (handleAssistantCommand(normalizedCommand, respond)) return;

    if (handleDateTimeCommand(normalizedCommand, respond)) return;

    if (handleWeatherCommand(normalizedCommand, command, sequence, respond)) return;

    if (handlePageCommand(normalizedCommand, respond)) return;
    if (handleNavigationCommand(normalizedCommand, sequence)) return;

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
    assistantState.pendingIntent = null;
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
