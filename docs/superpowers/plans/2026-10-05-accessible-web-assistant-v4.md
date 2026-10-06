# Accessible Web Assistant v4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add tolerant silent navigation, live structured page context, and local YouTube video/channel/Shorts/search control without regressing contract version 3.

**Architecture:** Keep the existing functional `content.js` architecture. Add grouped context, YouTube, matching, pending-intent, search, and silent-action helpers around the existing state/router; extend the deterministic VM/DOM harness in `tests/extension.test.js`. Do not add production files or permissions.

**Tech Stack:** Chrome Extension Manifest V3, plain JavaScript, Web Speech API, Web Audio API, DOM APIs, Chrome storage/messaging APIs, Node.js built-in test runner and `vm` mocks.

**Spec:** `docs/superpowers/specs/2026-10-05-accessible-web-assistant-v4-design.md`

## Global Constraints

- Work only on branch `main`; do not create a branch or worktree.
- Preserve all contract-version-3 behavior and its 93 passing tests.
- Do not add classes, frameworks, dependencies, backend, database, Supabase, OCR, vision, LLM, or permanent wake word.
- Successful actions must not call `speak()`; existing PROCESSING and LISTENING earcons remain.
- Use only local DOM data. Persist no media elements, lists, queries, candidates, or navigation context.
- Keep generic Dynamic/Dense limits; never limit YouTube video or Shorts lists by mode.
- Recalculate page context for commands that depend on live YouTube DOM.
- Keep one recognition instance and the existing guarded `resumeListening(sequence)` path.
- Do not alter `.serena/`, `background.js`, `manifest.json`, Supabase, or Open-Meteo behavior.

## File Structure

- Modify `content.js`: state, normalization, silent actions, live context, YouTube extraction/matching, channels, Shorts, search, and routing.
- Modify `tests/extension.test.js`: richer DOM/action/form fixtures and all v4 behavior tests.
- Modify `README.md`: document only v4 aliases and page-action capabilities.
- Verify `background.js` and `manifest.json`; no planned production changes.

## Review Focus

- A cached media element detached by a YouTube SPA update must trigger context recalculation, not a stale click; Task 3 owns this test.
- A silent click that unloads the document must not reopen recognition, while a same-document action must reopen it exactly once; Task 1 owns this test.
- Search inputs controlled by framework setters must receive the native setter plus bubbling `input`/`change`, without duplicate submission; Task 6 owns this test.
- Duplicate/near-equal titles and empty filler-only queries must not cause arbitrary clicks; Task 4 owns these tests.
- Non-YouTube pages containing `/watch` links must retain generic behavior and no YouTube commands; Task 2 owns this test.

---

### Task 1: Silent navigation foundation

**Files:**
- Modify: `content.js`
- Test: `tests/extension.test.js`

**Interfaces:**
- Consumes: existing `activationSequence`, `scheduleSessionTimeout()`, `resumeListening(sequence)`, navigation APIs, and PROCESSING lifecycle.
- Produces: underscore-aware `normalizeCommand(command)`, `performSilentAction(action, sequence, errorText?)`, and silent `handleNavigationCommand(command, sequence): boolean`.

- [ ] **Step 1: Add failing alias and silence tests**

Cover every approved down/up alias, underscore equivalence, back/forward, zero confirmation utterances, refreshed timeout, one LISTENING continuation, no duplicate recognition, action exceptions, unload simulation, and stale sequence.

```js
assert.deepEqual(scrollCalls.at(-1), { top: innerHeight * 0.8, behavior: "smooth" });
assert.equal(spoken.length, spokenBeforeAction);
assert.equal(FakeRecognition.instances.length, before + 1);
```

- [ ] **Step 2: Run focused tests and verify red**

Run: `node --test --test-isolation=none --test-name-pattern="ação silenciosa|alias de scroll|histórico silencioso" tests/extension.test.js`

Expected: FAIL because current aliases are limited and actions speak confirmations.

- [ ] **Step 3: Implement normalization and `performSilentAction`**

Replace underscores with spaces before punctuation normalization. Implement `performSilentAction(action, sequence, errorText?)` with active-sequence guard, action execution, timeout refresh, zero-delay guarded listening continuation, and spoken feedback only on exception.

- [ ] **Step 4: Convert scroll/history commands to silent actions**

Map exact approved aliases to ±`window.innerHeight * 0.8`; keep smooth scrolling and history calls. Remove `respond("Rolando…")`, `respond("Voltando…")`, and `respond("Avançando…")`.

- [ ] **Step 5: Run full suite and verify green**

Run: `node --test --test-isolation=none tests/extension.test.js`

Expected: all existing and Task 1 tests PASS.

- [ ] **Step 6: Commit Task 1**

```powershell
git add -- content.js tests/extension.test.js
git commit -m "feat: tornar navegação local silenciosa"
```

### Task 2: Live structured YouTube context

**Files:**
- Modify: `content.js`
- Modify: `tests/extension.test.js`

**Interfaces:**
- Consumes: existing visibility/accessibility helpers and generic `collectPageContext()`.
- Produces: `isYouTubeHost(hostname)`, `getElementHref(element)`, `findYouTubeCard(element)`, `collectYouTubeContext()`, `findSearchControl()`, and extended `collectPageContext()` fields `focusableElements`, `videos`, `shorts`, `channels`, `searchControl`.

- [ ] **Step 1: Expand DOM harness and add failing extraction tests**

Add clickable elements, `closest`, connectivity, href resolution, forms, labels, roles, parent cards, hostname variants, and stable DOM ordering. Test multiple video/channel/Shorts signals, visibility, accessible-name fallback, deduplication, associated channel/card text, focusable elements, search control, generic context preservation, and non-YouTube isolation.

```js
assert.deepEqual(context.videos.map(({ title }) => title), ["FE!N", "Like That"]);
assert.equal(context.videos[0].channel, "Travis Scott");
assert.equal(context.videos[0].element, watchLink);
assert.deepEqual(nonYouTubeContext.videos, []);
```

- [ ] **Step 2: Run focused tests and verify red**

Run: `node --test --test-isolation=none --test-name-pattern="contexto YouTube|contexto genérico v4|controle de pesquisa" tests/extension.test.js`

Expected: FAIL because specialized fields and helpers do not exist.

- [ ] **Step 3: Implement host detection and grouped extraction helpers**

Activate only for `youtube.com` and `.youtube.com` subdomains. Extract visible `/watch`, `/shorts/`, `/@`, `/channel/`, and `/c/` links in DOM order using accessible name, title, visible/card text, and nearby channel links. Deduplicate by href with title fallback.

- [ ] **Step 4: Extend generic context without changing existing outputs**

Add focusable controls and generic/YouTube search detection. Return empty specialized collections outside YouTube. Keep existing fields, visibility, password protection, and mode consumers unchanged.

- [ ] **Step 5: Run full suite and verify green**

Run: `node --test --test-isolation=none tests/extension.test.js`

Expected: all tests PASS.

- [ ] **Step 6: Commit Task 2**

```powershell
git add -- content.js tests/extension.test.js
git commit -m "feat: coletar contexto estruturado do YouTube"
```

### Task 3: Video listing and indexed opening

**Files:**
- Modify: `content.js`
- Modify: `tests/extension.test.js`

**Interfaces:**
- Consumes: Task 1 `performSilentAction`, Task 2 live `videos`, existing responder.
- Produces: `formatMediaList(kind, items)`, `parseMediaIndex(command, kind)`, `getCurrentMediaList(kind)`, `openMediaByIndex(kind, index, sequence, respond)`, plus temporary `lastVideoList`, `lastShortList`, `lastSelectedMedia`.

- [ ] **Step 1: Add failing video list/index tests**

Cover every listing phrase, all items in Dynamic/Dense, stable numbering, cached-list reuse, disconnected-element recalculation, `vídeo 1`, `vídeo número 2`, `terceiro vídeo`, contextual suffixes, invalid index copy, silent click, selected-media state, unload and same-document continuation.

```js
assert.match(lastSpeech(), /Vídeo 1: FE!N/);
assert.match(lastSpeech(), /Vídeo 18:/);
assert.equal(videoLinks[1].clickCount, 1);
assert.equal(spoken.length, spokenBeforeOpen);
```

- [ ] **Step 2: Run focused tests and verify red**

Run: `node --test --test-isolation=none --test-name-pattern="listar vídeos|vídeo por índice|lista desconectada" tests/extension.test.js`

Expected: FAIL because video intents and session lists are absent.

- [ ] **Step 3: Implement unlimited list formatting and state**

Format every detected video with exact collection numbering and optional channel. Store the exact ordered list. Clear media state on activation, timeout, and end.

- [ ] **Step 4: Implement index/ordinal parsing and opening**

Support explicit numbers and first/second/third variants. Prefer a connected cached target, otherwise rebuild context. Click valid targets through Task 1; speak `Não encontrei o vídeo N nesta página.` for invalid indexes.

- [ ] **Step 5: Run full suite and verify green**

Run: `node --test --test-isolation=none tests/extension.test.js`

Expected: all tests PASS.

- [ ] **Step 6: Commit Task 3**

```powershell
git add -- content.js tests/extension.test.js
git commit -m "feat: listar e abrir vídeos por índice"
```

### Task 4: Local matching, disambiguation, and channels

**Files:**
- Modify: `content.js`
- Modify: `tests/extension.test.js`

**Interfaces:**
- Consumes: Task 2 media/channel context, Task 3 selected-media state, Task 1 silent actions.
- Produces: `normalizeMatchText(text)`, `extractMediaQuery(command, kind)`, `scoreCandidate(candidate, query)`, `rankCandidates(candidates, query)`, `openBestMatch`, `askMediaChoice`, `resolveMediaChoice`, `handleChannelCommand`, and `pendingCandidates`.

- [ ] **Step 1: Add failing scoring and query tests**

Cover filler removal (`abrir`, `abre`, `acessar`, `acesse`, articles/prepositions, and the media noun), empty query, `FE!N`, exact/full-title/token scoring, channel terms, every approved characteristic, clear 10-point lead, ties within 9, duplicate exact titles, and no zero-score clicks.

```js
assert.equal(normalizeMatchText("FE!N"), "fein");
assert.equal(rankCandidates(candidates, "fein official").winner.title, "FE!N Official Video");
assert.equal(ambiguous.pending, true);
```

- [ ] **Step 2: Add failing ambiguity and channel tests**

Cover option speech with original indexes, `o oficial`, `o ao vivo`, `vídeo 5`, `o segundo`, repeated ambiguity, cancellation, state clearing, channel-name/handle matching, channel/video separation, last-selected video channel, and `Qual vídeo?`.

- [ ] **Step 3: Run focused tests and verify red**

Run: `node --test --test-isolation=none --test-name-pattern="matching local|desambiguação|canal YouTube" tests/extension.test.js`

Expected: FAIL because scoring, pending choices, and channel intents are absent.

- [ ] **Step 4: Implement deterministic scoring and command extraction**

Use exact spec weights: exact title 100, complete query in title 40, token weights 12/8/5, characteristic bonus 8. Deduplicate field tokens. Declare a winner only for one candidate, one unique exact-title match, or a lead of at least 10. Keep duplicate exact titles ambiguous.

- [ ] **Step 5: Implement ambiguity and channel flows**

Store at most three candidates within 9 points, including original indexes. Resolve indexes, candidate ordinals, and characteristics; click unique results silently. Match channel commands only against channel items. Use `lastSelectedMedia.channelElement` for `canal desse vídeo`.

- [ ] **Step 6: Run full suite and verify green**

Run: `node --test --test-isolation=none tests/extension.test.js`

Expected: all tests PASS.

- [ ] **Step 7: Commit Task 4**

```powershell
git add -- content.js tests/extension.test.js
git commit -m "feat: abrir mídia e canais por correspondência"
```

### Task 5: Shorts navigation and selection

**Files:**
- Modify: `content.js`
- Modify: `tests/extension.test.js`

**Interfaces:**
- Consumes: Tasks 1–4 action, list, index, and matching helpers.
- Produces: `findShortsNavigation(context)`, `handleShortsCommand(command, sequence, respond)`.

- [ ] **Step 1: Add failing Shorts tests**

Cover every area-navigation phrase, preferred `/shorts` link, silent click, missing navigation error, all list phrases, unlimited lists in both modes, cached list, explicit/ordinal index, text matching, ambiguity, and no collision between bare `shorts` and named selection.

```js
assert.equal(shortsNavigation.clickCount, 1);
assert.match(lastSpeech(), /Short 12:/);
assert.equal(shortLinks[1].clickCount, 1);
```

- [ ] **Step 2: Run focused tests and verify red**

Run: `node --test --test-isolation=none --test-name-pattern="Shorts" tests/extension.test.js`

Expected: FAIL because Shorts commands are not routed.

- [ ] **Step 3: Implement Shorts intents by reusing media helpers**

Route bare area commands first. Reuse unlimited list, connected cache, index parser, scoring, ambiguity, and silent actions with Short-specific labels and errors.

- [ ] **Step 4: Run full suite and verify green**

Run: `node --test --test-isolation=none tests/extension.test.js`

Expected: all tests PASS.

- [ ] **Step 5: Commit Task 5**

```powershell
git add -- content.js tests/extension.test.js
git commit -m "feat: navegar e selecionar Shorts"
```

### Task 6: Search control and router integration

**Files:**
- Modify: `content.js`
- Modify: `tests/extension.test.js`

**Interfaces:**
- Consumes: Task 2 `searchControl`, Task 1 silent action, Tasks 3–5 handlers, existing weather/settings/general/page handlers.
- Produces: `setNativeInputValue(input, value)`, `submitSearch(control, query)`, `handleSearchCommand(command, original, sequence, respond)`, and final ordered `processCommand` routing.

- [ ] **Step 1: Add failing search tests**

Cover every focus alias, zero speech, focus count, direct verbs/query extraction, preserved accents, prototype-native setter, bubbling `input` and `change`, `requestSubmit`, `submit`, button fallback, exactly one mechanism, missing input/mechanism error, bare verb prompt, pending query, cancellation, reactivation clearing, and duplicate-listening protection.

```js
assert.equal(searchInput.focusCount, 1);
assert.deepEqual(searchInput.events, ["input", "change"]);
assert.equal(form.requestSubmitCount, 1);
assert.equal(spoken.length, spokenBeforeSearch);
```

- [ ] **Step 2: Add failing routing collision tests**

Assert `cima`, `vídeo 2`, `canal do Future`, `short 1`, and `pesquisar Future DS2` reach their intended handlers; pending intents, end, and cancel retain priority; generic page/weather/settings behavior remains reachable.

- [ ] **Step 3: Run focused tests and verify red**

Run: `node --test --test-isolation=none --test-name-pattern="pesquisa v4|roteamento v4" tests/extension.test.js`

Expected: FAIL because search actions and final priority order are absent.

- [ ] **Step 4: Implement focus and direct submission**

Set values through the native prototype descriptor when available, dispatch bubbling `input` then `change`, and choose one submission mechanism in order: `requestSubmit`, `submit`, button click. Focus-only commands need no submission mechanism.

- [ ] **Step 5: Implement two-step search and final router order**

Bare verbs ask `O que você quer pesquisar?` and set `searchQuery`; the next nonempty utterance submits and clears it. Apply spec routing order: session/pending, navigation, search, YouTube, settings, general, date/time, weather, generic page, fallback.

- [ ] **Step 6: Run full suite and verify green**

Run: `node --test --test-isolation=none tests/extension.test.js`

Expected: all tests PASS with no duplicate recognition or speech on successful actions.

- [ ] **Step 7: Commit Task 6**

```powershell
git add -- content.js tests/extension.test.js
git commit -m "feat: controlar pesquisa e roteamento da página"
```

### Task 7: Documentation and release validation

**Files:**
- Modify: `README.md`
- Verify: `content.js`, `background.js`, `manifest.json`, `tests/extension.test.js`

**Interfaces:**
- Consumes: all Tasks 1–6 behavior.
- Produces: accurate v4 documentation, validation evidence, final commit, and pushed `origin/main`.

- [ ] **Step 1: Update README only for v4 behavior**

Document scroll aliases, silent successful actions, unlimited video/Short lists, opening by index/name/features, channel flows, selected-video channel, Shorts area, search focus/direct/two-step, ambiguity, and error-only speech. Preserve v3 privacy/limitations.

- [ ] **Step 2: Run required automated validation**

Run:

```powershell
node --test --test-isolation=none tests/extension.test.js
node --check content.js
node --check background.js
node -e "JSON.parse(require('node:fs').readFileSync('manifest.json','utf8')); console.log('manifest válido')"
git diff --check
```

Expected: all tests PASS; both syntax checks exit 0; manifest prints `manifest válido`; diff check has no errors.

- [ ] **Step 3: Review scope and privacy**

Run: `git log --name-only --format= 8c48402..HEAD`

Expected: only design/plan docs plus `README.md`, `content.js`, and `tests/extension.test.js`; no background, manifest, permissions, network, persistent storage, dependency, or Supabase changes.

- [ ] **Step 4: Run manual YouTube acceptance when available**

Perform all 31 approved steps in a real Chrome/Edge session. If interactive browser/microphone control is unavailable, record exactly `validação manual pendente`.

- [ ] **Step 5: Commit documentation**

```powershell
git add -- README.md
git commit -m "docs: atualizar comandos de navegação v4"
```

- [ ] **Step 6: Verify final state and push after review**

Run:

```powershell
git status --short --branch
git log -1 --format=%H
git push origin main
git ls-remote origin refs/heads/main
```

Expected: clean tracked worktree; local final SHA equals remote `main` SHA.
