import { RESOURCES } from "../engine/types";
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
import { BoardBridge } from "./boardBridge";
import {
  PlacementAdvice,
  advisePlacement,
  placementFacts,
  renderMiniMap,
} from "./placement";
import { GameState, PlayerId } from "../engine/types";
import { AutopilotView } from "./autopilot";
import { ACTION_KINDS } from "./protocolLearner";
import { loadRecords, recordSummary, strategyPriors } from "./learning";

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
#catan-copilot header {
  display: flex; align-items: center; gap: 8px; padding: 8px 12px;
  border-bottom: 1px solid var(--hairline); cursor: grab; user-select: none;
}
#catan-copilot header strong { font-size: 13px; flex: 1; }
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
#catan-copilot .res { text-transform: capitalize; }
#catan-copilot .res::before {
  content: ""; display: inline-block; width: 8px; height: 8px; border-radius: 2px;
  margin-right: 4px;
}
#catan-copilot .res.brick::before { background: var(--brick); }
#catan-copilot .res.wheat::before { background: var(--wheat); }
#catan-copilot .res.sheep::before { background: var(--sheep); }
#catan-copilot .res.ore::before { background: var(--ore); }
#catan-copilot .res.wood::before { background: var(--wood); }
#catan-copilot-toggle {
  position: fixed; top: 70px; right: 12px; z-index: 2147483001;
  background: #4a3aa7; color: #fff; border: none; border-radius: 16px;
  padding: 5px 12px; font: 600 12px system-ui, sans-serif; cursor: pointer;
  display: none;
}
`;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export interface OverlayHooks {
  captureCount?: () => number;
  onDownloadCapture?: () => void;
  getAutopilotView?: () => AutopilotView;
  onToggleAutopilot?: (on: boolean) => void;
  /** true when the WebSocket was never captured (extension loaded mid-game) */
  needsRefresh?: () => boolean;
}

export class Overlay {
  private root: HTMLElement;
  private body: HTMLElement;
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
    // Delegated: the body is re-rendered wholesale, so bind on the root.
    this.root.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      if (target.closest('[data-act="download-capture"]')) {
        this.hooks.onDownloadCapture?.();
      }
      const toggle = target.closest('[data-act="toggle-autopilot"]');
      if (toggle) {
        this.hooks.onToggleAutopilot?.((toggle as HTMLInputElement).checked);
      }
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

  render(state: TrackerState, bridge?: BoardBridge | null): void {
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

    parts.push(this.renderAutopilot());
    this.body.innerHTML = parts.join("");
  }

  private renderAutopilot(): string {
    const ap = this.hooks.getAutopilotView?.();
    if (!ap) return "";
    const labels: Record<string, string> = {
      "build-settlement": "settle",
      "build-road": "road",
      "build-city": "city",
      "buy-dev": "dev",
      roll: "roll",
      "end-turn": "end turn",
      "move-robber": "robber",
      discard: "discard",
    };
    const chips = ACTION_KINDS.map(
      (k) =>
        `<span class="${ap.status[k] ? "" : "cc-muted"}" style="margin-right:8px">${ap.status[k] ? "✓" : "·"} ${labels[k] ?? k}</span>`,
    ).join("");
    const record = recordSummary(loadRecords());
    const captured = this.hooks.captureCount?.() ?? 0;
    return `
      <h4>Autopilot</h4>
      <p class="cc-note">
        <label><input type="checkbox" data-act="toggle-autopilot" ${ap.enabled ? "checked" : ""}/>
        <strong>Play my turns</strong></label>
        <span class="cc-muted"> — ${esc(ap.note)}</span>
      </p>
      <p class="cc-note">Learned actions (from watching you play): ${chips}</p>
      <p class="cc-note cc-muted">Plays your turn: rolls, builds the recommended order, moves the
      robber, discards the worst cards when a 7 forces it, ends the turn. Roll/dev/end-turn/discard
      work immediately by clicking the game's own UI; placements, robber and discard also learn
      exact templates from the first time you do them manually. Trades stay manual (advice above).
      Use in bot matches or games where everyone consents — automation can get accounts banned on
      ranked play.</p>
      ${record ? `<p class="cc-note cc-muted">${esc(record)}</p>` : ""}
      ${
        captured > 0
          ? `<p class="cc-note cc-muted">${captured} protocol frames captured — <button data-act="download-capture" style="font-size:11px;padding:1px 7px">download</button> for debugging.</p>`
          : ""
      }`;
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
    bridge: BoardBridge | null,
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
        const cards = `${total}${p.uncertainty && p.serverCards === null ? `±${p.uncertainty}` : ""}`;
        const hand = RESOURCES.filter((r) => p.hand[r] > 0)
          .map((r) => `${p.hand[r]}<span class="res ${r}"></span>`)
          .join(" ");
        return `
          <tr>
            <td><span class="dot" style="background:${esc(p.color)}"></span>${esc(p.name)}${state.youName === p.name ? " <span class='cc-muted'>(you)</span>" : ""}</td>
            <td>${visibleVp(p)}</td>
            <td title="known hand">${cards}</td>
            <td>${prodPips}</td>
            <td>${p.devCards}/${p.knightsPlayed}</td>
          </tr>
          ${hand ? `<tr><td colspan="5" class="cc-muted" style="text-align:left;padding-left:18px">${hand}</td></tr>` : ""}`;
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
