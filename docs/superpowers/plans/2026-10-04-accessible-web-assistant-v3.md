# Jarvis Accessible Web Assistant v3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver contract version 3 of the Jarvis browser accessibility assistant while preserving the guarded continuous-conversation cycle from version 2.

**Architecture:** Keep the existing Manifest V3 extension and functional two-script structure. `background.js` owns browser-session introduction state and Open-Meteo calls; `content.js` owns serialized earcon, speech, recognition, local intent, page-context, navigation, and preference behavior. One guarded `resumeListening(sequence)` path is the only way to reopen the microphone.

**Tech Stack:** Chrome Extension Manifest V3, plain JavaScript, Web Speech API, Web Audio API, Chrome storage/messaging APIs, Open-Meteo HTTP APIs, Node.js built-in test runner and `vm` mocks.

**Spec:** `docs/superpowers/specs/2026-10-04-accessible-web-assistant-v3-design.md`

## Global Constraints

- Work only on branch `main`; do not create another branch or worktree.
- Do not add classes, frameworks, build tools, external libraries, backend, LLM, OCR, vision, Supabase, or permanent wake-word behavior.
- Preserve one-shot recognition, the 30-second session timeout, late-callback invalidation, and every contract-version-2 test behavior.
- Never overlap active recognition with speech or an earcon, and never allow two recognition instances.
- Persist only `voiceURI`, `rate`, `pitch`, `volume`, and `mode` in `chrome.storage.local`; keep introduction state in `chrome.storage.session` and contextual state in memory.
- Send only a city name to Open-Meteo through `background.js`; never send page content or URL.
- Keep responses in pt-BR and unsupported-command copy exactly `Ainda não consigo executar esse comando.`
- Do not stage or commit the existing untracked `.serena/` directory.

## File Structure

- Modify `manifest.json`: add only the two Open-Meteo host permissions and update descriptive metadata if necessary.
- Modify `background.js`: reserve the once-per-browser-session introduction and service weather requests.
- Modify `content.js`: implement sequencing, preferences, router, page helpers, navigation, and weather conversation using grouped functions.
- Modify `tests/extension.test.js`: expand the existing VM harness and cover all version-2 and version-3 behavior.
- Modify `README.md`: document Jarvis, commands, APIs, privacy, limitations, and the manual checklist.

## Review Focus

- Two rapid activations before `storage.session` completes must produce exactly one `introduce: true`; Task 1 pins this race.
- A stale audio, speech, recognition, storage, or network callback after reactivation/timeout/end must not reopen recognition; Tasks 2 and 6 pin each boundary.
- An empty voice list or a removed saved voice must safely use the browser default; Task 3 pins both cases.
- Hidden/malformed DOM and password controls must not leak invisible or sensitive content; Task 5 pins visibility, broken `aria-labelledby`, and password behavior.
- Weather responses with zero values, missing daily arrays, Unicode city names, or HTTP/malformed failures must remain truthful and encoded; Task 6 pins these inputs.

---

### Task 1: Browser-session introduction decision

**Files:**
- Modify: `background.js`
- Test: `tests/extension.test.js`

**Interfaces:**
- Consumes: Chrome `commands`, `tabs`, and `storage.session` callback APIs.
- Produces: `claimIntroduction(callback: (introduce: boolean) => void)` and activation payload `{ type: "ACCESSIBLE_ASSISTANT_ACTIVATE", introduce: boolean }`.

- [ ] **Step 1: Add failing background tests**

Add `createBackgroundHarness()` and tests named `primeira ativação da sessão apresenta Jarvis`, `segunda ativação não repete introdução`, `nova storage.session identifica nova primeira ativação`, and `ativações rápidas reservam uma única introdução`. Assert payloads exactly:

```js
assert.deepEqual(sentMessages[0].message, {
  type: "ACCESSIBLE_ASSISTANT_ACTIVATE",
  introduce: true,
});
assert.equal(sentMessages[1].message.introduce, false);
assert.equal(rapidMessages.filter(({ message }) => message.introduce).length, 1);
```

- [ ] **Step 2: Run the tests and verify red**

Run: `node --test --test-isolation=none tests/extension.test.js`

Expected: FAIL because activation messages have no `introduce` decision and session storage is unused.

- [ ] **Step 3: Implement the session claim**

In `background.js`, add `INTRODUCED_KEY = "jarvisIntroduced"`, an in-memory reservation boolean, and `claimIntroduction(callback)`. Reserve before asynchronous `chrome.storage.session.get`, persist `true` on the first claim, and keep restricted-page warning behavior unchanged.

- [ ] **Step 4: Run the suite and verify green**

Run: `node --test --test-isolation=none tests/extension.test.js`

Expected: all current and Task 1 tests PASS.

- [ ] **Step 5: Commit Task 1**

```powershell
git add -- background.js tests/extension.test.js
git commit -m "feat: controlar apresentação do Jarvis por sessão"
```

### Task 2: Serialized Jarvis activation and earcons

**Files:**
- Modify: `content.js`
- Modify: `tests/extension.test.js`

**Interfaces:**
- Consumes: Task 1 activation payload and existing `activationSequence`, `recognition`, `speak`, `stopRecognition`, and session timer.
- Produces: `playEarcon(kind, sequence, after)`, `cancelEarcon()`, `canResumeListening(sequence)`, and the sole microphone gateway `resumeListening(sequence)`.

- [ ] **Step 1: Upgrade the content harness and add failing sequence tests**

Make fake audio completion controllable and log ordered events. Add tests for ON, LISTENING-before-recognition, PROCESSING-after-recognition-end, OFF-after-farewell, no audio/speech/microphone overlap, three commands in one activation, end/timeout/reactivation stale callbacks, recoverable and aborted errors, and missing SpeechRecognition. Core assertions:

```js
assert.deepEqual(events.slice(0, 3), ["earcon:ON", "speech:intro", "earcon:LISTENING"]);
assert.ok(events.indexOf("earcon:LISTENING:end") < events.indexOf("recognition:start"));
assert.ok(events.indexOf("recognition:end") < events.indexOf("earcon:PROCESSING"));
assert.equal(harness.FakeRecognition.instances.length, expectedCount);
assert.equal(harness.context.__accessibleWebAssistantState.status, "INACTIVE");
```

- [ ] **Step 2: Run the suite and verify red**

Run: `node --test --test-isolation=none tests/extension.test.js`

Expected: FAIL because only the old activation tone exists and recognition starts without the four-earcon protocol.

- [ ] **Step 3: Implement earcon lifecycle**

Replace `playActivationTone()` with `playEarcon(kind, sequence, after)` and `cancelEarcon()`. Use distinct low-gain envelopes lasting about ON 200 ms, LISTENING 70 ms, PROCESSING 90 ms, and OFF 180 ms; close each `AudioContext`; safely continue when Web Audio is unavailable.

- [ ] **Step 4: Implement guarded interaction ordering**

Change activation to consume `message.introduce`, clear pending work, play ON, optionally speak `Olá, sou Jarvis, à sua disposição.`, then route through LISTENING. Process a transcript only after its matching recognition `onend` and PROCESSING completion. End with `Até mais.`, then OFF, then `INACTIVE`. Every asynchronous callback captures and checks `activationSequence`.

- [ ] **Step 5: Run the suite and verify green**

Run: `node --test --test-isolation=none tests/extension.test.js`

Expected: all version-2 regression and Task 2 tests PASS.

- [ ] **Step 6: Commit Task 2**

```powershell
git add -- content.js tests/extension.test.js
git commit -m "feat: adicionar ciclo sonoro do Jarvis"
```

### Task 3: Speech profile and persisted preferences

**Files:**
- Modify: `content.js`
- Modify: `tests/extension.test.js`

**Interfaces:**
- Consumes: Task 2 `speak(text, options)`, shared responder, and Chrome local storage.
- Produces: `DEFAULT_PREFERENCES`, `loadPreferences()`, `savePreferences()`, `getCompatibleVoices()`, `selectVoice()`, `applySpeechPreferences(utterance)`, and `handleSettingsCommand(command, sequence, respond): boolean`.

- [ ] **Step 1: Add failing preference and voice tests**

Cover defaults, saved-value validation, activation waiting for preference load, pt-BR/pt/default voice priority, removed saved voice, empty voice list, rate/volume bounds and normal speed, voice cycling, and immediate persistence of voice/rate/volume/mode. Assert:

```js
assert.deepEqual(saved.jarvisPreferences, {
  voiceURI: expectedVoiceURI,
  rate: expectedRate,
  pitch: 0.9,
  volume: expectedVolume,
  mode: expectedMode,
});
assert.equal(utterance.lang, "pt-BR");
assert.equal(utterance.pitch, 0.9);
assert.equal(utterance.voice?.voiceURI, expectedVoiceURI);
```

- [ ] **Step 2: Run the suite and verify red**

Run: `node --test --test-isolation=none tests/extension.test.js`

Expected: FAIL because preferences and installed voice selection do not exist.

- [ ] **Step 3: Implement preference loading and application**

Use one `jarvisPreferences` object with defaults `{ voiceURI: null, rate: 1.02, pitch: 0.9, volume: 1, mode: "dynamic" }`. Clamp rate to `0.7..1.5`, volume to `0.2..1`, accept only modes `dynamic|dense`, and wait for the initial load before completing activation.

- [ ] **Step 4: Implement local speech-setting commands**

Handle `fale mais rápido`, `fale mais devagar`, `velocidade normal`, `fale mais alto`, `fale mais baixo`, `troque sua voz`, `modo dinâmico`, and `modo denso`. Use rate/volume steps of `0.1`, keep pitch `0.9`, persist before short confirmation, and cycle compatible pt-BR/pt voices with wrapping.

- [ ] **Step 5: Run the suite and verify green**

Run: `node --test --test-isolation=none tests/extension.test.js`

Expected: all tests PASS.

- [ ] **Step 6: Commit Task 3**

```powershell
git add -- content.js tests/extension.test.js
git commit -m "feat: persistir perfil de voz do Jarvis"
```

### Task 4: Maintainable local intent router

**Files:**
- Modify: `content.js`
- Modify: `tests/extension.test.js`

**Interfaces:**
- Consumes: Task 3 settings handler and common `respond` callback.
- Produces: leading-Jarvis-aware `normalizeCommand(command)`, `handleSessionCommand`, `handleAssistantCommand`, `handleDateTimeCommand`, and ordered `processCommand(command, sequence)`.

- [ ] **Step 1: Add failing router tests**

Add fixed-clock tests for leading `Jarvis` with case/punctuation, greetings, `tudo bem`, identity, concise implemented-only help, all time variants, all date variants, `repita`, `pare`, session end, and fallback. Assert representative exact/structural results:

```js
assert.equal(lastSpeech(), "Sou Jarvis, um assistente de acessibilidade para ajudar você a navegar na web.");
assert.match(lastSpeech(), /^Agora são 18 horas e 32 minutos\.$/);
assert.equal(lastSpeech(), "Hoje é domingo, 4 de outubro de 2026.");
assert.equal(lastSpeech(), "Ainda não consigo executar esse comando.");
```

- [ ] **Step 2: Run the suite and verify red**

Run: `node --test --test-isolation=none tests/extension.test.js`

Expected: FAIL for new general/date/time commands and Jarvis prefix removal.

- [ ] **Step 3: Split command handling into ordered functional handlers**

Keep functions in `content.js`; do not add classes or a framework. Normalize accents, punctuation, spaces, and only a leading `Jarvis`. Invoke handlers in spec order and let each return `true` when consumed.

- [ ] **Step 4: Implement general, date, and time responses**

Use local `Date` and `Intl.DateTimeFormat("pt-BR", { weekday: "long", day: "numeric", month: "long", year: "numeric" })`. Keep help factual and short, and route every response back through Task 2’s common cycle.

- [ ] **Step 5: Run the suite and verify green**

Run: `node --test --test-isolation=none tests/extension.test.js`

Expected: all tests PASS.

- [ ] **Step 6: Commit Task 4**

```powershell
git add -- content.js tests/extension.test.js
git commit -m "feat: adicionar comandos gerais do Jarvis"
```

### Task 5: Page accessibility context, modes, and navigation

**Files:**
- Modify: `content.js`
- Modify: `tests/extension.test.js`

**Interfaces:**
- Consumes: Task 4 router and current persisted `assistantState.mode`.
- Produces: `isElementVisible(element)`, `getAccessibleName(element)`, `collectPageContext()`, `describePage(context, mode)`, `listNamedElements(kind, mode)`, `readMainContent(mode)`, `handlePageCommand`, and `handleNavigationCommand`.

- [ ] **Step 1: Add failing DOM fixture tests**

Extend the VM document/window harness with visible/hidden headings, buttons, links, fields, main text, geometry/style, scrolling, and history spies. Cover accessible-name precedence, broken `aria-labelledby`, hidden controls, unnamed controls, password non-disclosure, title/domain, empty collections, dynamic 5-item limits, dense 15-item limits, different descriptions/content lengths, and main/article/role/body priority.

```js
assert.equal(dynamicNames.length, 5);
assert.equal(denseNames.length, 15);
assert.doesNotMatch(lastSpeech(), /segredo-digitado/);
assert.ok(denseDescription.length > dynamicDescription.length);
assert.ok(denseMainText.length > dynamicMainText.length);
```

- [ ] **Step 2: Add failing navigation tests**

Assert `role/desça`, `role/suba`, `volte/voltar`, and `avance/avançar` call:

```js
assert.deepEqual(scrollCalls[0], { top: innerHeight * 0.8, behavior: "smooth" });
assert.deepEqual(scrollCalls[1], { top: innerHeight * -0.8, behavior: "smooth" });
assert.equal(history.backCount, 1);
assert.equal(history.forwardCount, 1);
```

- [ ] **Step 3: Run the suite and verify red**

Run: `node --test --test-isolation=none tests/extension.test.js`

Expected: FAIL because DOM context and navigation intents are absent.

- [ ] **Step 4: Implement visibility, naming, and collection helpers**

Follow the spec precedence: `aria-label`, valid `aria-labelledby` text, visible/associated label text, `alt`, `title`, `placeholder`, then safe `value`. Require visible geometry/style, omit empty names, and never read password values.

- [ ] **Step 5: Implement dynamic/dense page responses**

Dynamic limits: 5 named controls and 700 main-text characters. Dense limits: 15 named controls, 8 headings, and 2,000 main-text characters. Clone main content and remove `script`, `style`, `nav`, `footer`, and `noscript`; report only DOM-observable facts.

- [ ] **Step 6: Implement navigation handlers**

Scroll by `window.innerHeight * 0.8` with smooth behavior, call `history.back()`/`history.forward()`, give short confirmation, and resume through the shared cycle.

- [ ] **Step 7: Run the suite and verify green**

Run: `node --test --test-isolation=none tests/extension.test.js`

Expected: all tests PASS.

- [ ] **Step 8: Commit Task 5**

```powershell
git add -- content.js tests/extension.test.js
git commit -m "feat: adicionar contexto acessível da página"
```

### Task 6: Private Open-Meteo conversation

**Files:**
- Modify: `manifest.json`
- Modify: `background.js`
- Modify: `content.js`
- Modify: `tests/extension.test.js`

**Interfaces:**
- Consumes: Task 4 router, Task 2 activation guards, Chrome runtime messaging, and `fetch` in the service worker.
- Produces: background `fetchWeather(city): Promise<WeatherResult>`, message type `JARVIS_WEATHER_REQUEST`, content `requestWeather(city, sequence)`, `describeWeather(data)`, and in-memory `pendingIntent: null | "weatherCity"`.

- [ ] **Step 1: Add failing manifest and background weather tests**

Assert only the two approved host permissions, encoded geocoding query parameters, exact forecast fields, resolved-city normalized response, zero-value preservation, missing daily arrays, city-not-found, HTTP/network/malformed failures, and the city-only request boundary.

```js
assert.deepEqual(manifest.host_permissions, [
  "https://geocoding-api.open-meteo.com/*",
  "https://api.open-meteo.com/*",
]);
assert.deepEqual(Object.keys(receivedMessage).sort(), ["city", "type"]);
assert.equal(new URL(fetchCalls[0]).searchParams.get("name"), "São Luís");
assert.equal(result.temperature, 0);
```

- [ ] **Step 2: Add failing content weather tests**

Cover direct `tempo/clima/previsão ... em <cidade>`, question without city, `pendingIntent`, next-utterance city use, `cancelar`, city-not-found, network failure, weather-code text, absent-value omission, continued conversation, and stale responses after timeout/reactivation/end.

```js
assert.equal(state.pendingIntent, "weatherCity");
assert.equal(lastSpeech(), "De qual cidade?");
assert.deepEqual(runtimeMessages.at(-1), { type: "JARVIS_WEATHER_REQUEST", city: "Anápolis" });
assert.equal(lastSpeech(), "Não encontrei essa cidade.");
assert.equal(lastSpeech(), "Não consegui consultar o clima agora.");
```

- [ ] **Step 3: Run the suite and verify red**

Run: `node --test --test-isolation=none tests/extension.test.js`

Expected: FAIL because host permissions, weather messaging, and pending intent are absent.

- [ ] **Step 4: Implement background weather service**

Add an async runtime message handler returning `true`. Geocode with `name`, `count=1`, `language=pt`, `format=json`; forecast with current `temperature_2m,apparent_temperature,weather_code,wind_speed_10m`, daily max/min, `timezone=auto`, and `forecast_days=1`. Normalize only available fields and map every failure to `city-not-found` or `network`.

- [ ] **Step 5: Implement content weather intent**

Extract direct cities, set/clear `pendingIntent`, treat `cancelar` first, keep status `PROCESSING` during the one request, map weather codes locally, round present values, omit absent data, and ignore replies whose captured sequence is stale.

- [ ] **Step 6: Run the suite and verify green**

Run: `node --test --test-isolation=none tests/extension.test.js`

Expected: all tests PASS.

- [ ] **Step 7: Commit Task 6**

```powershell
git add -- manifest.json background.js content.js tests/extension.test.js
git commit -m "feat: adicionar clima por cidade ao Jarvis"
```

### Task 7: Documentation and release verification

**Files:**
- Modify: `README.md`
- Verify: `manifest.json`, `background.js`, `content.js`, `tests/extension.test.js`

**Interfaces:**
- Consumes: all delivered behavior from Tasks 1–6.
- Produces: user documentation, complete automated evidence, manual-validation result, final commit and pushed `origin/main`.

- [ ] **Step 1: Rewrite README for contract version 3**

Document temporary Jarvis identity, ON/LISTENING/PROCESSING/OFF meanings, first/later activation, all implemented command groups, speech preferences, dynamic/dense differences, Open-Meteo, privacy guarantees, browser SpeechRecognition caveat, limitations, loading steps, and the full 27-step manual checklist.

- [ ] **Step 2: Run required automated validation**

Run:

```powershell
node --test --test-isolation=none tests/extension.test.js
node --check content.js
node --check background.js
node -e "JSON.parse(require('node:fs').readFileSync('manifest.json','utf8')); console.log('manifest válido')"
git diff --check
```

Expected: all tests PASS, both syntax checks exit 0, `manifest válido`, and no diff-check output.

- [ ] **Step 3: Review scope and privacy diffs**

Run: `git diff -- manifest.json background.js content.js tests/extension.test.js README.md`

Expected: no dependencies, backend, Supabase changes, page-content weather payload, unrelated refactor, or `.serena/` staging.

- [ ] **Step 4: Perform manual acceptance when a browser is available**

Reload the unpacked extension and perform all 27 contract steps on an HTTP/HTTPS page. Record introduction frequency, earcon order, three continuous commands, persisted preference, dynamic/dense outputs, weather follow-up, OFF/microphone closure, reactivation, and console result. If browser/microphone validation is unavailable, record exactly `validação manual pendente`.

- [ ] **Step 5: Commit documentation and any final test-only corrections**

```powershell
git add -- README.md manifest.json background.js content.js tests/extension.test.js
git commit -m "docs: atualizar guia do Jarvis v3"
```

- [ ] **Step 6: Verify final repository state and push**

Run:

```powershell
git status --short --branch
git log -1 --format=%H
git push origin main
git ls-remote origin refs/heads/main
```

Expected: only the pre-existing untracked `.serena/` may remain; local final SHA equals remote `main` SHA.
