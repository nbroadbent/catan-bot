import { GameState, PlayerId } from "../../engine/types";
import { AutopilotDecision, decideNext } from "../autopilot";
import { LiveStrategyFit } from "../copilot";
import { PlacementAdvice } from "../placement";
import { ActionKind } from "../protocolLearner";
import { TrackerState, handTotal } from "../tracker";

/**
 * Rush mode pilot. Rush has no turns: nobody rolls, nobody ends a turn, the
 * dice fire on a timer and everyone builds the moment they can afford to.
 * The only things a player ever has to DO are:
 *   - place the two setup settlements (+ roads),
 *   - build roads, settlements and cities,
 *   - move the robber (a 7 or a knight) and discard on a 7.
 *
 * This pilot therefore carries none of the turn machinery of `Autopilot`
 * (turn signals, roll gating, end-turn, one-dev-per-turn) and restricts the
 * shared decision engine to exactly those actions via an allow-list. It reuses
 * `decideNext` for WHAT to build (claims, placement discipline, robber
 * targeting) so Rush and the turn game never drift apart strategically.
 */
export const RUSH_ACTIONS: ReadonlySet<ActionKind> = new Set<ActionKind>([
  "build-settlement",
  "build-road",
  "build-city",
  "move-robber",
  "discard",
]);

export interface RushDecideOpts {
  tracker: TrackerState;
  youName: string;
  fit: LiveStrategyFit | null;
  gs: { state: GameState; youPlayer: PlayerId | null } | null;
  advice: PlacementAdvice | null;
  robberPending: boolean;
  robberHex?: { x: number; y: number } | null;
  discardPending: boolean;
  piecesLeft?: { settlements: number | null; cities: number | null; roads: number | null };
  canRob?: (player: PlayerId) => boolean;
}

/** Pure Rush decision: a placement, a robber move, a discard — or nothing. */
export function decideRush(opts: RushDecideOpts): AutopilotDecision | null {
  const d = decideNext({
    tracker: opts.tracker,
    youName: opts.youName,
    fit: opts.fit,
    gs: opts.gs,
    advice: opts.advice,
    rolledThisTurn: true, // there is no roll in Rush — never wait for one
    robberPending: opts.robberPending,
    robberHex: opts.robberHex,
    discardPending: opts.discardPending,
    piecesLeft: opts.piecesLeft,
    canRob: opts.canRob,
    allow: RUSH_ACTIONS,
  });
  // belt and braces: the allow-list already filters, but never leak a
  // turn-game action into Rush even if a future decideNext path forgets it
  return d && RUSH_ACTIONS.has(d.kind) ? d : null;
}

export interface RushView {
  enabled: boolean;
  note: string;
}

/** How long to wait for the game to confirm an action before retrying. */
const PENDING_TIMEOUT_MS = 5000;

/**
 * The Rush executor: ticks continuously (no "is it my turn" gate), sends one
 * decision at a time, and waits for the game to confirm it (board/log event)
 * before the next. Placements are the one thing worth retrying, so an
 * unconfirmed action simply times out and the next tick decides afresh.
 */
export class RushPilot {
  enabled = false;
  robberPending = false;
  discardPending = false;
  private pending: { kind: ActionKind; t: number } | null = null;
  private note = "off";

  constructor(private dispatch: (decision: AutopilotDecision) => boolean) {}

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.note = on ? "on — Rush: building whenever affordable" : "off";
    if (!on) this.pending = null;
  }

  setRobberPending(pending: boolean): void {
    this.robberPending = pending;
  }

  setDiscardPending(pending: boolean): void {
    this.discardPending = pending;
  }

  onConfirm(kind: ActionKind): void {
    if (this.pending?.kind === kind) this.pending = null;
    if (kind === "move-robber") this.robberPending = false;
    if (kind === "discard") this.discardPending = false;
  }

  view(): RushView {
    return { enabled: this.enabled, note: this.note };
  }

  tick(ctx: Omit<RushDecideOpts, "youName" | "robberPending" | "discardPending"> & { now?: number }): void {
    if (!this.enabled) return;
    const now = ctx.now ?? Date.now();
    if (this.pending) {
      if (now - this.pending.t <= PENDING_TIMEOUT_MS) return;
      this.note = `"${this.pending.kind}" wasn't confirmed — retrying`;
      this.pending = null;
    }
    const youName = ctx.tracker.youName;
    if (!youName) return;
    const you = ctx.tracker.players.get(youName);
    // a discard is only real when the hand is actually oversized
    const mustDiscard =
      this.discardPending && !!you && handTotal(you) > ctx.tracker.discardLimit;

    const decision = decideRush({
      ...ctx,
      youName,
      robberPending: this.robberPending,
      discardPending: mustDiscard,
    });
    if (!decision) {
      this.note = this.robberPending
        ? "on — move the robber manually (no good tile found)"
        : "on — Rush: waiting for resources";
      return;
    }
    if (this.dispatch(decision)) {
      this.pending = { kind: decision.kind, t: now };
      this.note = `acting: ${decision.describe}`;
    } else {
      this.note = `▶ Your click: ${decision.describe} (couldn't send it)`;
    }
  }
}
