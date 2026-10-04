const ACTIVATE_COMMAND = "activate-assistant";
const ACTIVATE_MESSAGE = "ACCESSIBLE_ASSISTANT_ACTIVATE";
const INTRODUCED_KEY = "jarvisIntroduced";
let introductionReserved = false;

async function fetchWeather(city) {
  if (typeof city !== "string" || !city.trim()) {
    return { ok: false, reason: "city-not-found" };
  }
  try {
    const geocodingUrl = new URL("https://geocoding-api.open-meteo.com/v1/search");
    for (const [key, value] of Object.entries({ name: city.trim(), count: "1", language: "pt", format: "json" })) {
      geocodingUrl.searchParams.set(key, value);
    }
    const geocodingResponse = await fetch(geocodingUrl.href);
    if (!geocodingResponse.ok) throw new Error("Geocoding HTTP failure");
    const geocoding = await geocodingResponse.json();
    if (!geocoding || typeof geocoding !== "object" || Array.isArray(geocoding) || geocoding.error ||
        (geocoding.results !== undefined && !Array.isArray(geocoding.results))) {
      throw new Error("Malformed geocoding");
    }
    if (!geocoding.results?.length) return { ok: false, reason: "city-not-found" };
    const place = geocoding.results[0];
    if (!place || typeof place.name !== "string" || !place.name.trim() ||
        !Number.isFinite(place.latitude) || !Number.isFinite(place.longitude)) {
      throw new Error("Malformed coordinates");
    }
    const forecastUrl = new URL("https://api.open-meteo.com/v1/forecast");
    for (const [key, value] of Object.entries({
      latitude: place.latitude,
      longitude: place.longitude,
      current: "temperature_2m,apparent_temperature,weather_code,wind_speed_10m",
      daily: "temperature_2m_max,temperature_2m_min",
      timezone: "auto",
      forecast_days: "1",
    })) {
      forecastUrl.searchParams.set(key, value);
    }
    const forecastResponse = await fetch(forecastUrl.href);
    if (!forecastResponse.ok) throw new Error("Forecast HTTP failure");
    const forecast = await forecastResponse.json();
    if (!forecast || typeof forecast !== "object" || Array.isArray(forecast)) {
      throw new Error("Malformed forecast");
    }
    const result = { ok: true, city: place.name.trim() };
    const dailyValue = (key) => Array.isArray(forecast.daily?.[key]) ? forecast.daily[key][0] : undefined;
    for (const [key, value] of Object.entries({
      temperature: forecast.current?.temperature_2m,
      apparentTemperature: forecast.current?.apparent_temperature,
      weatherCode: forecast.current?.weather_code,
      windSpeed: forecast.current?.wind_speed_10m,
      maximum: dailyValue("temperature_2m_max"),
      minimum: dailyValue("temperature_2m_min"),
    })) {
      if (Number.isFinite(value)) result[key] = value;
    }
    if (Object.keys(result).length === 2) throw new Error("No weather values");
    return result;
  } catch {
    return { ok: false, reason: "network" };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "JARVIS_WEATHER_REQUEST") return false;
  fetchWeather(message.city).then(sendResponse);
  return true;
});

function claimIntroduction(callback) {
  if (introductionReserved) {
    callback(false);
    return;
  }

  introductionReserved = true;
  chrome.storage.session.get(INTRODUCED_KEY, (session) => {
    if (session[INTRODUCED_KEY]) {
      callback(false);
      return;
    }

    chrome.storage.session.set({ [INTRODUCED_KEY]: true }, () => {
      callback(true);
    });
  });
}

chrome.commands.onCommand.addListener((command) => {
  if (command !== ACTIVATE_COMMAND) {
    return;
  }

  chrome.tabs.query({ active: true, currentWindow: true }, ([activeTab]) => {
    if (typeof activeTab?.id !== "number") {
      console.warn("[Assistente Acessível] Nenhuma aba ativa disponível.");
      return;
    }

    claimIntroduction((introduce) => {
      chrome.tabs.sendMessage(
        activeTab.id,
        { type: ACTIVATE_MESSAGE, introduce },
        () => {
          if (chrome.runtime.lastError) {
            console.warn(
              "[Assistente Acessível] Não foi possível ativar nesta página:",
              chrome.runtime.lastError.message,
            );
          }
        },
      );
    });
  });
});
