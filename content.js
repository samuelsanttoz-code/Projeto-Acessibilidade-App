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
    lastVideoList: [],
    lastShortList: [],
    lastSelectedMedia: null,
    pendingCandidates: [],
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
    assistantState.pendingCandidates = [];
    assistantState.lastVideoList = [];
    assistantState.lastShortList = [];
    assistantState.lastSelectedMedia = null;
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
    if (!element) return "";
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

  function isYouTubeHost() {
    return /(^|\.)youtube\.com$/i.test(location.hostname);
  }

  function getElementHref(element) {
    return normalizePageText(element?.getAttribute?.("href") || element?.href);
  }

  function getCanonicalHref(element) {
    return getElementHref(element)
      .replace(/^(?:https?:)?\/\/(?:[a-z\d-]+\.)*youtube\.com/i, "")
      .replace(/#.*$/, "");
  }

  function isChannelHref(href) {
    return /\/(?:@[^/?#]+|channel\/[^/?#]+|c\/[^/?#]+)/i.test(href);
  }

  function findCardChannel(element) {
    for (let current = element?.parentElement, depth = 0;
      current && current.tagName !== "BODY" && depth < 6; current = current.parentElement, depth += 1) {
      const link = Array.from(current.querySelectorAll?.("a[href]") || [])
        .find((candidate) => isElementVisible(candidate) && isChannelHref(getElementHref(candidate)));
      if (link) return link;
    }
    return null;
  }

  function findMediaCard(element) {
    const fallback = element?.parentElement?.tagName === "BODY" ? element : element?.parentElement || null;
    for (let current = fallback, depth = 0;
      current && current.tagName !== "BODY" && depth < 6; current = current.parentElement, depth += 1) {
      if (current.querySelector?.('h1, h2, h3, [role="heading"]')) return current;
      if (findCardChannel(element)?.parentElement === current) return current;
    }
    return fallback;
  }

  function findSearchControl() {
    const fields = Array.from(document.querySelectorAll("input, textarea, [role=\"searchbox\"]"))
      .filter(isElementVisible);
    const element = fields.find((field) => {
      const type = (field.type || field.getAttribute("type") || "").toLowerCase();
      const role = (field.getAttribute("role") || "").toLowerCase();
      const name = normalizeCommand(getAccessibleName(field));
      return type === "search" || role === "searchbox" || /\b(?:pesquisa|pesquisar|busca|buscar|search)\b/.test(name);
    });
    if (!element) return null;
    let form = element.form || null;
    for (let current = element.parentElement; !form && current; current = current.parentElement) {
      if (current.tagName === "FORM") form = current;
    }
    const scope = form || document;
    const button = Array.from(scope.querySelectorAll?.("button, input[type=\"submit\"], [role=\"button\"]") || [])
      .filter(isElementVisible)
      .find((candidate) => /\b(?:pesquisa|pesquisar|busca|buscar|search)\b/.test(
        normalizeCommand(getAccessibleName(candidate)),
      )) || null;
    return { element, form, button };
  }

  function cardMetadata(card) {
    const text = normalizePageText(card?.innerText);
    const metadata = {};
    const duration = text.match(/(?:^|\s)(\d{1,2}:\d{2}(?::\d{2})?)(?=\s|$)/);
    const views = text.match(/\b[\d.,]+\s*(?:mil|mi|milh(?:ão|ões)?|million|billion)?\s*(?:de\s+)?(?:visualizações|views)\b/i);
    const publishedAt = text.match(/\b(?:há\s+\d+\s+(?:segundos?|minutos?|horas?|dias?|semanas?|meses?|anos?)|\d+\s+(?:seconds?|minutes?|hours?|days?|weeks?|months?|years?)\s+ago)\b/i);
    if (duration) metadata.duration = duration[1];
    if (views) metadata.views = views[0];
    if (publishedAt) metadata.publishedAt = publishedAt[0];
    return metadata;
  }

  function isSponsoredCard(card) {
    const labels = [card, ...Array.from(card?.querySelectorAll?.('span, [aria-label]') || [])];
    return labels.some((element) => {
      if (/\/watch(?:[/?#]|$)|\/shorts\/[^/?#]+/i.test(getElementHref(element))) return false;
      const label = normalizePageText(element.getAttribute("aria-label") ||
        (element === card ? "" : element.innerText));
      return /^(?:anúncio|patrocinado|sponsored|promoted|ad)$/i.test(label);
    });
  }

  function mediaTitle(link, card) {
    const heading = card?.querySelector?.('h1, h2, h3, [role="heading"]');
    const candidates = [normalizePageText(link?.innerText), getAccessibleName(heading), getAccessibleName(link),
      link?.getAttribute?.("title"), link?.getAttribute?.("aria-label")];
    const clean = (value, removeBadge = false) => normalizePageText(normalizePageText(value)
      .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, "")
      .replace(/\b[\d.,]+\s*(?:mil|mi|milh(?:ão|ões)?|million|billion)?\s*(?:de\s+)?(?:visualizações|views)\b/gi, "")
      .replace(/\b(?:há\s+\d+\s+\w+|\d+\s+\w+\s+ago)\b/gi, "")
      .replace(removeBadge ? /\b(?:anúncio|patrocinado|sponsored|promoted|ad)\b/gi : /$^/, ""));
    const title = candidates.map(clean).find((value) => value &&
      !/^\d{1,2}:\d{2}(?::\d{2})?$/.test(value));
    if (title) return title;
    const channel = getAccessibleName(findCardChannel(link));
    const text = normalizePageText(card?.innerText).replace(channel, "");
    return clean(text, true);
  }

  function collectYouTubeContext() {
    if (!isYouTubeHost()) {
      return { videos: [], shorts: [], channels: [], searchControl: findSearchControl() };
    }
    const links = Array.from(document.querySelectorAll("a[href]")).filter(isElementVisible);
    const seen = { videos: new Set(), shorts: new Set(), channels: new Set() };
    const collect = (kind, predicate) => links.filter((link) => predicate(getElementHref(link))).map((link) => {
      const href = getElementHref(link);
      const key = getCanonicalHref(link) || getAccessibleName(link);
      if (seen[kind].has(key)) return null;
      const card = findMediaCard(link);
      const title = kind === "channels" ? getAccessibleName(link) : mediaTitle(link, card);
      if (!title) return null;
      seen[kind].add(key || title);
      if (kind === "channels") return {
        name: title, href, text: normalizePageText(link.parentElement?.innerText), element: link,
      };
      const channelElement = findCardChannel(link);
      const metadata = cardMetadata(card);
      const sponsored = isSponsoredCard(card);
      return {
        id: key || title,
        type: sponsored ? "advertisement" : kind === "videos" ? "video" : "short",
        title,
        channel: getAccessibleName(channelElement),
        author: getAccessibleName(channelElement),
        metadata,
        sponsored,
        live: /\b(?:ao vivo|live)\b/i.test(normalizePageText(card?.innerText)),
        actions: ["open"],
        text: normalizePageText(card?.innerText),
        href,
        element: link,
        channelHref: getElementHref(channelElement),
        channelElement,
      };
    }).filter(Boolean);
    const videoItems = collect("videos", (href) => /\/watch(?:[/?#]|$)/i.test(href));
    const shortItems = collect("shorts", (href) => /\/shorts\/[^/?#]+/i.test(href));
    return {
      videos: videoItems.filter((item) => !item.sponsored),
      shorts: shortItems.filter((item) => !item.sponsored),
      contentItems: [...videoItems, ...shortItems],
      channels: collect("channels", isChannelHref),
      searchControl: findSearchControl(),
    };
  }

  function collectGenericSemanticContext() {
    const visibleElements = (selector) => Array.from(document.querySelectorAll(selector))
      .filter(isElementVisible);
    const namedElements = (selector) => visibleElements(selector).map((element) => ({
      name: getAccessibleName(element),
      type: element.type || element.getAttribute("role") || element.tagName.toLowerCase(),
      element,
    })).filter((element) => element.name);
    const main = visibleElements("main")[0] || visibleElements("article")[0] ||
      visibleElements('[role="main"]')[0] || null;
    const landmarks = visibleElements('header, nav, form, main, footer, aside, [role="banner"], [role="navigation"], [role="search"], [role="main"], [role="contentinfo"], [role="complementary"]')
      .map((element) => {
        const role = element.getAttribute("role");
        const type = ({ nav: "navigation", form: role === "search" ? "search" : null,
          aside: "complementary", footer: "footer", header: "header" })[element.tagName.toLowerCase()] || role || element.tagName.toLowerCase();
        return type ? { type, name: getAccessibleName(element), element } : null;
      }).filter(Boolean);
    const controls = visibleElements('a[href], button, input, textarea, select, [role="button"], [role="link"], [role="textbox"], [role="searchbox"]')
      .map((element, index) => {
        const role = element.getAttribute("role");
        const tag = element.tagName.toLowerCase();
        const type = role || (tag === "a" ? "link" : tag === "input" ?
          element.type === "search" ? "searchbox" : "textbox" : tag);
        return { id: element.getAttribute("id") || `control-${index + 1}`, type,
          name: getAccessibleName(element), element, actions: [type === "link" ? "open" :
            ["textbox", "searchbox"].includes(type) ? "focus" : "activate"] };
      }).filter((control) => control.name);
    const contentItems = visibleElements('article, [role="article"], [itemscope], section')
      .filter((element) => element.tagName === "ARTICLE" || element.getAttribute("role") === "article" ||
        element.getAttribute("itemscope") !== null || element.tagName === "SECTION")
      .map((element, index) => {
        const heading = element.querySelector?.('h1, h2, h3, h4, h5, h6, [role="heading"]');
        const title = isElementVisible(heading) ? getAccessibleName(heading) : "";
        if (!title) return null;
        const schema = element.getAttribute("itemtype") || "";
        const type = /schema\.org\/Product(?:$|[/?#])/i.test(schema) ? "product" :
          element.tagName === "ARTICLE" || element.getAttribute("role") === "article" ? "article" : "generic-content";
        const paragraph = element.querySelector?.("p");
        const description = isElementVisible(paragraph) ? normalizePageText(paragraph.innerText) : "";
        const authorElement = element.querySelector?.('[itemprop="author"], [rel="author"]');
        const author = isElementVisible(authorElement) ? getAccessibleName(authorElement) : "";
        const time = element.querySelector?.("time");
        const date = isElementVisible(time) ? normalizePageText(time.getAttribute("datetime") || time.innerText) : "";
        const metadata = date ? { date } : {};
        return { id: element.getAttribute("id") || `content-${index + 1}`, type, title,
          author, description, metadata, sponsored: false, actions: [], element };
      }).filter(Boolean);
    return {
      page: { title: normalizePageText(document.title) || location.hostname,
        domain: location.hostname, url: location.href || "", type: "generic" },
      landmarks, controls, contentItems,
      title: normalizePageText(document.title) || location.hostname,
      domain: location.hostname,
      headings: namedElements('h1, h2, h3, h4, h5, h6, [role="heading"]'),
      buttons: namedElements('button, [role="button"], input[type="button"], input[type="submit"], input[type="reset"]'),
      links: namedElements('a[href], [role="link"]'),
      fields: namedElements('input, select, textarea').filter((field) =>
        !["button", "submit", "reset", "hidden", "image"].includes(field.type)),
      main,
      focusableElements: visibleElements('a[href], button, input, select, textarea, [tabindex], [role="button"], [role="link"], [role="searchbox"]')
        .map((element) => ({ name: getAccessibleName(element), element }))
        .filter(({ name }) => name),
    };
  }

  function collectPageContext() {
    const context = collectGenericSemanticContext();
    const specialized = collectYouTubeContext();
    if (!isYouTubeHost()) return { ...context, ...specialized };
    return { ...context, ...specialized,
      page: { ...context.page, type: "youtube" },
      contentItems: [...context.contentItems, ...specialized.contentItems] };
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
    const advertisements = context.contentItems.filter((item) => item.type === "advertisement");
    if (advertisements.length) parts.push(`Há ${count(advertisements, "anúncio", "anúncios")}.`);
    if (context.videos.length) parts.push(`Há ${count(context.videos, "vídeo", "vídeos")}.`);
    if (context.shorts.length) parts.push(`Há ${count(context.shorts, "Short", "Shorts")}.`);
    const articles = context.contentItems.filter((item) => item.type === "article");
    if (articles.length) parts.push(`Há ${count(articles, "artigo", "artigos")}.`);
    const products = context.contentItems.filter((item) => item.type === "product");
    if (products.length) parts.push(`Há ${count(products, "produto", "produtos")}.`);
    parts.push(`${counts}.`);
    if (mode === "dense") {
      if (context.landmarks.length) parts.push(`Regiões: ${context.landmarks.map((item) => item.type).join("; ")}.`);
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

  function normalizeMatchText(text) {
    return normalizeCommand(String(text || "").replace(/\bfe!n\b/gi, "fein")
      .replace(/([\p{L}\d])[^\p{L}\d\s]+(?=[\p{L}\d])/gu, "$1"))
      .replace(/\bofficial\b/g, "oficial")
      .replace(/\blive\b/g, "ao vivo")
      .replace(/\bmusic video\b/g, "clipe")
      .replace(/\blyrics?\b/g, "letra")
      .replace(/\s+/g, " ")
      .trim();
  }

  function mediaListIsValid(items) {
    return items.length > 0 && items.every((item) => item.element?.isConnected !== false);
  }

  function currentMediaList(kind, preferCache = true) {
    const key = kind === "video" ? "lastVideoList" : "lastShortList";
    if (preferCache && mediaListIsValid(assistantState[key])) return assistantState[key];
    const context = collectPageContext();
    const items = kind === "video" ? context.videos : context.shorts;
    assistantState[key] = items;
    return items;
  }

  function formatMediaList(kind, items) {
    const label = kind === "video" ? "Vídeo" : "Short";
    if (!items.length) return `Não encontrei ${kind === "video" ? "vídeos" : "Shorts"} nesta página.`;
    return items.map((item, index) => {
      const channel = item.author ? ` Canal: ${item.author}.` : "";
      return `${label} ${index + 1}: ${item.title}.${channel}`;
    }).join(" ");
  }

  function parseMediaIndex(command, kind) {
    const singular = kind === "video" ? "video" : "short";
    const number = command.match(new RegExp(`\\b${singular}(?: numero)? (\\d+)\\b`)) ||
      command.match(new RegExp(`\\b(\\d+) (?:da pagina |da tela )?${singular}\\b`));
    if (number) return Number(number[1]);
    const ordinals = { primeiro: 1, segundo: 2, terceiro: 3 };
    for (const [word, value] of Object.entries(ordinals)) {
      if (new RegExp(`\\b${word}(?: ${singular})?\\b`).test(command) && command.includes(singular)) return value;
    }
    return null;
  }

  function selectMedia(item, sequence) {
    performSilentAction(() => {
      item.element.click();
      assistantState.lastSelectedMedia = item;
    }, sequence);
  }

  function openMediaByIndex(kind, index, sequence, respond) {
    const items = currentMediaList(kind);
    const item = items[index - 1];
    if (!item) {
      respond(`Não encontrei o ${kind === "video" ? "vídeo" : "short"} ${index} nesta página.`);
      return;
    }
    selectMedia(item, sequence);
  }

  function extractMediaQuery(command, kind) {
    const name = kind === "video" ? "video" : "short";
    return command
      .replace(/^(?:abrir|abre|acessar|acesse|ir para)\s+/, "")
      .replace(new RegExp(`^(?:o |a )?${name}(?: do| da)?\\s*`), "")
      .replace(/^(?:o |a |do |da )+/, "")
      .trim();
  }

  function scoreCandidate(item, query) {
    const title = normalizeMatchText(item.title);
    const channel = normalizeMatchText(item.channel);
    const extra = normalizeMatchText(`${item.text} ${item.href}`);
    const normalized = normalizeMatchText(query);
    const stop = new Set(["o", "a", "os", "as", "de", "do", "da", "e", "que", "um", "uma"]);
    const tokens = [...new Set(normalized.split(" ").filter((token) => token && !stop.has(token)))];
    let score = title === normalized ? 100 : title.includes(normalized) && normalized ? 40 : 0;
    for (const token of tokens) {
      if (title.includes(token)) score += 12;
      if (channel.includes(token)) score += 8;
      if (extra.includes(token)) score += 5;
    }
    for (const feature of ["oficial", "ao vivo", "letra", "audio", "visualizer", "remix", "clipe", "shorts", "short"]) {
      if (normalized.includes(feature) && `${title} ${channel} ${extra}`.includes(feature)) score += 8;
    }
    return score;
  }

  function askMediaChoice(kind, ranked, respond) {
    const close = ranked.filter((item) => item.score >= ranked[0].score - 9).slice(0, 3);
    assistantState.pendingIntent = "mediaChoice";
    assistantState.pendingCandidates = close.map(({ item, index }) => ({ item, index, kind }));
    const label = kind === "video" ? "vídeos" : "Shorts";
    const options = assistantState.pendingCandidates.map(({ item, index }) =>
      `${kind === "video" ? "Vídeo" : "Short"} ${index + 1}: ${item.title}`).join(". ");
    respond(`Encontrei ${close.length === 2 ? "dois" : "alguns"} ${label} parecidos. ${options}. Qual deles?`);
  }

  function openBestMediaMatch(kind, query, sequence, respond) {
    const items = currentMediaList(kind, false);
    const ranked = items.map((item, index) => ({ item, index, score: scoreCandidate(item, query) }))
      .filter(({ score }) => score > 0).sort((a, b) => b.score - a.score || a.index - b.index);
    if (!ranked.length) {
      respond(`Não encontrei ${kind === "video" ? "esse vídeo" : "esse short"} nesta página.`);
      return;
    }
    const duplicateExact = ranked.length > 1 && normalizeMatchText(ranked[0].item.title) === normalizeMatchText(query) &&
      normalizeMatchText(ranked[1].item.title) === normalizeMatchText(query);
    if (duplicateExact || (ranked[1] && ranked[0].score - ranked[1].score < 10)) {
      askMediaChoice(kind, ranked, respond);
      return;
    }
    selectMedia(ranked[0].item, sequence);
  }

  function resolveMediaChoice(command, sequence, respond) {
    const candidates = assistantState.pendingCandidates;
    const optionOrdinal = { primeiro: 0, segundo: 1, terceiro: 2 };
    let selected = null;
    for (const [word, index] of Object.entries(optionOrdinal)) {
      if (command.includes(word)) selected = candidates[index]?.item;
    }
    const explicit = command.match(/\b(?:video|short|canal)(?: numero)? (\d+)\b/);
    if (explicit) selected = candidates.find(({ index }) => index + 1 === Number(explicit[1]))?.item;
    if (!selected) {
      const ranked = candidates.map((candidate) => ({ ...candidate, score: scoreCandidate({
        title: candidate.item.title || candidate.item.name,
        channel: candidate.item.channel || candidate.item.name,
        text: candidate.item.text,
        href: candidate.item.href,
      }, command) }))
        .sort((a, b) => b.score - a.score);
      const matches = ranked.filter(({ score }) => score > 0);
      if (matches.length === 1 ||
          (matches[1] && matches[0].score - matches[1].score >= 10)) {
        selected = matches[0].item;
      } else if (matches.length > 1) {
        assistantState.pendingCandidates = matches.map(({ item, index, kind }) => ({
          item, index, kind,
        }));
      }
    }
    if (selected) {
      assistantState.pendingIntent = null;
      assistantState.pendingCandidates = [];
      selectMedia(selected, sequence);
    } else {
      const options = assistantState.pendingCandidates.map(({ item, index, kind }) =>
        `${kind === "short" ? "Short" : kind === "channel" ? "Canal" : "Vídeo"} ${index + 1}: ${item.title || item.name}`).join(". ");
      respond(`Ainda há opções parecidas. ${options}. Qual delas?`);
    }
  }

  function handleChannelCommand(command, sequence, respond) {
    if (/^(?:abrir |ir para )?(?:o )?canal desse video$/.test(command)) {
      const media = assistantState.lastSelectedMedia;
      if (!media?.channelElement) respond("Qual vídeo?");
      else performSilentAction(() => media.channelElement.click(), sequence);
      return true;
    }
    if (!/\bcanal\b/.test(command)) return false;
    const query = command.replace(/^(?:abrir|acessar|ir para)\s+/, "")
      .replace(/^(?:o )?canal(?: do)?\s*/, "").trim();
    if (!query) return false;
    const channels = collectPageContext().channels;
    const ranked = channels.map((item, index) => ({ item, index, score: scoreCandidate({
      title: item.name, channel: item.name, text: item.href, href: item.href,
    }, query) })).filter(({ score }) => score > 0).sort((a, b) => b.score - a.score || a.index - b.index);
    if (!ranked.length) respond("Não encontrei esse canal nesta página.");
    else if (ranked[1] && ranked[0].score - ranked[1].score < 10) {
      assistantState.pendingIntent = "mediaChoice";
      assistantState.pendingCandidates = ranked.slice(0, 3).map(({ item, index }) => ({ item, index, kind: "channel" }));
      respond(`Encontrei canais parecidos: ${ranked.slice(0, 3).map(({ item }) => item.name).join("; ")}. Qual deles?`);
    } else performSilentAction(() => ranked[0].item.element.click(), sequence);
    return true;
  }

  function handleVideoCommand(command, sequence, respond) {
    if (!isYouTubeHost()) return false;
    if (/\bvideos\b/.test(command) && /\b(?:quais|liste|listar)\b/.test(command) ||
        ["videos da pagina", "videos da tela"].includes(command)) {
      const items = collectPageContext().videos;
      assistantState.lastVideoList = items;
      respond(formatMediaList("video", items));
      return true;
    }
    const index = parseMediaIndex(command, "video");
    if (index !== null) {
      openMediaByIndex("video", index, sequence, respond);
      return true;
    }
    if (/^(?:abrir|abre|acessar|acesse)\b/.test(command) && !command.includes("canal")) {
      const query = extractMediaQuery(command, "video");
      if (query) {
        openBestMediaMatch("video", query, sequence, respond);
        return true;
      }
    }
    return false;
  }

  function findShortsNavigation() {
    return Array.from(document.querySelectorAll("a[href]")).filter(isElementVisible)
      .find((link) => /^\/?shorts\/?(?:[?#].*)?$/i.test(getElementHref(link)) ||
        /(?:^|\/)shorts\/?(?:[?#].*)?$/i.test(getElementHref(link)) &&
        !/\/shorts\/[^/?#]+/i.test(getElementHref(link))) || null;
  }

  function handleShortsCommand(command, sequence, respond) {
    if (!isYouTubeHost() || !/\bshorts?\b/.test(command)) return false;
    if (/\bshorts\b/.test(command) && /\b(?:quais|liste|listar)\b/.test(command)) {
      const items = collectPageContext().shorts;
      assistantState.lastShortList = items;
      respond(formatMediaList("short", items));
      return true;
    }
    const index = parseMediaIndex(command, "short");
    if (index !== null) {
      openMediaByIndex("short", index, sequence, respond);
      return true;
    }
    if (["shorts", "abrir shorts", "acessar shorts", "ir para shorts", "va para shorts"].includes(command)) {
      const link = findShortsNavigation();
      if (link) performSilentAction(() => link.click(), sequence);
      else respond("Não encontrei a área de Shorts.");
      return true;
    }
    if (/^(?:abrir|abre|acessar|acesse)\s+(?:o )?short\b/.test(command)) {
      const query = extractMediaQuery(command, "short");
      if (query) openBestMediaMatch("short", query, sequence, respond);
      return true;
    }
    return false;
  }

  function setSearchValue(element, value) {
    const prototype = element.tagName === "INPUT"
      ? globalThis.HTMLInputElement?.prototype
      : element.tagName === "TEXTAREA"
        ? globalThis.HTMLTextAreaElement?.prototype
        : null;
    const setter = prototype && Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (setter) setter.call(element, value);
    else element.value = value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function submitSearch(control) {
    if (typeof control.form?.requestSubmit === "function") control.form.requestSubmit();
    else if (typeof control.form?.submit === "function") control.form.submit();
    else if (control.button) control.button.click();
    else return false;
    return true;
  }

  function executeSearch(query, sequence, respond) {
    const control = collectPageContext().searchControl;
    if (!control) {
      respond("Não encontrei a barra de pesquisa.");
      return;
    }
    if (typeof control.form?.requestSubmit !== "function" &&
        typeof control.form?.submit !== "function" && !control.button) {
      respond("Não encontrei a barra de pesquisa.");
      return;
    }
    performSilentAction(() => {
      control.element.focus();
      setSearchValue(control.element, query);
      submitSearch(control);
    }, sequence);
  }

  function handleSearchCommand(command, original, sequence, respond) {
    if (["barra de pesquisa", "acessar barra de pesquisa", "ir para barra de pesquisa", "abrir pesquisa"].includes(command)) {
      const control = collectPageContext().searchControl;
      if (control) performSilentAction(() => control.element.focus(), sequence);
      else respond("Não encontrei a barra de pesquisa.");
      return true;
    }
    const direct = original.trim().match(/^(?:jarvis[\s,;:.-]+)?(?:pesquisar|buscar|procure|procura)\s+(.+)$/i);
    if (direct?.[1]?.trim()) {
      executeSearch(direct[1].trim(), sequence, respond);
      return true;
    }
    if (["pesquisar", "buscar", "procure", "procura"].includes(command)) {
      assistantState.pendingIntent = "searchQuery";
      respond("O que você quer pesquisar?");
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
      scheduleSessionTimeout();
      speak("Não foi possível executar essa ação.", {
        after: () => resumeListening(sequence),
      });
      return;
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
      assistantState.pendingCandidates = [];
      respond("Cancelado.");
      return;
    }
    if (assistantState.pendingIntent === "mediaChoice") {
      resolveMediaChoice(normalizedCommand, sequence, respond);
      return;
    }
    if (assistantState.pendingIntent === "searchQuery") {
      assistantState.pendingIntent = null;
      const query = command.trim().replace(/^jarvis(?:[\s.,;:!?]+|$)/i, "").trim();
      executeSearch(query, sequence, respond);
      return;
    }
    if (assistantState.pendingIntent === "weatherCity") {
      assistantState.pendingIntent = null;
      const city = command.trim().replace(/^jarvis(?:[\s.,;:!?]+|$)/i, "").trim();
      requestWeather(city, sequence);
      return;
    }

    if (handleSessionCommand(normalizedCommand, sequence, respond)) return;
    if (handleNavigationCommand(normalizedCommand, sequence)) return;
    if (handleSearchCommand(normalizedCommand, command, sequence, respond)) return;
    if (handleShortsCommand(normalizedCommand, sequence, respond)) return;
    if (handleChannelCommand(normalizedCommand, sequence, respond)) return;
    if (handleVideoCommand(normalizedCommand, sequence, respond)) return;
    if (handleSettingsCommand(normalizedCommand, sequence, respond)) return;

    if (handleAssistantCommand(normalizedCommand, respond)) return;

    if (handleDateTimeCommand(normalizedCommand, respond)) return;

    if (handleWeatherCommand(normalizedCommand, command, sequence, respond)) return;

    if (handlePageCommand(normalizedCommand, respond)) return;

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
    assistantState.pendingCandidates = [];
    assistantState.lastVideoList = [];
    assistantState.lastShortList = [];
    assistantState.lastSelectedMedia = null;
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
