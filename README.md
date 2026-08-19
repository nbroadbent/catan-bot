# Catan Copilot for colonist.io

A Firefox extension that overlays [colonist.io](https://colonist.io) with a live
strategy copilot. It reads the game log as you play and keeps up-to-date:

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

## Install (Firefox)

1. `npm install && npm run build` (regenerates `extension/content.js`)
2. Open `about:debugging#/runtime/this-firefox`
3. Click **Load Temporary Add-on…** and pick `extension/manifest.json`
4. Open a game on colonist.io — the panel appears at the top right (drag to
   move, `–` to collapse). Temporary add-ons unload when Firefox quits; just
   load it again.

## How it reads the game

Colonist renders its log as a virtual scroller of `[data-index]` rows. The
content script sweeps existing rows in index order (so a mid-game refresh
rebuilds full history), then follows new rows with a MutationObserver. Rows are
parsed by icon alt text (`dice_4`, `grain`, `wool`, `lumber`, `settlement`, …)
and text keywords ("rolled", "built a", "gave bank … and took", "stole … from
you", …). The signed-in player comes from `.web-header-username`. This message
taxonomy follows the approach proven by open-source colonist card counters —
see Sources below.

The log never exposes board coordinates, so the overlay does not give
settlement-placement advice yet. Instead it learns what each number pays each
player — which is exactly the input the strategy engine needs. A full
board-geometry engine (standard 19-hex topology, scored placement, scarcity
weighting) already lives in `src/engine/` with tests, ready for a future
board-capture step (e.g. decoding colonist's WebSocket state).

## Layout

```
extension/            manifest (MV2) + built content.js bundle
src/extension/
  content.ts          bootstrap: find log, sweep history, observe new rows
  logParser.ts        DOM row -> typed GameEvent
  tracker.ts          GameEvent stream -> per-player state + income tables
  copilot.ts          deck tracking, strategy ranking, board-free simulation,
                      robber + trade advice
  overlay.ts          the injected panel (vanilla DOM, light/dark)
src/engine/           board-aware engine (generation, analysis, strategies,
                      balanced-dice simulation) — tested, used by copilot.ts
scripts/smoke.mjs     end-to-end check: built bundle vs. a fake colonist page
```

`npm test` runs 41 unit tests (engine + parser/tracker/copilot/overlay);
`node scripts/smoke.mjs` runs the built bundle against a synthetic page.

The overlay's resource colors were validated for color-vision-deficiency
separation and contrast in both light and dark mode with a palette validator;
every colored mark is also direct-labeled, so color never carries meaning alone.

## Sources

Colonist.io DOM structure and log-message taxonomy per these open-source
projects and references:

- [nickincardone/catan-counter](https://github.com/nickincardone/catan-counter)
- [movcmpret/colonist-enhancer](https://github.com/movcmpret/colonist-enhancer)
- [glasperfan/explorer](https://github.com/glasperfan/explorer)
- [Elijah-Adams/colonist-extension](https://github.com/Elijah-Adams/colonist-extension)
- [Reverse engineering games for fun and SSRF](https://www.nc-lp.com/blog/reverse-engineering-games-for-fun-and-ssrf-part-1)
