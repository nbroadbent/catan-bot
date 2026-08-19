import { GameState, PlayerId, RESOURCES, pips } from "../engine/types";
import { vertexPips } from "../engine/board";
import { isVertexBuildable } from "../engine/analysis";
import { pixelToColonistCorner, pixelsToColonistEdge } from "./coords";
import { DomActionKind, tryDomAction } from "./domActions";
import { ActionKind, ProtocolLearner } from "./protocolLearner";
import { LiveStrategyFit } from "./copilot";
import { PlacementAdvice } from "./placement";
import { TrackerState } from "./tracker";

export interface AutopilotDecision {
  kind: ActionKind;
  coord?: { x: number; y: number; z?: number };
  describe: string;
}

/**
 * Choose the robber tile: maximize the value denied to opponents (pips ×
 * buildings × how much that resource matters to them) minus the value denied
 * to yourself, and never re-place on the current robber tile.
 */
export function bestRobberHex(
  state: GameState,
  youPlayer: PlayerId,
  current: { x: number; y: number } | null,
): { hex: { x: number; y: number }; victim: PlayerId | null; describe: string } | null {
  let best: { score: number; hexId: number } | null = null;
  for (const hex of state.board.hexes) {
    if (hex.kind === "desert" || hex.token === null) continue;
    if (current && hex.q === current.x && hex.r === current.y) continue;
    let opp = 0;
    let mine = 0;
    for (const b of state.buildings) {
      if (!state.board.vertices[b.vertexId].hexIds.includes(hex.id)) continue;
      const value = pips(hex.token) * (b.kind === "city" ? 2 : 1);
      if (b.player === youPlayer) mine += value;
      else opp += value;
    }
    const score = opp - mine * 1.5;
    if (opp > 0 && (!best || score > best.score)) best = { score, hexId: hex.id };
  }
  if (!best) return null;
  const hex = state.board.hexes[best.hexId];
  // victim: first opponent on the tile (colonist prompts when there are
  // several; in 1v1 there is only ever one)
  const victims = state.buildings
    .filter(
      (b) =>
        b.player !== youPlayer &&
        state.board.vertices[b.vertexId].hexIds.includes(best!.hexId),
    )
    .map((b) => b.player);
  const victim = victims.length ? victims[0] : null;
  return {
    hex: { x: hex.q, y: hex.r },
    victim,
    describe: `robber to the ${hex.token}-${hex.kind} tile`,
  };
}

const COSTS: Record<"road" | "settlement" | "city" | "dev", Partial<Record<string, number>>> = {
  road: { wood: 1, brick: 1 },
  settlement: { wood: 1, brick: 1, sheep: 1, wheat: 1 },
  city: { ore: 3, wheat: 2 },
  dev: { ore: 1, sheep: 1, wheat: 1 },
};

/** Best legal settlement spot connected to the player's road network, now. */
export function bestPlaceableNow(state: GameState, player: PlayerId): number | null {
  const network = new Set<number>();
  for (const b of state.buildings) if (b.player === player) network.add(b.vertexId);
  for (const r of state.roads) {
    if (r.player === player) {
      const e = state.board.edges[r.edgeId];
      network.add(e.a);
      network.add(e.b);
    }
  }
  let best: number | null = null;
  let bestPips = -1;
  for (const v of network) {
    if (!isVertexBuildable(state, v)) continue;
    const p = vertexPips(state.board, v);
    if (p > bestPips) {
      bestPips = p;
      best = v;
    }
  }
  return best;
}

/**
 * Pure decision: given the current game view, what should autopilot do next?
 * Returns null when there is nothing (sensible) left to do this turn.
 */
export function decideNext(opts: {
  tracker: TrackerState;
  youName: string;
  fit: LiveStrategyFit | null;
  gs: { state: GameState; youPlayer: PlayerId | null } | null;
  advice: PlacementAdvice | null;
  rolledThisTurn: boolean;
  robberPending?: boolean;
  robberHex?: { x: number; y: number } | null;
}): AutopilotDecision | null {
  const { tracker, youName, fit, gs, advice, rolledThisTurn, robberPending, robberHex } = opts;
  const you = tracker.players.get(youName);
  if (!you) return null;
  const board = gs?.state.board;

  // Robber placement takes priority: it blocks everything until resolved.
  if (robberPending && gs && gs.youPlayer !== null && board) {
    const target = bestRobberHex(gs.state, gs.youPlayer, robberHex ?? null);
    if (target) {
      return {
        kind: "move-robber",
        coord: { x: target.hex.x, y: target.hex.y },
        describe: target.describe,
      };
    }
    return null; // no useful tile — let the human decide
  }

  // Setup phase: place the advised settlement / road (needs the board).
  if (advice?.phase === "setup" && board && gs && gs.youPlayer !== null) {
    if (advice.roadEdges.length > 0) {
      const e = board.edges[advice.roadEdges[0]];
      const coord = pixelsToColonistEdge(board.vertices[e.a], board.vertices[e.b]);
      if (coord) return { kind: "build-road", coord, describe: "setup road (dashed edge)" };
      return null;
    }
    if (advice.spots.length > 0) {
      const v = board.vertices[advice.spots[0].vertexId];
      const coord = pixelToColonistCorner(v.x, v.y);
      if (coord) return { kind: "build-settlement", coord, describe: `settlement at ① ${advice.spots[0].label}` };
    }
    return null;
  }

  if (!rolledThisTurn) return { kind: "roll", describe: "roll the dice" };
  if (!fit) return null;

  const afford = (item: keyof typeof COSTS): boolean =>
    RESOURCES.every((r) => you.hand[r] >= ((COSTS[item][r] as number | undefined) ?? 0));

  for (const item of fit.strategy.buildOrder) {
    if (!afford(item)) continue;
    if (item === "dev") {
      return { kind: "buy-dev", describe: "buy a development card" };
    }
    // Spatial builds need the captured board for coordinates.
    if (!gs || gs.youPlayer === null || !board) continue;
    if (item === "city") {
      const settlements = gs.state.buildings.filter(
        (b) => b.player === gs.youPlayer && b.kind === "settlement",
      );
      if (settlements.length === 0) continue;
      const target = settlements.reduce((a, b) =>
        vertexPips(board, a.vertexId) >= vertexPips(board, b.vertexId) ? a : b,
      );
      const v = board.vertices[target.vertexId];
      const coord = pixelToColonistCorner(v.x, v.y);
      if (coord) return { kind: "build-city", coord, describe: "upgrade best settlement to a city" };
    } else if (item === "settlement") {
      const spot = bestPlaceableNow(gs.state, gs.youPlayer);
      if (spot === null) continue;
      const v = board.vertices[spot];
      const coord = pixelToColonistCorner(v.x, v.y);
      if (coord) return { kind: "build-settlement", coord, describe: "settlement on your network" };
    } else if (item === "road") {
      if (advice && advice.roadEdges.length > 0) {
        const e = board.edges[advice.roadEdges[0]];
        const coord = pixelsToColonistEdge(board.vertices[e.a], board.vertices[e.b]);
        if (coord) return { kind: "build-road", coord, describe: "road toward expansion ①" };
      }
    }
  }

  return { kind: "end-turn", describe: "end the turn" };
}

export interface AutopilotView {
  enabled: boolean;
  status: Record<ActionKind, boolean>;
  note: string;
}

/**
 * The executor: watches turn state, decides via decideNext, sends learned
 * frames, and requires each action to be CONFIRMED by the game (log/board
 * event) before the next.
 *
 * Handles rolls, the strategy build order, robber placement, and ending the
 * turn. Discards and trades stay manual (the overlay advises).
 */
export class Autopilot {
  enabled = false;
  wsTurnSeen = false;
  robberPending = false;
  private myTurn = false;
  private rolledThisTurn = false;
  private pending: { kind: ActionKind; t: number; via: "ws" | "dom" } | null = null;
  private note = "off";

  constructor(
    private learner: ProtocolLearner,
    private send: (frame: unknown) => void,
    private domAct: (kind: DomActionKind) => string | null = tryDomAction,
  ) {}

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.note = on ? "on — waiting for your turn" : "off";
    if (!on) this.pending = null;
  }

  onTurnState(currentColor: number, myColor: number | null): void {
    this.wsTurnSeen = true;
    const mine = myColor !== null && currentColor === myColor;
    if (mine && !this.myTurn) this.rolledThisTurn = false;
    if (!mine && this.myTurn && this.pending?.kind === "end-turn") this.pending = null;
    this.myTurn = mine;
  }

  /**
   * DOM-based turn detection ("Your Turn" banner) for sessions where the
   * WebSocket wasn't captured (extension loaded mid-game, no refresh).
   */
  setTurnFallback(mine: boolean, rolled: boolean): void {
    if (this.wsTurnSeen) return;
    if (mine && !this.myTurn) this.pending = null;
    this.myTurn = mine;
    this.rolledThisTurn = rolled;
  }

  onYouRolled(): void {
    this.rolledThisTurn = true;
    if (this.pending?.kind === "roll") this.pending = null;
  }

  onConfirm(kind: ActionKind): void {
    if (this.pending?.kind === kind) this.pending = null;
    if (kind === "move-robber") this.robberPending = false;
  }

  /** A 7 was rolled or a knight played — the current player must move the robber. */
  setRobberPending(pending: boolean): void {
    this.robberPending = pending;
  }

  view(): AutopilotView {
    return { enabled: this.enabled, status: this.learner.status(), note: this.note };
  }

  tick(ctx: {
    tracker: TrackerState | null;
    gs: { state: GameState; youPlayer: PlayerId | null } | null;
    advice: PlacementAdvice | null;
    fit: LiveStrategyFit | null;
    robberHex?: { x: number; y: number } | null;
    now?: number;
  }): void {
    if (!this.enabled) return;
    const now = ctx.now ?? Date.now();

    if (this.pending) {
      if (now - this.pending.t > 8000) {
        // Learn from the mistake: the action produced nothing.
        if (this.pending.via === "ws") {
          // wrong template — discard and re-learn from the next manual use
          this.learner.discard(this.pending.kind);
          this.note = `"${this.pending.kind}" wasn't confirmed — template discarded, do it manually once to re-learn`;
        } else {
          this.note = `clicked "${this.pending.kind}" but the game didn't react — do it manually this time`;
        }
        this.pending = null;
      }
      return;
    }
    // The robber is only ever yours to move on your own turn. In DOM-fallback
    // sessions the "Your Turn" banner is REPLACED by the robber banner, so
    // pending alone must open the gate there; with WS turn state captured the
    // turn must agree, so a stray banner match can never act out of turn.
    const robberMine = this.robberPending && (this.myTurn || !this.wsTurnSeen);
    if (!robberMine && (!this.myTurn || !ctx.tracker || !ctx.tracker.youName)) {
      this.note = "on — waiting for your turn";
      return;
    }
    if (!ctx.tracker || !ctx.tracker.youName) return;

    const decision = decideNext({
      tracker: ctx.tracker,
      youName: ctx.tracker.youName,
      fit: ctx.fit,
      gs: ctx.gs,
      advice: ctx.advice,
      rolledThisTurn: this.rolledThisTurn,
      robberPending: robberMine,
      robberHex: ctx.robberHex,
    });
    if (!decision) {
      this.note = robberMine
        ? "on — move the robber manually (board not captured or no good tile)"
        : "on — nothing to do";
      return;
    }

    // Preferred: a learned WebSocket template (exact, works for placements).
    const frame = this.learner.buildFrame(decision.kind, decision.coord);
    if (frame) {
      this.send(frame);
      this.pending = { kind: decision.kind, t: now, via: "ws" };
      this.note = `acting: ${decision.describe}`;
      return;
    }
    // Zero-setup fallback: click the game's own button for non-spatial acts.
    if (decision.kind === "roll" || decision.kind === "end-turn" || decision.kind === "buy-dev") {
      const clicked = this.domAct(decision.kind);
      if (clicked) {
        this.pending = { kind: decision.kind, t: now, via: "dom" };
        this.note = `acting: ${decision.describe} (clicked game button)`;
        return;
      }
    }
    this.note =
      decision.kind === "move-robber"
        ? `on — move the robber manually once (${decision.describe}) so I can learn it`
        : `on — "${decision.kind}" not learned yet, do it manually once`;
  }
}
