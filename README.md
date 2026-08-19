# Catan Copilot for colonist.io

A Firefox extension that overlays [colonist.io](https://colonist.io) with a live
strategy copilot. It reads the game log and the game's WebSocket board state as
you play and keeps up-to-date:

- **Where to build** — a mini-map of the live board with numbered gold badges on
  the exact intersections to take: initial-settlement picks during setup (the
  2nd pick biases toward resources your 1st spot lacks), expansion targets in
  the main game, and dashed segments for the next roads to lay toward spot ①.
- **Card counting** — every player's hand, tracked through rolls, builds, trades,
  discards, monopolies, and steals (unknown steals show as `±n` uncertainty).
- **Balanced-dice deck tracking** — colonist's balanced mode draws from the 36
  two-die combinations like a card deck. The overlay counts the deck down, shows
  which numbers are over-due or exhausted, and the probability your numbers hit
  the next roll.
- **Strategy advice** — it learns each player's number→resource income table from
  the log, scores four predefined strategies (Road & Expand, Cities & Development,
  Port Monopoly, Balanced), forward-simulates each with balanced dice, and
  recommends one with rationale.
- **Robber advice** — who to rob and which of their numbers to block, based on
  visible VP, income, and hand size.
- **Trade tips** — what you're one trade away from building, what to offer, and
  your best observed bank/port ratios.

It is **advice-only**: the content script never clicks, sends, or automates
anything. Check colonist.io's terms and your table's house rules before using
assistance tools in competitive games.

## Install (Firefox 128+)

1. `npm install && npm run build` (regenerates `extension/content.js` and
   `extension/inject.js`)
2. Open `about:debugging#/runtime/this-firefox`
3. Click **Load Temporary Add-on…** and pick `extension/manifest.json`
4. Open (or refresh) colonist.io **before joining a game** — the WebSocket tap
   must be in place when the game connects. The panel appears at the top right
   (drag to move, `–` to collapse). Temporary add-ons unload when Firefox
   quits; just load it again.

The manifest is MV3 and registers `inject.js` as a MAIN-world content script
at `document_start`, so the WebSocket wrap is synchronous — no injection race
with colonist's own scripts.

## How it reads the game

Two read-only channels:

1. **Game log (DOM).** Colonist renders its log as a virtual scroller of
   `[data-index]` rows. The content script sweeps existing rows in index order
   (so a mid-game refresh rebuilds full history), then follows new rows with a
   MutationObserver. Rows are parsed by icon alt text (`dice_4`, `grain`,
   `wool`, `lumber`, `settlement`, …) and text keywords ("rolled", "built a",
   "gave bank … and took", "stole … from you", …). The signed-in player comes
   from `.web-header-username`.
2. **Board state (WebSocket).** `inject.js` runs in the page world, wraps
   `window.WebSocket` before colonist connects, decodes the msgpack frames, and
   forwards board-relevant events (board description type 14, build corner 16,
   build edge 15, play order 8, player states 12) to the content script.
   Colonist's hex-face coordinates are the same axial system the engine uses,
   so tiles, ports, corners, and edges map 1:1 onto the tested board model in
   `src/engine/` — which then scores placements on the real board.

Both channels' formats follow open-source colonist tooling — see Sources.
If the extension is loaded mid-game the board frame has already passed;
refresh the page and colonist resends it. The overlay says so when the board
is missing, and all log-based features keep working without it.

## Layout

```
extension/            manifest (MV2) + built content.js and inject.js bundles
src/extension/
  content.ts          bootstrap: find log, sweep history, observe new rows,
                      receive board events from the page tap
  inject.ts           page-world WebSocket tap (read-only) -> postMessage
  msgpack.ts          minimal MessagePack decoder
  boardBridge.ts      colonist board/build payloads -> engine Board/GameState
  placement.ts        where-to-build advice + mini-map SVG renderer
  logParser.ts        DOM row -> typed GameEvent
  tracker.ts          GameEvent stream -> per-player state + income tables
  copilot.ts          deck tracking, strategy ranking, board-free simulation,
                      robber + trade advice
  overlay.ts          the injected panel (vanilla DOM, light/dark)
src/engine/           board-aware engine (generation, analysis, strategies,
                      balanced-dice simulation) — scores placement on the
                      real captured board
scripts/smoke.mjs     end-to-end check: built bundle vs. a fake colonist page,
                      including simulated board WebSocket events
```

`npm test` runs 52 unit tests (engine, parser/tracker/copilot/overlay,
msgpack/bridge/placement); `node scripts/smoke.mjs` runs the built bundle
against a synthetic page.

The overlay's resource colors were validated for color-vision-deficiency
separation and contrast in both light and dark mode with a palette validator;
every colored mark is also direct-labeled, so color never carries meaning alone.

## Autopilot status (experimental)

The goal of playing moves automatically needs colonist's **outbound** action
message formats, which aren't documented anywhere public. The plumbing is in
place:

- `inject.js` captures decoded frames in BOTH directions and can **send**
  frames to the live game socket (`__catan_copilot_send__` channel, msgpack
  encoder included).
- The overlay's "Autopilot groundwork" section shows the capture counter and a
  download button. Play one full game manually, download the capture, and the
  outbound frames in it (each logged next to the action you took) give the
  exact templates for build/roll/trade/end-turn messages.

Caution before enabling any auto-play: automating moves almost certainly
violates colonist.io's terms and can get an account banned — use it against
colonist's AI bots or in private games with consenting friends, not against
strangers.

## Sources

Colonist.io DOM structure and log-message taxonomy per these open-source
projects and references:

- [nickincardone/catan-counter](https://github.com/nickincardone/catan-counter)
- [movcmpret/colonist-enhancer](https://github.com/movcmpret/colonist-enhancer)
- [glasperfan/explorer](https://github.com/glasperfan/explorer)
- [Elijah-Adams/colonist-extension](https://github.com/Elijah-Adams/colonist-extension)
- [Reverse engineering games for fun and SSRF](https://www.nc-lp.com/blog/reverse-engineering-games-for-fun-and-ssrf-part-1)
