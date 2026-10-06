# Accessible Web Assistant v4 Design

**Feature key:** `accessible_web_assistant_mvp`  
**Contract version:** `4`  
**Status:** Design ready for written review  
**Base commit:** `6fae629bbacff00a02166216cda5c58289c0877e`

## Purpose

Extend the existing Jarvis browser assistant with fast, tolerant, silent page actions and specialized YouTube navigation. Preserve every contract-version-3 behavior: guarded continuous conversation, sound sequencing, voice preferences, weather, generic page context, accessibility protections, modes, timeout, and stale-callback invalidation.

This contract remains local. It adds no LLM, backend, database, Supabase, OCR, computer vision, permanent wake word, or broad permission.

## Architecture

Keep the existing Manifest V3 structure and functional style.

- `content.js` remains the single production owner of page state, recognition sequencing, command routing, DOM context, matching, and local actions.
- YouTube selectors and extraction rules live together near the page-context helpers. They are not spread through command handlers.
- `background.js` and `manifest.json` require no functional change.
- `tests/extension.test.js` expands the existing deterministic VM/DOM harness.
- `README.md` receives only the documentation required for new aliases and capabilities.

No classes, external libraries, build step, or generalized command framework will be introduced.

## State

Extend `assistantState` only with temporary values:

```js
{
  lastVideoList: [],
  lastShortList: [],
  lastSelectedMedia: null,
  pendingCandidates: []
}
```

`pendingIntent` may be `null`, `"weatherCity"`, `"searchQuery"`, or `"mediaChoice"`.

Media items contain title/name, channel, complementary text, href, and a DOM element reference. Candidate choices also retain their original collection index. These values remain in memory and are cleared on activation, timeout, and session end. They are never written to storage.

## Normalization

The existing normalization continues to remove accents, punctuation, repeated spaces, case distinctions, and a leading `Jarvis` token. Before punctuation removal, underscores become spaces so `scroll_down` and `scroll_up` behave like spoken phrases.

Media matching uses a separate normalized searchable string assembled from title, channel, complementary card text, and href. Punctuation and styling do not distinguish terms, so `FE!N` matches `fein`.

## Silent Actions

Add `performSilentAction(action, sequence)` as the only helper for successful local actions that require no spoken confirmation.

It:

1. verifies the active session and activation sequence;
2. executes the supplied action;
3. refreshes the 30-second session timeout;
4. schedules a zero-delay continuation;
5. calls the existing guarded `resumeListening(sequence)` only if the same document/session remains active.

The existing PROCESSING earcon remains part of recognition. Successful actions do not call `speak()`. Errors, missing elements, incomplete commands, ambiguity, and requested listings still use speech.

Scroll, history, link activation, Shorts navigation, search focus, and successful search submission use this helper. A normal document navigation cancels the scheduled continuation by unloading the content script; a same-document/SPA action returns to LISTENING.

## Local Navigation

Normalize these aliases to one of two intents:

- down: `scroll_down`, `scroll down`, `descer para baixo`, `descer pra baixo`, `descer`, `desce`, `pra baixo`, `para baixo`, `baixo`, `vai pra baixo`;
- up: `scroll_up`, `scroll up`, `subir para cima`, `subir pra cima`, `subir`, `sobe`, `pra cima`, `para cima`, `cima`, `em cima`, `vai pra cima`.

Scroll uses `window.scrollBy({ top: window.innerHeight * 0.8, behavior: "smooth" })`, negated for up. `volte`/`voltar` call `history.back()`. `avance`/`avançar`/`avancar` call `history.forward()`. All successful actions are silent.

## Structured Page Context

`collectPageContext()` keeps title, domain, headings, buttons, links, fields, and main content. It adds:

- `focusableElements`;
- `videos`;
- `shorts`;
- `channels`;
- `searchControl`.

The generic visibility, accessible-name order, password protection, and main-content behavior remain unchanged. Specialized collections retain references to clickable/focusable DOM elements.

Context is recalculated for every command that depends on live page structure. Cached media lists are used only when their target elements remain connected to the current document; otherwise the context is rebuilt. This supports YouTube SPA updates without observers or persistent DOM snapshots.

## YouTube Detection and Extraction

YouTube specialization is active only when `location.hostname` is `youtube.com` or a subdomain ending in `.youtube.com`.

Extraction uses multiple signals in DOM order:

- videos: visible links whose href contains `/watch`, with title from accessible name, title attributes, or nearby card text;
- Shorts: visible links whose href contains `/shorts/`;
- channels: visible links whose href represents `/@handle`, `/channel/`, or `/c/`;
- cards: nearby ancestors provide complementary text and an associated channel when available;
- Shorts navigation: prefer a visible named link representing the Shorts area.

Items are deduplicated by normalized absolute/relative href, with title fallback when href is unavailable. The first DOM occurrence wins, preserving stable numbering. No single selector is the sole extraction path.

## Video and Shorts Lists

Listing commands speak every detected item, independent of Dynamic/Dense limits:

```text
Vídeo 1: <title>. Canal: <channel>.
Vídeo 2: <title>.
```

Shorts use `Short 1`, `Short 2`, and so on. Empty collections produce a short explicit error. The exact ordered collection used for speech becomes `lastVideoList` or `lastShortList`.

Generic button/link/field/description limits remain 5 in Dynamic mode and 15 in Dense mode.

## Index Selection

Recognize explicit integers and simple ordinals `primeiro`, `segundo`, and `terceiro`. Phrases may include `abrir`, `abre`, `acessar`, `acesse`, `número`, and contextual suffixes such as `da página inicial`.

Selection order:

1. use the last spoken list if the indexed element is still connected;
2. otherwise rebuild the current context and use its current collection.

A valid target is clicked silently and stored as `lastSelectedMedia`. An invalid index speaks `Não encontrei o vídeo N nesta página.` or the equivalent for a Short.

## Text Matching

Command extraction removes action/media filler while retaining the distinctive query. Matching stays local and deterministic.

Each candidate receives:

- 100 points for exact normalized title;
- 40 points when the complete query occurs in the title;
- 12 points per query token in the title;
- 8 points per query token in the channel;
- 5 points per query token in complementary text/href;
- 8 bonus points for each requested characteristic found: `official/oficial`, `live/ao vivo`, `lyrics/letra`, `audio`, `visualizer`, `remix`, `music video/clipe`, `shorts/short`.

Repeated tokens score once per field. Candidates with zero score are ignored.

A candidate is clearly better when it has the highest score and either is the only candidate, has an exact-title match, or leads the second candidate by at least 10 points. Otherwise, the top candidates within 9 points of the best score are ambiguous. At most three relevant choices are spoken.

## Disambiguation

Ambiguity speaks a short numbered choice message and sets:

```js
assistantState.pendingIntent = "mediaChoice";
assistantState.pendingCandidates = [/* scored candidates with source indexes */];
```

The next utterance may choose:

- the displayed original index: `vídeo 5`;
- the candidate position: `o segundo`;
- a distinguishing characteristic: `o oficial`, `o ao vivo`;
- `cancelar`.

The resolver filters/rescores only pending candidates. A unique result opens silently. Continued ambiguity asks again with the reduced choices. Success, cancellation, reactivation, timeout, or end clears both pending fields.

## Channels

Channel commands extract a name after phrases such as `abrir canal`, `acessar o canal do`, `ir para o canal`, and `canal do`. They match only the channel collection, never video-title matches. Name, handle, href, and nearby context participate in scoring.

A clear channel match clicks silently. Ambiguous channel matches use the same pending candidate mechanism.

`abrir/ir para/canal desse vídeo` uses the channel element associated with `lastSelectedMedia`. Listing multiple videos alone does not create an unambiguous selected video. If no selected video/channel exists, Jarvis says `Qual vídeo?`.

## Shorts

A bare Shorts navigation command (`shorts`, `abrir/acessar/ir para/vá para shorts`) activates the visible Shorts-area link silently.

List commands collect every visible Short without mode limits. Index and text selection reuse video parsing/matching with the Shorts collection and Short-specific error text.

## Search Control

Search detection considers:

- `input[type="search"]`;
- `[role="searchbox"]`;
- inputs whose accessible name contains `pesquisa`, `pesquisar`, `busca`, or `search`;
- YouTube search structures when generic signals are insufficient.

The context stores the input element, closest form when present, and a related visible submit button when found.

`barra de pesquisa` and its aliases focus the input silently.

Direct search removes the leading verb (`pesquisar`, `buscar`, `procure`, `procura`) and uses the remaining original-text query. It:

1. focuses the control;
2. sets its value through the native prototype setter when available;
3. dispatches bubbling `input` and `change` events;
4. prefers `form.requestSubmit()` or `form.submit()`;
5. otherwise clicks the associated search button.

No URL is constructed manually. If no control or submission mechanism exists, Jarvis says `Não encontrei a barra de pesquisa.`

A bare search verb asks `O que você quer pesquisar?`, sets `pendingIntent = "searchQuery"`, and executes the next nonempty utterance as the query. `cancelar` clears it.

## Routing

The command order is:

1. end/cancel and pending-intent resolution;
2. silent scroll/history navigation;
3. search focus/direct search;
4. YouTube videos, channels, and Shorts;
5. voice/mode settings;
6. assistant/general commands;
7. date/time;
8. weather;
9. generic page context;
10. unsupported fallback.

This ensures `vídeo 2`, `canal do Future`, `short 1`, and `cima` do not reach fallback or collide with generic page commands.

## Error Handling

- Missing indexed item: short collection-specific response.
- No matching media/channel: short not-found response containing the requested name when useful.
- Ambiguity: list only relevant alternatives and wait.
- Missing search control/submission: `Não encontrei a barra de pesquisa.`
- No context for `canal desse vídeo`: `Qual vídeo?`
- A click/focus/submission exception: speak a short failure message, keep the session active, and return through LISTENING.

Successful actions remain silent.

## Testing

Retain all contract-version-3 tests. Expand the harness with connected/clickable media elements, forms, native-value behavior, events, submit buttons, hostname variants, and action-timer control.

Add coverage for:

- every scroll alias, underscore normalization, direction, silence, timeout refresh, and one listening continuation;
- silent back/forward;
- generic context, hidden-element filtering, password protection, and existing mode limits;
- YouTube detection from multiple href/name/card signals, stable deduplication, and SPA recalculation;
- unlimited video/Short listing and stable numbering;
- index and ordinal opening, stale cached lists, invalid indexes;
- punctuation-insensitive title matching, channel/feature scoring, clear winner, ambiguity, and follow-up resolution;
- channel-only matching and selected-video channel navigation;
- Shorts area, lists, index, and name actions;
- search focus, direct query, native setter, input/change events, form/button submission, two-step search, cancellation, and missing control;
- no TTS on successful actions, no duplicate recognition, timeout/stale-callback guards.

Required validation remains:

```powershell
node --test --test-isolation=none tests/extension.test.js
node --check content.js
node --check background.js
node -e "JSON.parse(require('node:fs').readFileSync('manifest.json','utf8')); console.log('manifest válido')"
git diff --check
```

## Documentation and Manual Acceptance

Update README only for scroll aliases, silent actions, media/channel/Shorts listing and opening, search, and disambiguation.

Run the approved YouTube manual checklist in a real interactive browser when available. Otherwise report exactly `validação manual pendente`.
