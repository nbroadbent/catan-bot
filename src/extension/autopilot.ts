import { GameState, PlayerId, RESOURCES } from "../engine/types";
import { vertexPips } from "../engine/board";
import { isVertexBuildable } from "../engine/analysis";
import { pixelToColonistCorner, pixelsToColonistEdge } from "./coords";
import { ActionKind, ProtocolLearner } from "./protocolLearner";
import { LiveStrategyFit } from "./copilot";
import { PlacementAdvice } from "./placement";
import { TrackerState } from "./tracker";

export interface AutopilotDecision {
  kind: ActionKind;
  coord?: { x: number; y: number; z: number };
  describe: string;
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
}): AutopilotDecision | null {
  const { tracker, youName, fit, gs, advice, rolledThisTurn } = opts;
  const you = tracker.players.get(youName);
  if (!you || !gs || gs.youPlayer === null) return null;
  const board = gs.state.board;

  // Setup phase: place the advised settlement / road.
  if (advice?.phase === "setup") {
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
    } else if (item === "dev") {
      return { kind: "buy-dev", describe: "buy a development card" };
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
 * event) before the next — one unconfirmed action disables autopilot.
 *
 * Robber moves, discards, and trades are deliberately out of scope: the
 * overlay advises and the human acts.
 */
export class Autopilot {
  enabled = false;
  private myTurn = false;
  private rolledThisTurn = false;
  private pending: { kind: ActionKind; t: number } | null = null;
  private note = "off";

  constructor(
    private learner: ProtocolLearner,
    private send: (frame: unknown) => void,
  ) {}

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.note = on ? "on — waiting for your turn" : "off";
    if (!on) this.pending = null;
  }

  onTurnState(currentColor: number, myColor: number | null): void {
    const mine = myColor !== null && currentColor === myColor;
    if (mine && !this.myTurn) this.rolledThisTurn = false;
    if (!mine && this.myTurn && this.pending?.kind === "end-turn") this.pending = null;
    this.myTurn = mine;
  }

  onYouRolled(): void {
    this.rolledThisTurn = true;
    if (this.pending?.kind === "roll") this.pending = null;
  }

  onConfirm(kind: ActionKind): void {
    if (this.pending?.kind === kind) this.pending = null;
  }

  view(): AutopilotView {
    return { enabled: this.enabled, status: this.learner.status(), note: this.note };
  }

  tick(ctx: {
    tracker: TrackerState | null;
    gs: { state: GameState; youPlayer: PlayerId | null } | null;
    advice: PlacementAdvice | null;
    fit: LiveStrategyFit | null;
    now?: number;
  }): void {
    if (!this.enabled) return;
    const now = ctx.now ?? Date.now();

    if (this.pending) {
      if (now - this.pending.t > 8000) {
        // Learn from the mistake: the template produced nothing, so it's
        // wrong — discard it and re-learn from the next manual use. Autopilot
        // stays on and simply skips this action kind until then.
        this.learner.discard(this.pending.kind);
        this.note = `"${this.pending.kind}" wasn't confirmed — template discarded, do it manually once to re-learn`;
        this.pending = null;
      }
      return;
    }
    if (!this.myTurn || !ctx.tracker || !ctx.tracker.youName) {
      this.note = "on — waiting for your turn";
      return;
    }

    const decision = decideNext({
      tracker: ctx.tracker,
      youName: ctx.tracker.youName,
      fit: ctx.fit,
      gs: ctx.gs,
      advice: ctx.advice,
      rolledThisTurn: this.rolledThisTurn,
    });
    if (!decision) {
      this.note = "on — nothing to do";
      return;
    }

    const frame = this.learner.buildFrame(decision.kind, decision.coord);
    if (!frame) {
      this.note = `on — "${decision.kind}" not learned yet, do it manually once`;
      return;
    }
    this.send(frame);
    this.pending = { kind: decision.kind, t: now };
    this.note = `acting: ${decision.describe}`;
  }
}
