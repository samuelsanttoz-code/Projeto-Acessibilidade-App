# Jarvis Accessible Web Assistant v3 Design

**Feature key:** `accessible_web_assistant_mvp`  
**Contract version:** `3`  
**Status:** Design ready for written review  
**Base commit:** `04cfa532b8d54be95abefccb154751565ed7ead2`

## Purpose

Evolve the existing Chrome/Edge extension into a useful local accessibility assistant named Jarvis. Preserve the continuous conversation cycle from contract version 2 while adding a sound interface, configurable native speech, local utility commands, basic page inspection, simple navigation, and weather by city.

Jarvis remains explicitly activated by `Alt+Shift+A`. There is no permanent wake word, continuously open microphone, LLM, application backend, OCR, computer vision, Supabase integration, or complex autonomous action.

## Architecture

Keep the existing two production files and functional style.

- `background.js` owns browser-session introduction state and Open-Meteo requests.
- `content.js` owns conversation state, speech, earcons, command routing, page context, navigation, and user preferences.
- `manifest.json` adds only Open-Meteo host permissions. The existing `storage` permission covers `chrome.storage.local` and `chrome.storage.session`.
- `tests/extension.test.js` exercises both scripts with controlled browser, DOM, audio, time, storage, and network doubles.

No classes, build system, external dependency, or generalized framework will be introduced.

## State

The in-memory assistant state extends the current object with only necessary fields:

```js
{
  status,
  isActive,
  mode,
  lastResponse,
  lastCommand,
  lastActivatedAt,
  pendingIntent
}
```

`pendingIntent` is either `null` or `"weatherCity"`. It is never persisted.

The existing `activationSequence`, recognition reference, speech sequence, session timer, and conversation guards remain the authority for invalidating old callbacks.

## Persistence

### Browser-session introduction

`background.js` uses `chrome.storage.session` with key `jarvisIntroduced`. When the keyboard command arrives, the service worker reserves the first introduction and sends this payload to the active tab:

```js
{
  type: "ACCESSIBLE_ASSISTANT_ACTIVATE",
  introduce: true | false
}
```

An in-memory reservation in the service worker prevents two rapid commands from both claiming the first introduction. Browser-session storage restores the decision if the service worker restarts. A new browser session clears it naturally.

### User preferences

`content.js` uses one `chrome.storage.local` object named `jarvisPreferences`:

```js
{
  voiceURI: null,
  rate: 1.02,
  pitch: 0.9,
  volume: 1,
  mode: "dynamic"
}
```

Stored values are validated and clamped when loaded. Activation waits for the initial preference load, ensuring a reloaded page uses the saved mode and voice settings. Changes to voice, rate, volume, or mode are persisted immediately. No navigation history, page content, weather context, command history, or pending intent is stored.

## Interaction Sequence

One function remains the only gateway back to recognition. It verifies:

- the assistant is active;
- the activation sequence is current;
- no recognition instance exists;
- no speech is active;
- no earcon is active.

When those conditions pass, the function plays LISTENING. It creates `SpeechRecognition` only after the earcon ends and after rechecking every guard.

### First activation in a browser session

1. Increment the activation sequence.
2. Cancel old speech, earcon callbacks, recognition, pending intent, and timer.
3. Mark the session active.
4. Play ON.
5. Speak `Olá, sou Jarvis, à sua disposição.`
6. Play LISTENING.
7. Open one non-continuous recognition instance.

### Later activations in the same browser session

1. Perform the same cancellation and sequence reset.
2. Play ON.
3. Play LISTENING without spoken introduction.
4. Open recognition.

### Recognized command

1. Store the transcript and request recognition to stop.
2. Wait for the matching recognition `onend` event.
3. Clear the recognition reference.
4. Play PROCESSING once.
5. Route the command after PROCESSING ends.
6. Speak the response.
7. After speech ends, return through the guarded LISTENING flow.

This ordering prevents Jarvis from hearing speech or earcons. Old recognition, speech, earcon, storage, or network callbacks must verify the captured activation sequence before changing state.

### End command

`encerrar assistente` immediately prevents reopening, clears pending intent and the timer, and stops recognition. Jarvis speaks `Até mais.`, then plays OFF. The final state is `INACTIVE`. Neither the farewell nor OFF has a callback that can restart recognition.

### Timeout

After 30 seconds without a new interaction, timeout increments the activation sequence, clears pending intent, stops recognition, cancels speech and active earcon callbacks, and leaves `INACTIVE`.

## Earcons

`content.js` provides one `playEarcon(kind, sequence, after)` helper using Web Audio API. Each sound uses low gain, closes its `AudioContext`, and invokes its callback only for the current sequence.

- ON: about 200 ms; initial pulse followed by a brighter ascending tone.
- LISTENING: about 70 ms; one short, distinct bright tone.
- PROCESSING: about 90 ms; a short pulse with a different pitch/envelope.
- OFF: about 180 ms; descending tone.

The helper tracks earcon activity independently from speech activity. Recognition cannot start until LISTENING has fully ended.

## Speech Profile

Every `SpeechSynthesisUtterance` receives current preferences:

- `lang = "pt-BR"`
- `rate = 1.02` by default
- `pitch = 0.9`
- `volume = 1`

Voice selection calls `speechSynthesis.getVoices()` at speaking time. Selection order is:

1. saved `voiceURI` if still installed;
2. first `pt-BR` voice;
3. first `pt` voice;
4. browser default.

`voiceschanged` does not interrupt current speech. The next utterance uses the refreshed list.

Voice commands use these limits and steps:

- rate range: `0.7` to `1.5`, step `0.1`;
- normal rate: `1.02`;
- volume range: `0.2` to `1`, step `0.1`;
- pitch remains `0.9` in this contract;
- voice cycling uses only `pt-BR` and `pt` candidates, wrapping at the end.

Confirmations are brief and use the new value immediately after persistence.

## Command Normalization and Routing

Normalization keeps the existing lowercase, accent removal, punctuation removal, whitespace normalization, and trimming. It then removes a leading `Jarvis` token. Jarvis is not a wake word and has no meaning outside the active session.

`processCommand` stays small by calling ordered functional handlers. Each handler returns whether it consumed the command. The order is:

1. session and pending-intent commands;
2. voice and mode settings;
3. greetings, identity, help, date, and time;
4. weather;
5. page context and accessibility;
6. navigation;
7. unsupported-command fallback.

Handlers use the same guarded response function, so continuous conversation behavior does not diverge by command type.

## General Commands

- Greetings (`oi`, `olá`, `bom dia`, `boa tarde`, `boa noite`) receive a short appropriate greeting.
- `tudo bem` receives a short functional answer.
- `quem é você` identifies Jarvis as a web accessibility assistant.
- `o que você faz`, `o que você consegue fazer`, and `ajuda` summarize only implemented command groups in a concise response.
- Unsupported commands answer `Ainda não consigo executar esse comando.`

## Date and Time

Time uses the local computer clock and answers hours and minutes. Date uses `Intl.DateTimeFormat("pt-BR")` with weekday, day, month, and year. Tests inject a fixed `Date` so expected speech is deterministic.

## Weather

Only `background.js` performs network requests.

The content script sends:

```js
{
  type: "JARVIS_WEATHER_REQUEST",
  city: "Anápolis"
}
```

No title, hostname, DOM text, page URL, or other page content is included.

The background flow is:

1. GET `https://geocoding-api.open-meteo.com/v1/search` with `name`, `count=1`, `language=pt`, and `format=json`.
2. If no result exists, return `{ ok: false, reason: "city-not-found" }`.
3. GET `https://api.open-meteo.com/v1/forecast` with latitude, longitude, requested current fields, requested daily fields, `timezone=auto`, and `forecast_days=1`.
4. Return a normalized weather object containing only available values and the resolved city name.
5. Convert network, HTTP, or malformed-data failures to `{ ok: false, reason: "network" }`.

`content.js` maps Open-Meteo weather codes into simple Portuguese descriptions and omits absent values rather than inventing data.
Numeric weather values are rounded sensibly for concise speech.

Direct forms extract the city after `tempo em`, `clima em`, or `previsão do tempo em`. A weather request without a city asks `De qual cidade?` and sets `pendingIntent = "weatherCity"`. The next nonempty command is used only as the city. `cancelar` clears the intent and answers `Cancelado.`

Network callbacks capture the activation sequence. A response arriving after timeout, reactivation, or end is ignored. While waiting, the session remains `PROCESSING` with no recognition active. Successful and failed weather answers return to the common conversation cycle.

## Page Context

The content script uses small helpers, not a full accessibility-tree implementation.

### Visibility

An element is visible when computed style does not hide it and it has rendered geometry. Tests use explicit fixture visibility.

### Accessible name

Names are resolved in this order when applicable:

1. `aria-label`;
2. text referenced by `aria-labelledby`;
3. visible text, including an associated visible `label` for form controls;
4. `alt`;
5. `title`;
6. `placeholder`;
7. `value` for safe control types.

Password values are never used. Empty names are omitted from spoken lists.

### Collected elements

Helpers collect visible headings, buttons, links, form fields, `main`, `article`, and `[role="main"]`. Limits are applied before creating speech.

## Dynamic and Dense Modes

Mode changes update both `assistantState.mode` and local preferences.

### Dynamic

- page description: title, primary heading if available, main-content presence, and a compact control/count summary;
- button and link lists: total plus up to 5 names;
- field list: total plus up to 5 names/types;
- main content: normalized excerpt up to 700 characters.

### Dense

- page description: title, domain, up to 8 headings, link/button/field counts, and up to 15 relevant control names;
- button, link, and field lists: total plus up to 15 names;
- main content: normalized excerpt up to 2,000 characters.

Descriptions report observable DOM facts only. They do not infer page meaning that the DOM does not establish.

## Page Commands

- `onde estou` and title questions answer title plus domain.
- Page-description phrases use the active mode.
- Button, link, and form-field phrases list visible named elements within mode limits.
- Main-content phrases choose `main`, then `article`, then `[role="main"]`, then `body`.
- Before reading main content, a cloned subtree removes `script`, `style`, `nav`, `footer`, and `noscript` when cloning is available. Text is normalized and truncated at the mode limit.
- Empty collections and empty content produce explicit short messages.

## Navigation

- Scroll down: `window.scrollBy({ top: window.innerHeight * 0.8, behavior: "smooth" })`.
- Scroll up: same distance with a negative value.
- Back: `history.back()`.
- Forward: `history.forward()`.

Each command gives short feedback and returns to the shared conversation cycle.

## Manifest and Privacy

Add only these host permissions:

```json
[
  "https://geocoding-api.open-meteo.com/*",
  "https://api.open-meteo.com/*"
]
```

Page content never leaves the content script for weather requests. The extension sends only the user-spoken city name. The microphone is one-shot and inactive during Jarvis speech, earcons, processing, and network waits. This contract has no LLM or proprietary backend.

## Error Handling

- Unsupported recognition: speak the existing limitation without throwing.
- Recoverable recognition error: speak feedback, then return through LISTENING.
- `aborted`: no false response and no old-cycle restart.
- Missing city: `Não encontrei essa cidade.`
- Network or malformed weather response: `Não consegui consultar o clima agora.`
- Missing compatible voice: retain browser default and give a short voice-change response.
- Missing Web Audio support: skip the unavailable tone safely, preserve sequencing, and continue without throwing.
- Restricted pages: retain existing service-worker warning behavior.

## Files Changed

- `manifest.json`: Open-Meteo host permissions and updated metadata if needed.
- `background.js`: introduction-session state and weather request handler.
- `content.js`: earcons, speech preferences, router, utilities, page context, navigation, weather conversation, and preserved continuous cycle.
- `tests/extension.test.js`: expanded production-behavior tests and controlled doubles.
- `README.md`: Jarvis identity, commands, privacy, limits, APIs, and manual test procedure.

## Testing Strategy

Tests retain every contract-version-2 scenario and add:

- first and later activation behavior using `storage.session`;
- ordering and distinction of ON, LISTENING, PROCESSING, and OFF;
- no overlap among recognition, speech, and earcons;
- speech profile selection, bounds, cycling, and persistence;
- leading Jarvis removal and every general/date/time intent group;
- mode persistence and observable dynamic/dense output differences;
- accessible-name precedence, hidden-element filtering, password protection, content limits, and navigation calls;
- direct weather, prompted city, cancellation, missing city, network failure, and exact city-only message boundary;
- uninterrupted conversation after general, accessibility, and weather commands;
- timeout, end, reactivation, and stale-callback protection.

Required automated validation:

```powershell
node --test --test-isolation=none tests/extension.test.js
node --check content.js
node --check background.js
git diff --check
```

The manifest must also parse as valid JSON.

## Manual Acceptance

Reload the unpacked extension, then execute the complete 27-step manual flow from the approved contract on a normal HTTP/HTTPS page. Verify introduction once per browser session, all four earcons, voice persistence after page reload, dynamic/dense page behavior, weather follow-up, end behavior, and a clean console.

If no browser is available to the executor, report exactly that manual validation is pending.
