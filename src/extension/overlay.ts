import { Resource } from "../engine/types";
import {
  DeckStatus,
  LiveStrategyFit,
  LiveTradeTip,
  MoveAction,
  PlacementFacts,
  deckStatus,
  expectedProduction,
  isOneVsOne,
  nextMoves,
  productionTotal,
  rankLiveStrategies,
  robberAdvice,
  tradeTips,
} from "./copilot";
import { TrackerState, handTotal, visibleVp } from "./tracker";
import {
  PlacementAdvice,
  advisePlacement,
  placementFacts,
  renderMiniMap,
} from "./placement";
import { Board, GameState, PlayerId } from "../engine/types";
import { AutopilotView } from "./autopilot";
import { RushView } from "./rush/rushPilot";
import { RushPref } from "./rush/rushMode";
import { loadRecords, recordStats, strategyPriors } from "./learning";
import { VERSION } from "./version";

/** The board view the overlay needs — satisfied by StateBridge. */
export interface BoardView {
  board: Board | null;
  toGameState(): { state: GameState; youPlayer: PlayerId | null } | null;
  buildings: Array<{ vertexId: number; colorId: number; kind: "settlement" | "city" }>;
  roads: Array<{ edgeId: number; colorId: number }>;
}

/* Palette validated with the dataviz six-checks validator in both modes
   (light surface #fcfcfb, dark #1a1a19). Resource display order:
   brick, wheat, sheep, ore, wood. Every colored mark is direct-labeled. */
const CSS = `
#catan-copilot {
  --surface: #fcfcfb; --ink: #0b0b0b; --ink-2: #52514e; --ink-3: #898781;
  --hairline: #e1e0d9; --accent: #4a3aa7; --bar: #2a78d6;
  --brick: #b5432a; --wheat: #e2a41a; --sheep: #58b47a; --ore: #4f6bb0; --wood: #268c46;
  --desert: #d8cba0; --gold: #b8860b;
  position: fixed; top: 70px; right: 12px; width: 320px; max-height: 82vh;
  z-index: 2147483000; background: var(--surface); color: var(--ink);
  border: 1px solid var(--hairline); border-radius: 10px;
  box-shadow: 0 6px 24px rgba(0,0,0,0.25);
  font: 12px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
  display: flex; flex-direction: column;
}
@media (prefers-color-scheme: dark) {
  #catan-copilot {
    --surface: #1a1a19; --ink: #ffffff; --ink-2: #c3c2b7; --ink-3: #898781;
    --hairline: #2c2c2a; --accent: #9085e9; --bar: #3987e5;
    --brick: #df6350; --wheat: #8d610b; --sheep: #47a76b; --ore: #6f89cc; --wood: #2f9e55;
    --desert: #55503e; --gold: #d4a017;
  }
}
/* Docked: a full-height column on the right edge; the page is narrowed by
   the same width (html.cc-docked-page) so the game sits BESIDE the panel
   instead of underneath it. */
#catan-copilot.cc-docked {
  top: 0 !important; right: 0 !important; left: auto !important; bottom: 0;
  width: var(--cc-dock-w); height: 100vh; max-height: 100vh;
  border-radius: 0; border-width: 0 0 0 1px; box-shadow: -4px 0 18px rgba(0,0,0,.18);
}
#catan-copilot.cc-docked header { cursor: default; }
html.cc-docked-page {
  width: calc(100% - var(--cc-dock-w)) !important;
  overflow-x: hidden;
}
#catan-copilot header {
  display: flex; align-items: center; gap: 8px; padding: 8px 12px;
  border-bottom: 1px solid var(--hairline); cursor: grab; user-select: none;
}
#catan-copilot header strong { font-size: 13px; }
#catan-copilot header .cc-ver {
  flex: 1; font-size: 10px; font-weight: 700; color: var(--accent);
  background: rgba(74,58,167,.12); border-radius: 8px; padding: 1px 7px; margin-left: 2px;
  white-space: nowrap;
}
#catan-copilot header button {
  background: none; border: none; color: var(--ink-2); cursor: pointer;
  font-size: 13px; padding: 2px 6px;
}
#catan-copilot .cc-body { overflow-y: auto; padding: 10px 12px 12px; }
#catan-copilot h4 {
  margin: 12px 0 6px; font-size: 11px; text-transform: uppercase;
  letter-spacing: .06em; color: var(--ink-3);
}
#catan-copilot h4:first-child { margin-top: 0; }
#catan-copilot .cc-note { color: var(--ink-2); margin: 3px 0; }
#catan-copilot .cc-muted { color: var(--ink-3); }
#catan-copilot .cc-deck { display: grid; grid-template-columns: repeat(11, 1fr); gap: 3px; align-items: end; }
#catan-copilot .cc-deck .col { text-align: center; }
#catan-copilot .cc-deck .bar {
  width: 100%; background: var(--bar); border-radius: 3px 3px 0 0; margin: 0 auto;
  min-height: 2px;
}
#catan-copilot .cc-deck .bar.cold { opacity: .25; }
#catan-copilot .cc-deck .n { color: var(--ink-2); margin-top: 2px; }
#catan-copilot .cc-deck .n.due { color: var(--ink); font-weight: 700; }
#catan-copilot .cc-deck .c { color: var(--ink-3); font-variant-numeric: tabular-nums; }
#catan-copilot table { width: 100%; border-collapse: collapse; }
#catan-copilot td, #catan-copilot th {
  padding: 2px 4px; text-align: right; font-variant-numeric: tabular-nums;
}
#catan-copilot th { color: var(--ink-3); font-weight: 500; }
#catan-copilot td:first-child, #catan-copilot th:first-child { text-align: left; }
#catan-copilot .dot {
  display: inline-block; width: 8px; height: 8px; border-radius: 50%;
  margin-right: 5px; border: 1px solid rgba(128,128,128,.5); vertical-align: 0;
}
#catan-copilot .cc-card {
  border: 1px solid var(--hairline); border-radius: 8px; padding: 8px 10px; margin: 6px 0;
}
#catan-copilot .cc-card.rec { border-color: var(--accent); border-width: 2px; }
#catan-copilot .cc-card .t { font-weight: 600; display: flex; justify-content: space-between; }
#catan-copilot .cc-card .tag { color: var(--ink-2); }
#catan-copilot .cc-card ul { margin: 4px 0 0; padding-left: 16px; color: var(--ink-2); }
#catan-copilot .cc-badge {
  background: var(--accent); color: #fff; border-radius: 8px; padding: 0 6px;
  font-size: 10px; font-weight: 700;
}
/* Hand grid: five FIXED slots (wood, brick, sheep, wheat, ore) so a count is
   always in the same place and reads at a glance; zero slots stay visible
   but dimmed. Icons are shapes, not colour alone, so they read with any
   colour vision. */
#catan-copilot .cc-hand {
  display: grid; grid-template-columns: repeat(5, minmax(44px, 1fr));
  gap: 4px; max-width: 300px; margin: 2px 0 4px;
}
#catan-copilot .cc-slot {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 2px 6px 2px 3px; border-radius: 6px;
  background: rgba(127,127,127,.10); border: 1px solid rgba(127,127,127,.18);
  font-variant-numeric: tabular-nums; font-weight: 700; font-size: 12px;
  color: var(--ink);
}
#catan-copilot .cc-slot svg { width: 18px; height: 18px; flex: none; display: block; }
#catan-copilot .cc-slot.zero { opacity: .38; font-weight: 500; }
/* Record card: stat tiles + win-rate bar + recent-form dots. Wins use the
   bar blue, losses the hairline grey — both are direct-labeled. */
#catan-copilot .cc-record { margin-top: 6px; }
#catan-copilot .cc-tiles { display: grid; grid-template-columns: 1.4fr 1fr 1fr; gap: 6px; margin: 4px 0 6px; }
#catan-copilot .cc-tile {
  border: 1px solid var(--hairline); border-radius: 8px; padding: 6px 8px; text-align: center;
  background: rgba(127,127,127,.06);
}
#catan-copilot .cc-tile .v { font-size: 18px; font-weight: 800; line-height: 1.1; font-variant-numeric: tabular-nums; }
#catan-copilot .cc-tile .k { font-size: 10px; color: var(--ink-2); text-transform: uppercase; letter-spacing: .04em; margin-top: 2px; }
#catan-copilot .cc-tile.hero { background: rgba(42,120,214,.10); border-color: rgba(42,120,214,.35); }
#catan-copilot .cc-tile.hero .v { color: var(--bar); font-size: 22px; }
#catan-copilot .cc-tile.win .v { color: var(--bar); }
#catan-copilot .cc-tile.loss .v { color: var(--ink-2); }
#catan-copilot .cc-ratebar {
  height: 8px; border-radius: 4px; background: var(--hairline); overflow: hidden; margin: 0 0 6px;
}
#catan-copilot .cc-ratebar span { display: block; height: 100%; background: var(--bar); border-radius: 4px; }
#catan-copilot .cc-form .dot {
  display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin: 0 1.5px; vertical-align: -1px;
  border: 1.5px solid var(--bar); box-sizing: border-box;
}
#catan-copilot .cc-form .dot.win { background: var(--bar); }
#catan-copilot .cc-form .dot.loss { border-color: var(--ink-3); background: transparent; }
#catan-copilot .cc-split { margin: 4px 0; }
#catan-copilot .cc-split { width: 100%; }
#catan-copilot .cc-split td, #catan-copilot .cc-split th { text-align: left; white-space: nowrap; padding-right: 6px; }
#catan-copilot .cc-split td:first-child { font-size: 11px; max-width: 120px; overflow: hidden; text-overflow: ellipsis; }
#catan-copilot .cc-rate {
  position: relative; height: 14px; border-radius: 3px; background: var(--hairline); overflow: hidden;
}
#catan-copilot .cc-rate span { display: block; height: 100%; background: var(--bar); opacity: .55; }
#catan-copilot .cc-rate em {
  position: absolute; inset: 0; font-style: normal; font-size: 10px; font-weight: 700;
  line-height: 14px; padding-left: 4px; color: var(--ink); font-variant-numeric: tabular-nums;
}
#catan-copilot-toggle {
  position: fixed; top: 70px; right: 12px; z-index: 2147483001;
  background: #4a3aa7; color: #fff; border: none; border-radius: 16px;
  padding: 5px 12px; font: 600 12px system-ui, sans-serif; cursor: pointer;
  display: none;
}
#catan-copilot .cc-hist {
  max-height: 176px; overflow-y: auto; border: 1px solid var(--hairline);
  border-radius: 8px; padding: 2px 8px; margin-top: 4px;
}
#catan-copilot .cc-hist .row {
  display: flex; gap: 6px; padding: 2px 4px; font-size: 12px; line-height: 1.35;
  border-bottom: 1px solid var(--hairline);
}
#catan-copilot .cc-hist .row:last-child { border-bottom: none; }
#catan-copilot .cc-hist .who { color: var(--ink-2); font-weight: 600; white-space: nowrap; }
#catan-copilot .cc-hist .row.mine { border-radius: 4px; background: rgba(74,58,167,.08); }
#catan-copilot .cc-hist .row.mine .who { color: var(--accent); }
#catan-copilot .cc-hist .what { color: var(--ink-2); }
#catan-copilot .cc-h4row { display: flex; align-items: baseline; justify-content: space-between; }
#catan-copilot .cc-h4row button { font-size: 11px; padding: 1px 7px; }
`;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export interface HistoryEntry {
  t: number;
  player: string | null;
  text: string;
  mine: boolean;
}

export interface OverlayHooks {
  captureCount?: () => number;
  onDownloadCapture?: () => void;
  getAutopilotView?: () => AutopilotView;
  onToggleAutopilot?: (on: boolean) => void;
  /** Rush mode (no turns): pilot state + how it was decided */
  getRushView?: () => RushView & { active: boolean; pref: RushPref; modeSetting: number | null };
  onSetRushPref?: (pref: RushPref) => void;
  /** true when the WebSocket was never captured (extension loaded mid-game) */
  needsRefresh?: () => boolean;
  getHistory?: () => HistoryEntry[];
  onDownloadHistory?: () => void;
  gameLogCount?: () => number;
  onDownloadGameLogs?: () => void;
}


/** Fixed display order for hands — build costs read left to right. */
const HAND_ORDER: Resource[] = ["wood", "brick", "sheep", "wheat", "ore"];

/** Compact, realistic resource icons (inline SVG, 24×24 viewBox). */
const RESOURCE_ICON: Record<Resource, string> = {
  wood: `<svg viewBox="0 0 24 24" aria-hidden="true">
    <rect x="10.4" y="15" width="3.2" height="7" rx="1" fill="#6b4423"/>
    <path d="M12 2 L5.5 11 H9 L4.5 17.5 H19.5 L15 11 H18.5 Z" fill="#2f8f4e"/>
    <path d="M12 2 L9 6.5 H11.5 L8.5 11 H12 Z" fill="#47b36a" opacity=".8"/>
  </svg>`,
  brick: `<svg viewBox="0 0 24 24" aria-hidden="true">
    <rect x="2" y="4" width="9" height="4.6" rx=".6" fill="#c4452b"/>
    <rect x="12.5" y="4" width="9.5" height="4.6" rx=".6" fill="#b23c24"/>
    <rect x="6.5" y="9.7" width="10" height="4.6" rx=".6" fill="#c4452b"/>
    <rect x="2" y="9.7" width="3.5" height="4.6" rx=".6" fill="#b23c24"/>
    <rect x="17.5" y="9.7" width="4.5" height="4.6" rx=".6" fill="#b23c24"/>
    <rect x="2" y="15.4" width="9" height="4.6" rx=".6" fill="#b23c24"/>
    <rect x="12.5" y="15.4" width="9.5" height="4.6" rx=".6" fill="#c4452b"/>
  </svg>`,
  sheep: `<svg viewBox="0 0 24 24" aria-hidden="true">
    <g fill="#f3f1ea" stroke="#5f5f57" stroke-width="1">
      <circle cx="8" cy="11" r="3.6"/><circle cx="12.5" cy="9" r="3.8"/>
      <circle cx="16.5" cy="11.5" r="3.4"/><circle cx="10" cy="14.5" r="3.6"/>
      <circle cx="14.5" cy="14.8" r="3.6"/>
    </g>
    <rect x="9" y="17" width="1.8" height="4" rx=".6" fill="#3c3630"/>
    <rect x="14" y="17" width="1.8" height="4" rx=".6" fill="#3c3630"/>
    <ellipse cx="18.6" cy="12.6" rx="2.6" ry="2.2" fill="#3c3630"/>
    <circle cx="19.4" cy="12.1" r=".5" fill="#fff"/>
    <path d="M16.4 11.2 l-1.1-1.6 M20.8 11.2 l1.1-1.6" stroke="#3c3630" stroke-width="1" stroke-linecap="round"/>
  </svg>`,
  wheat: `<svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 22 V7" stroke="#b8860b" stroke-width="1.6" stroke-linecap="round"/>
    <g fill="#e8b320" stroke="#a87408" stroke-width=".5">
      <ellipse cx="9.6" cy="9" rx="1.7" ry="3" transform="rotate(-30 9.6 9)"/>
      <ellipse cx="14.4" cy="9" rx="1.7" ry="3" transform="rotate(30 14.4 9)"/>
      <ellipse cx="9.4" cy="13" rx="1.7" ry="3" transform="rotate(-30 9.4 13)"/>
      <ellipse cx="14.6" cy="13" rx="1.7" ry="3" transform="rotate(30 14.6 13)"/>
      <ellipse cx="12" cy="5" rx="1.7" ry="3"/>
    </g>
    <path d="M12 18 c-2.5-.2-4-1.8-4.5-3.5 2.3.1 4 1.4 4.5 3.5z" fill="#7cae3e"/>
  </svg>`,
  ore: `<svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M4 17 L8 7 L13 4 L20 9 L21 16 L16 21 L7 21 Z" fill="#6b7280" stroke="#3f4650" stroke-width=".8" stroke-linejoin="round"/>
    <path d="M8 7 L13 11 L20 9 M13 11 L11 21 M13 11 L21 16" fill="none" stroke="#3f4650" stroke-width=".7"/>
    <path d="M13 4 L16 8 L13 11 L10 8 Z" fill="#9aa3ad" opacity=".7"/>
    <circle cx="16.5" cy="15" r="1.4" fill="#8fb3ff" opacity=".9"/>
  </svg>`,
};


const DOCK_PREF = "catanCopilot:docked";
function loadDockPref(): boolean {
  try {
    return localStorage.getItem(DOCK_PREF) === "1";
  } catch {
    return false;
  }
}
function saveDockPref(on: boolean): void {
  try {
    localStorage.setItem(DOCK_PREF, on ? "1" : "0");
  } catch {
    /* storage unavailable — session-only */
  }
}

export class Overlay {
  private root: HTMLElement;
  private body: HTMLElement;
  private deferredRender: number | undefined;
  private lastState: TrackerState | null = null;
  private lastBridge: BoardView | null = null;
  /** docked = full-height column beside the game; floating = draggable card */
  docked = false;

  /**
   * Dock beside the game or float over it. Docking narrows the page by the
   * panel's width and fires a resize so the game re-lays out into the
   * remaining space. (Games that size their canvas from window.innerWidth
   * ignore the page width — then the panel still overlaps their right edge,
   * but at least sits flush and full-height.)
   */
  setDocked(on: boolean, persist = true): void {
    this.docked = on;
    const html = this.root.ownerDocument.documentElement;
    const DOCK_W = "340px";
    html.style.setProperty("--cc-dock-w", DOCK_W);
    this.root.classList.toggle("cc-docked", on);
    html.classList.toggle("cc-docked-page", on);
    if (on) {
      // drop any floating position left by dragging
      this.root.style.left = "";
      this.root.style.top = "";
    }
    const btn = this.root.querySelector('[data-act="dock"]');
    if (btn) {
      btn.textContent = on ? "Undock" : "Dock";
      btn.setAttribute("title", on ? "Float the panel over the game again" : "Dock the panel beside the game (instead of floating over it)");
    }
    if (persist) saveDockPref(on);
    const win = this.root.ownerDocument.defaultView;
    win?.dispatchEvent(new Event("resize"));
  }
  private toggle: HTMLButtonElement;
  private hooks: OverlayHooks;

  constructor(doc: Document, hooks: OverlayHooks = {}) {
    this.hooks = hooks;
    const style = doc.createElement("style");
    style.textContent = CSS;
    doc.head.appendChild(style);

    this.root = doc.createElement("div");
    this.root.id = "catan-copilot";
    this.root.innerHTML = `
      <header>
        <strong>Catan Copilot</strong>
        <span class="cc-ver">${esc(VERSION)}</span>
        <button data-act="dock" title="Dock the panel beside the game (instead of floating over it)">Dock</button>
        <button data-act="hide" title="Hide">–</button>
      </header>
      <div class="cc-body"><p class="cc-note">Waiting for game log…</p></div>`;
    doc.body.appendChild(this.root);

    this.toggle = doc.createElement("button");
    this.toggle.id = "catan-copilot-toggle";
    this.toggle.textContent = "Copilot";
    doc.body.appendChild(this.toggle);

    this.body = this.root.querySelector(".cc-body")!;
    this.root.querySelector('[data-act="hide"]')!.addEventListener("click", () => {
      this.root.style.display = "none";
      this.toggle.style.display = "block";
    });
    this.root.querySelector('[data-act="dock"]')!.addEventListener("click", () => {
      this.setDocked(!this.docked);
    });
    this.setDocked(loadDockPref(), false);
    // Delegated: the body is re-rendered wholesale, so bind on the root.
    this.root.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      if (target.closest('[data-act="download-capture"]')) {
        this.hooks.onDownloadCapture?.();
      }
      if (target.closest('[data-act="download-history"]')) {
        this.hooks.onDownloadHistory?.();
      }
      if (target.closest('[data-act="download-gamelogs"]')) {
        this.hooks.onDownloadGameLogs?.();
      }
      const toggle = target.closest('[data-act="toggle-autopilot"]');
      if (toggle) {
        this.hooks.onToggleAutopilot?.((toggle as HTMLInputElement).checked);
      }
    });
    this.root.addEventListener("change", (e) => {
      const rush = (e.target as HTMLElement).closest('[data-act="rush-pref"]') as HTMLSelectElement | null;
      if (rush) this.hooks.onSetRushPref?.(rush.value as RushPref);
    });
    this.toggle.addEventListener("click", () => {
      this.root.style.display = "flex";
      this.toggle.style.display = "none";
    });
    this.makeDraggable(doc);
  }

  private makeDraggable(doc: Document): void {
    const header = this.root.querySelector("header") as HTMLElement;
    let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
    header.addEventListener("mousedown", (e) => {
      if (this.docked) return; // a docked panel doesn't move
      dragging = true;
      sx = e.clientX;
      sy = e.clientY;
      const rect = this.root.getBoundingClientRect();
      ox = rect.left;
      oy = rect.top;
      e.preventDefault();
    });
    doc.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      this.root.style.left = `${ox + e.clientX - sx}px`;
      this.root.style.top = `${oy + e.clientY - sy}px`;
      this.root.style.right = "auto";
    });
    doc.addEventListener("mouseup", () => (dragging = false));
  }

  render(state: TrackerState, bridge?: BoardView | null): void {
    // The body is repainted wholesale on a timer. If the user is mid-interaction
    // with a control inside the panel (e.g. the Rush <select> is open/focused),
    // repainting would destroy it — the dropdown snaps shut before a choice
    // registers. Defer the repaint until they're done.
    const active = this.root.ownerDocument.activeElement;
    if (active && this.root.contains(active) && /^(SELECT|INPUT|TEXTAREA|OPTION)$/.test(active.tagName)) {
      if (this.deferredRender === undefined) {
        this.deferredRender = this.root.ownerDocument.defaultView!.setTimeout(() => {
          this.deferredRender = undefined;
          this.render(this.lastState ?? state, this.lastBridge ?? bridge);
        }, 500);
      }
      this.lastState = state;
      this.lastBridge = bridge ?? null;
      return;
    }
    this.lastState = state;
    this.lastBridge = bridge ?? null;
    const parts: string[] = [];

    // Compute board-derived advice once and share it across sections.
    let gs: { state: GameState; youPlayer: PlayerId | null } | null = null;
    let advice: PlacementAdvice | null = null;
    if (bridge?.board) {
      gs = bridge.toGameState();
      if (gs) advice = advisePlacement(gs.state, gs.youPlayer);
    }

    const you = state.youName;
    const fits =
      you && state.players.has(you)
        ? rankLiveStrategies(state, you, strategyPriors(loadRecords()))
        : [];

    if (you && fits.length > 0) {
      let facts: PlacementFacts | null = null;
      if (gs && gs.youPlayer !== null) {
        facts = placementFacts(gs.state, gs.youPlayer, advice);
      }
      // No "save for X" advice during setup: placements are free. The setup
      // guidance lives in the Where-to-build section. Before any roll (and
      // with no board captured) we can't tell setup from early game — stay
      // quiet rather than wrong.
      const inSetup = advice?.phase === "setup" || state.rolls.length === 0;
      if (!inSetup) {
        parts.push(this.renderYourMove(nextMoves(state, you, fits[0], facts)));
      }
    }

    parts.push(this.renderWhereToBuild(bridge ?? null, gs, advice));
    parts.push(this.renderDeck(deckStatus(state), state));
    parts.push(this.renderPlayers(state));

    if (you && fits.length > 0) {
      parts.push(this.renderStrategies(fits));
      const robber = robberAdvice(state);
      if (robber) {
        parts.push(`<h4>Robber</h4><p class="cc-note">${esc(robber.reason)}</p>`);
      }
      const tips = tradeTips(state, you, fits[0]);
      if (tips.length) parts.push(this.renderTrades(tips, isOneVsOne(state)));
    } else {
      parts.push(
        `<h4>You</h4><p class="cc-note cc-muted">Sign-in name not detected yet — strategy advice appears once you're identified.</p>`,
      );
    }
    if (state.gameOver) {
      parts.unshift(`<p class="cc-note"><strong>${esc(state.gameOver)}</strong> won the game.</p>`);
    }
    if (this.hooks.needsRefresh?.()) {
      parts.unshift(
        `<p class="cc-note" style="color:var(--brick);font-weight:600">⟳ Reload this tab! The game socket isn't captured — exact hands, the board map and full autopilot need it. (Colonist resends everything on refresh.)</p>`,
      );
    }

    parts.push(this.renderHistory());
    parts.push(this.renderAutopilot());
    this.body.innerHTML = parts.join("");
  }

  private renderHistory(): string {
    const hist = this.hooks.getHistory?.() ?? [];
    if (hist.length === 0) return "";
    // newest first, cap the rendered rows (the store keeps the full history)
    const rows = hist
      .slice(-60)
      .reverse()
      .map(
        (e) =>
          `<div class="row${e.mine ? " mine" : ""}"><span class="who">${esc(e.player ?? "?")}</span><span class="what">${esc(e.text)}</span></div>`,
      )
      .join("");
    return `
      <div class="cc-h4row">
        <h4>Move history (${hist.length})</h4>
        <button data-act="download-history" title="Save as text">save</button>
      </div>
      <div class="cc-hist">${rows}</div>`;
  }

  private renderAutopilot(): string {
    const ap = this.hooks.getAutopilotView?.();
    if (!ap) return "";
    const captured = this.hooks.captureCount?.() ?? 0;
    return `
      <h4>Autopilot</h4>
      <p class="cc-note">
        <label><input type="checkbox" data-act="toggle-autopilot" ${ap.enabled ? "checked" : ""}/>
        <strong>Play my turns</strong></label>
        <span class="cc-muted"> — ${esc(ap.note)}</span>
      </p>
      ${this.renderRush()}
      <p class="cc-note cc-muted">Plays your turn through colonist's own protocol: rolls, builds
      settlements, roads and cities (setup and mid-game), buys dev cards, bank-trades toward builds,
      plays knights and monopolies, moves the robber and steals, discards on a 7, ends the turn.
      Year-of-plenty / road-building dev cards still fall back to advice. Use in bot matches or games
      where everyone consents — automation can get accounts banned on ranked play.</p>
      ${this.renderRecord()}
      ${this.renderGameLogs()}
      ${
        captured > 0
          ? `<p class="cc-note cc-muted">${captured} protocol frames captured — <button data-act="download-capture" style="font-size:11px;padding:1px 7px">download</button> for debugging.</p>`
          : ""
      }`;
  }

  private renderRush(): string {
    const rv = this.hooks.getRushView?.();
    if (!rv) return "";
    const opt = (v: RushPref, label: string) =>
      `<option value="${v}" ${rv.pref === v ? "selected" : ""}>${label}</option>`;
    const detected = rv.modeSetting === null ? "mode unknown" : `game modeSetting = ${rv.modeSetting}`;
    return `
      <p class="cc-note">
        <strong>Rush mode</strong>
        <select data-act="rush-pref" style="font-size:11px">
          ${opt("auto", "auto-detect")}${opt("on", "on")}${opt("off", "off")}
        </select>
        <span class="cc-muted"> — ${rv.active ? `ACTIVE: ${esc(rv.note)}` : "inactive"} (${detected})</span>
      </p>
      ${rv.active ? `<p class="cc-note cc-muted">Rush has no turns: the pilot places setup settlements, builds roads / settlements / cities the moment they're affordable, moves the robber and discards on a 7. No rolling, trading or dev cards.</p>` : ""}`;
  }

  /** Win/loss record: stat tiles, a win-rate bar, recent form, and splits. */
  private renderRecord(): string {
    const st = recordStats(loadRecords());
    if (!st) return "";
    const pct = (x: number) => `${Math.round(x * 100)}%`;
    const tile = (v: string, k: string, cls = "") =>
      `<div class="cc-tile ${cls}"><div class="v">${v}</div><div class="k">${k}</div></div>`;
    const form = st.recent
      .map((w) => `<span class="dot ${w ? "win" : "loss"}" title="${w ? "win" : "loss"}"></span>`)
      .join("");
    const streak =
      st.streak >= 2 ? `${st.streak} wins in a row` : st.streak <= -2 ? `${-st.streak} losses in a row` : "";
    const split = (label: string, rows: Array<{ name: string; games: number; wins: number; winRate: number }>) =>
      rows.length < 1
        ? ""
        : `<table class="cc-split"><tr><th>${label}</th><th>W–L</th><th style="width:42%">win rate</th></tr>${rows
            .map(
              (r) => `<tr><td>${esc(r.name)}</td><td>${r.wins}–${r.games - r.wins}</td>
              <td><div class="cc-rate"><span style="width:${pct(r.winRate)}"></span><em>${pct(r.winRate)}</em></div></td></tr>`,
            )
            .join("")}</table>`;
    return `
      <div class="cc-record">
        <h4>Record <span class="cc-muted">(${st.games} game${st.games === 1 ? "" : "s"})</span></h4>
        <div class="cc-tiles">
          ${tile(pct(st.winRate), "win rate", "hero")}
          ${tile(String(st.wins), "wins", "win")}
          ${tile(String(st.losses), "losses", "loss")}
        </div>
        <div class="cc-ratebar" role="img" aria-label="win rate ${pct(st.winRate)}">
          <span style="width:${pct(st.winRate)}"></span>
        </div>
        <p class="cc-note"><span class="cc-muted">Last ${st.recent.length}:</span> <span class="cc-form">${form}</span>
          ${streak ? `<span class="cc-muted"> — ${streak}</span>` : ""}</p>
        ${split("Strategy", st.byStrategy)}
        ${st.byPlayers.length > 1 ? split("Table", st.byPlayers.map((r) => ({ ...r, name: `${r.players}-player` }))) : ""}
        <p class="cc-note cc-muted">Results feed back into strategy scores.</p>
      </div>`;
  }

  private renderGameLogs(): string {
    const n = this.hooks.gameLogCount?.() ?? 0;
    if (n === 0) return "";
    return `<p class="cc-note cc-muted">${n} full game${n > 1 ? "s" : ""} logged for strategy analysis —
      <button data-act="download-gamelogs" style="font-size:11px;padding:1px 7px">download logs</button></p>`;
  }

  private renderYourMove(actions: MoveAction[]): string {
    if (actions.length === 0) return "";
    const items = actions
      .map(
        (a) =>
          `<p class="cc-note${a.primary ? "" : " cc-muted"}">${a.primary ? "▶ " : ""}${esc(a.text)}</p>`,
      )
      .join("");
    return `<div class="cc-card rec"><div class="t"><span>Your move</span></div>${items}</div>`;
  }

  private renderWhereToBuild(
    bridge: BoardView | null,
    gs: { state: GameState; youPlayer: PlayerId | null } | null,
    advice: PlacementAdvice | null,
  ): string {
    if (!bridge || !bridge.board) {
      return `<h4>Where to build</h4><p class="cc-note cc-muted">Board not captured yet — refresh the page during the game so the copilot can read the board state.</p>`;
    }
    if (!gs || !advice) return "";
    const map = renderMiniMap(gs.state, {
      spots: advice.spots,
      roadEdges: advice.roadEdges,
      buildings: bridge.buildings,
      roads: bridge.roads,
    });
    const circled = ["①", "②", "③"];
    const list = advice.spots
      .map((s) => `<p class="cc-note">${circled[s.rank - 1] ?? s.rank} ${esc(s.label)}</p>`)
      .join("");
    return `
      <h4>${esc(advice.heading)}</h4>
      ${map}
      ${list}
      ${advice.note ? `<p class="cc-note cc-muted">${esc(advice.note)}</p>` : ""}`;
  }

  private renderDeck(deck: DeckStatus, state: TrackerState): string {
    const cols: string[] = [];
    const maxCards = 6;
    for (let n = 2; n <= 12; n++) {
      const left = deck.remaining.get(n) ?? 0;
      const h = Math.round((left / maxCards) * 34);
      const due = deck.due.includes(n);
      cols.push(`
        <div class="col">
          <div class="c">${left}</div>
          <div class="bar${left === 0 ? " cold" : ""}" style="height:${Math.max(2, h)}px"></div>
          <div class="n${due ? " due" : ""}">${n}</div>
        </div>`);
    }
    const yourNumbers: number[] = [];
    if (state.youName) {
      const you = state.players.get(state.youName);
      if (you) yourNumbers.push(...[...you.incomeByNumber.keys()].sort((a, b) => a - b));
    }
    let hitLine = "";
    if (yourNumbers.length > 0) {
      const pHit = yourNumbers.reduce((s, n) => s + (deck.prob.get(n) ?? 0), 0);
      hitLine = `<p class="cc-note">Your numbers (${yourNumbers.join(", ")}) hit the next roll with <strong>${Math.round(pHit * 100)}%</strong>.</p>`;
    }
    const dueLine = deck.due.length
      ? `<p class="cc-note">Over-due: <strong>${deck.due.join(", ")}</strong>. Exhausted: ${deck.cold.length ? deck.cold.join(", ") : "none"}.</p>`
      : "";
    return `
      <h4>Balanced-dice deck <span class="cc-muted">(${36 - deck.rollsIntoDeck} cards left, count above each bar)</span></h4>
      <div class="cc-deck">${cols.join("")}</div>
      ${hitLine}${dueLine}`;
  }

  private renderPlayers(state: TrackerState): string {
    if (state.players.size === 0) return "";
    const rows = [...state.players.values()]
      .sort((a, b) => visibleVp(b) - visibleVp(a))
      .map((p) => {
        const prodPips = Math.round(productionTotal(expectedProduction(p)) * 36);
        // prefer colonist's own count (panel/WS) over our log-derived estimate
        const total = p.serverCards ?? handTotal(p);
        // with a server total, `uncertainty` = cards we never identified
        const cards = p.serverCards === null
          ? `${total}${p.uncertainty ? `±${p.uncertainty}` : ""}`
          : `${total}${p.uncertainty ? ` <span class="cc-muted">(${p.uncertainty}?)</span>` : ""}`;
        const hand = HAND_ORDER.map(
          (r) =>
            `<span class="cc-slot${p.hand[r] === 0 ? " zero" : ""}" title="${r}: ${p.hand[r]}" aria-label="${r} ${p.hand[r]}">${RESOURCE_ICON[r]}<span>${p.hand[r]}</span></span>`,
        ).join("");
        return `
          <tr>
            <td><span class="dot" style="background:${esc(p.color)}"></span>${esc(p.name)}${state.youName === p.name ? " <span class='cc-muted'>(you)</span>" : ""}</td>
            <td>${visibleVp(p)}</td>
            <td title="known hand">${cards}</td>
            <td>${prodPips}</td>
            <td>${p.devCards}/${p.knightsPlayed}</td>
          </tr>
          <tr><td colspan="5" style="text-align:left;padding-left:18px"><div class="cc-hand">${hand}</div></td></tr>`;
      });
    const mode = isOneVsOne(state) ? ` <span class="cc-muted">(1v1 — first to 15 VP)</span>` : "";
    return `
      <h4>Players${mode}</h4>
      <table>
        <tr><th>Player</th><th>VP</th><th>Cards</th><th>Pips</th><th>Dev/Kn</th></tr>
        ${rows.join("")}
      </table>`;
  }

  private renderStrategies(fits: LiveStrategyFit[]): string {
    if (fits.length === 0) return "";
    const cards = fits.slice(0, 3).map((f, i) => {
      const rec = i === 0;
      return `
        <div class="cc-card${rec ? " rec" : ""}">
          <div class="t"><span>${esc(f.strategy.name)}</span>${rec ? '<span class="cc-badge">RECOMMENDED</span>' : `<span class="cc-muted">~${f.simVp.toFixed(1)} VP</span>`}</div>
          <div class="tag">${esc(f.strategy.tagline)}</div>
          ${rec ? `<div class="cc-muted">Simulated ~${f.simVp.toFixed(1)} VP added over the next 25 turns (balanced dice, 30 trials)</div>` : ""}
          ${f.rationale.length ? `<ul>${f.rationale.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>` : ""}
        </div>`;
    });
    return `<h4>Your strategy</h4>${cards.join("")}`;
  }

  private renderTrades(tips: LiveTradeTip[], oneVsOne: boolean): string {
    const heading = oneVsOne ? "Bank & ports (no player trades in 1v1)" : "Trading";
    return `<h4>${heading}</h4>${tips.map((t) => `<p class="cc-note">${esc(t.text)}</p>`).join("")}`;
  }
}
