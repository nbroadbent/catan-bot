import { GameState, PlayerId, RESOURCES, Resource, pips } from "../engine/types";
import { vertexPips } from "../engine/board";
import { isVertexBuildable } from "../engine/analysis";
import { pixelToColonistCorner, pixelsToColonistEdge } from "./coords";
import { DomActionKind, tryDomAction, tryDomDiscard } from "./domActions";
import { ActionKind, ProtocolLearner } from "./protocolLearner";
import { LiveStrategyFit, expectedProduction, planDiscard } from "./copilot";
import { PlacementAdvice } from "./placement";
import { RESOURCE_TO_CARD_ID, TrackerState, handTotal } from "./tracker";

export interface AutopilotDecision {
  kind: ActionKind;
  coord?: { x: number; y: number; z?: number };
  /** for "discard": how many of each resource to give up */
  cards?: Partial<Record<Resource, number>>;
  /** for "bank-trade": give `giveCount` of `give` to get one `get` */
  trade?: { give: Resource; get: Resource; giveCount: number };
  /** for "play-monopoly": the resource to steal from everyone */
  resource?: Resource;
  describe: string;
}

const BUILD_COSTS: Record<"road" | "settlement" | "city" | "dev", Partial<Record<Resource, number>>> = {
  road: { wood: 1, brick: 1 },
  settlement: { wood: 1, brick: 1, sheep: 1, wheat: 1 },
  city: { ore: 3, wheat: 2 },
  dev: { ore: 1, sheep: 1, wheat: 1 },
};

type BankTrade = { give: Resource; get: Resource; giveCount: number };

/** Can we afford `cost` after trading surplus at these bank/port ratios? */
export function affordableWithTrades(
  hand: Record<Resource, number>,
  ratios: Partial<Record<Resource, number>>,
  cost: Partial<Record<Resource, number>>,
): boolean {
  let missing = 0;
  for (const r of RESOURCES) missing += Math.max(0, (cost[r] ?? 0) - hand[r]);
  if (missing === 0) return true;
  // cards we can mint from surplus (each `ratio` spare of a resource -> 1 card)
  let power = 0;
  for (const r of RESOURCES) {
    const spare = hand[r] - (cost[r] ?? 0);
    if (spare > 0) power += Math.floor(spare / (ratios[r] ?? 4));
  }
  return power >= missing;
}

/**
 * One bank/port trade toward affording `cost`: give surplus of the resource
 * the strategy values least (at its ratio) to get the card the build is most
 * short of. Null when no tradeable surplus exists.
 */
export function tradeTowardCost(
  hand: Record<Resource, number>,
  ratios: Partial<Record<Resource, number>>,
  cost: Partial<Record<Resource, number>>,
  weights: Record<Resource, number>,
): BankTrade | null {
  let need: Resource | null = null;
  let needGap = 0;
  for (const r of RESOURCES) {
    const gap = (cost[r] ?? 0) - hand[r];
    if (gap > needGap) {
      needGap = gap;
      need = r;
    }
  }
  if (!need) return null;
  let best: { give: Resource; ratio: number; score: number } | null = null;
  for (const g of RESOURCES) {
    if (g === need) continue;
    const ratio = ratios[g] ?? 4;
    const surplus = hand[g] - (cost[g] ?? 0);
    if (surplus < ratio) continue; // can't trade this away without hurting the build
    const score = surplus - weights[g] * ratio; // prefer least-valued, most-spare
    if (!best || score > best.score) best = { give: g, ratio, score };
  }
  return best ? { give: best.give, get: need, giveCount: best.ratio } : null;
}

/** A trade toward the strategy's first not-yet-affordable build (over-limit dump). */
export function planBankTrade(
  hand: Record<Resource, number>,
  ratios: Partial<Record<Resource, number>>,
  fit: LiveStrategyFit,
  canBuild: (item: keyof typeof BUILD_COSTS) => boolean = () => true,
): BankTrade | null {
  for (const item of fit.strategy.buildOrder) {
    if (!canBuild(item)) continue; // bank/supply exhausted for this build
    const cost = BUILD_COSTS[item];
    const short = RESOURCES.some((r) => (cost[r] ?? 0) > hand[r]);
    if (!short) return null; // already affordable — build, don't trade
    const trade = tradeTowardCost(hand, ratios, cost, fit.strategy.weights);
    if (trade) return trade;
  }
  return null;
}

/** Flatten a discard plan into colonist wire card ids. */
export function cardsToIds(cards: Partial<Record<Resource, number>>): number[] {
  const ids: number[] = [];
  for (const [r, n] of Object.entries(cards)) {
    for (let i = 0; i < (n ?? 0); i++) ids.push(RESOURCE_TO_CARD_ID[r as Resource]);
  }
  return ids;
}

function describeCards(cards: Partial<Record<Resource, number>>): string {
  return Object.entries(cards)
    .map(([r, n]) => `${n} ${r}`)
    .join(" + ");
}

/**
 * Choose the robber tile: maximize the value denied to opponents (pips ×
 * buildings) minus the value denied to yourself, never re-placing on the
 * current robber tile. Respects friendly robber via `canRob`: a tile with any
 * un-robbable opponent (< 3 VP) is illegal to place on — colonist rejects it —
 * so we skip it and, if nothing is robbable, move the robber to a neutral tile.
 */
export function bestRobberHex(
  state: GameState,
  youPlayer: PlayerId,
  current: { x: number; y: number } | null,
  canRob: (player: PlayerId) => boolean = () => true,
): { hex: { x: number; y: number }; victim: PlayerId | null; describe: string } | null {
  const oppOnTile = (hexId: number) =>
    state.buildings.filter(
      (b) => b.player !== youPlayer && state.board.vertices[b.vertexId].hexIds.includes(hexId),
    );
  // Friendly robber: the tile is legal only if NO opponent on it is un-robbable.
  const tileLegal = (hexId: number) => oppOnTile(hexId).every((b) => canRob(b.player));

  let best: { score: number; hexId: number } | null = null;
  for (const hex of state.board.hexes) {
    if (hex.kind === "desert" || hex.token === null) continue;
    if (current && hex.q === current.x && hex.r === current.y) continue;
    if (!tileLegal(hex.id)) continue;
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

  if (best) {
    const hex = state.board.hexes[best.hexId];
    const victim = oppOnTile(best.hexId)[0]?.player ?? null;
    return { hex: { x: hex.q, y: hex.r }, victim, describe: `robber to the ${hex.token}-${hex.kind} tile` };
  }

  // Nothing robbable (friendly robber + every opponent under 3 VP): the robber
  // still must move to a LEGAL tile — one touching no un-robbable opponent.
  // Prefer a tile with no buildings at all so we block no one, including us.
  const neutral =
    state.board.hexes.find(
      (h) =>
        h.kind !== "desert" &&
        !(current && h.q === current.x && h.r === current.y) &&
        state.buildings.every((b) => !state.board.vertices[b.vertexId].hexIds.includes(h.id)),
    ) ?? state.board.hexes.find((h) => h.kind !== "desert" && tileLegal(h.id));
  if (!neutral) return null;
  return {
    hex: { x: neutral.q, y: neutral.r },
    victim: null,
    describe: `robber to a neutral tile (friendly robber — no one has 3+ points to rob)`,
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
  discardPending?: boolean;
  discardLimit?: number;
  /** a knight card is in hand and playable this turn (not bought this turn) */
  knightAvailable?: boolean;
  /** dev cards left in the bank; 0 = sold out, never try to buy (null = unknown) */
  bankDevCards?: number | null;
  /** building pieces left in our supply; 0 = can't build that piece (null = unknown) */
  piecesLeft?: { settlements: number | null; cities: number | null; roads: number | null };
  /** we hold a playable monopoly card this turn */
  hasMonopoly?: boolean;
  /** friendly robber: whether a given player may be robbed (>= 3 VP) */
  canRob?: (player: PlayerId) => boolean;
}): AutopilotDecision | null {
  const { tracker, youName, fit, gs, advice, rolledThisTurn, robberPending, robberHex, discardPending } =
    opts;
  const you = tracker.players.get(youName);
  if (!you) return null;
  const board = gs?.state.board;
  const limit = opts.discardLimit ?? tracker.discardLimit;
  const handSize = handTotal(you);

  // Forced discard (a 7 while over the limit) resolves before anything else:
  // pick the worst cards ourselves instead of letting the game choose.
  if (discardPending && handSize > limit) {
    const cards = planDiscard(you.hand, Math.floor(handSize / 2), fit);
    return {
      kind: "discard",
      cards,
      describe: `discard ${describeCards(cards)} (keeping the next build)`,
    };
  }

  // Robber placement takes priority: it blocks everything until resolved.
  if (robberPending && gs && gs.youPlayer !== null && board) {
    const target = bestRobberHex(gs.state, gs.youPlayer, robberHex ?? null, opts.canRob);
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

  // Is a playable knight worth playing this turn, and why? Play it to unblock
  // your own tile, or to grow the army when the plan is Cities & Development.
  const knightReason = ((): string | null => {
    if (!opts.knightAvailable) return null;
    const blockedMine =
      !!robberHex &&
      !!gs &&
      gs.youPlayer !== null &&
      !!board &&
      gs.state.buildings.some(
        (b) =>
          b.player === gs.youPlayer &&
          board.vertices[b.vertexId].hexIds.some(
            (h) => board.hexes[h].q === robberHex.x && board.hexes[h].r === robberHex.y,
          ),
      );
    if (blockedMine) return "the robber is on your tile";
    if (fit && fit.strategy.id === "city-dev") return "building toward Largest Army";
    return null;
  })();

  // Knight timing: play it BEFORE rolling by default (move the robber / grow
  // the army first). But if you're holding enough that a 7 would force a
  // discard (over the limit), roll first — then play it — so it isn't spent
  // into a discard.
  const overLimit = handSize > limit;
  if (knightReason && !rolledThisTurn && !overLimit) {
    return { kind: "play-knight", describe: `play a knight before rolling — ${knightReason}` };
  }

  if (!rolledThisTurn) return { kind: "roll", describe: "roll the dice" };
  if (!fit) return null;

  // After rolling (we were over the limit, or it only became worth it now).
  if (knightReason) {
    return { kind: "play-knight", describe: `play a knight — ${knightReason}` };
  }

  // Sold-out bank / exhausted piece supply: never try (or trade toward) a
  // build we have no piece for. null (unknown) is treated as available.
  const devAvailable = opts.bankDevCards !== 0;
  const pieces = opts.piecesLeft;
  const hasPiece = (item: "settlement" | "city" | "road"): boolean => {
    if (!pieces) return true;
    const left = item === "settlement" ? pieces.settlements : item === "city" ? pieces.cities : pieces.roads;
    return left === null || left > 0;
  };
  const canBuild = (item: keyof typeof COSTS): boolean =>
    item === "dev" ? devAvailable : hasPiece(item);

  const afford = (item: keyof typeof COSTS): boolean =>
    RESOURCES.every((r) => you.hand[r] >= ((COSTS[item][r] as number | undefined) ?? 0));

  // Monopoly: play it for maximum HAUL — steal the resource opponents hold the
  // MOST of (estimated from their production mix × their total cards), breaking
  // ties toward a resource our next build needs. Only when opponents are
  // card-rich enough that a monopoly is worth spending on.
  if (opts.hasMonopoly) {
    const opponents = [...tracker.players.values()].filter((p) => p.name !== youName);
    const oppCards = opponents.reduce((s, p) => s + (p.serverCards ?? handTotal(p)), 0);
    if (oppCards >= 5) {
      // Estimated opponent holdings of each resource: production-mix share of
      // their card total. Resources they pump out and don't spend pile up.
      const prodByRes = Object.fromEntries(RESOURCES.map((r) => [r, 0])) as Record<Resource, number>;
      for (const p of opponents) {
        const prod = expectedProduction(p);
        for (const r of RESOURCES) prodByRes[r] += prod[r];
      }
      const totalProd = RESOURCES.reduce((s, r) => s + prodByRes[r], 0);
      // production-mix share of their cards; if we haven't learned their income
      // yet, assume an even spread so a card-rich opponent still triggers it.
      const estHeld = (r: Resource) =>
        totalProd > 0 ? (prodByRes[r] / totalProd) * oppCards : oppCards / RESOURCES.length;

      // do we need this resource for our next build? (tiebreaker)
      const shortForBuild = (r: Resource) =>
        fit.strategy.buildOrder.some((item) => (BUILD_COSTS[item][r] ?? 0) > you.hand[r]);

      let bestRes: Resource | null = null;
      let bestScore = 0;
      for (const r of RESOURCES) {
        const score = estHeld(r) + (shortForBuild(r) ? 0.75 : 0);
        if (score > bestScore) {
          bestScore = score;
          bestRes = r;
        }
      }
      // only worth it if the expected haul is meaningful (~2+ cards)
      if (bestRes && estHeld(bestRes) >= 2) {
        return {
          kind: "play-monopoly",
          resource: bestRes,
          describe: `play monopoly on ${bestRes} (~${estHeld(bestRes).toFixed(0)} cards from opponents)`,
        };
      }
    }
  }

  // Road eagerness guard (per play feedback): don't build a speculative road
  // that just telegraphs a spot the opponent then takes. Only build the advised
  // road when it OPENS a legal settlement corner AND we can afford the road and
  // a settlement together — so we claim the spot the SAME turn (road then
  // settlement), before the opponent gets a turn.
  const advisedRoadOpensSpot = !!(
    advice &&
    advice.roadEdges.length > 0 &&
    board &&
    gs &&
    gs.youPlayer !== null &&
    (() => {
      const e = board.edges[advice.roadEdges[0]];
      return isVertexBuildable(gs.state, e.a) || isVertexBuildable(gs.state, e.b);
    })()
  );
  // road (wood+brick) + settlement (wood+brick+sheep+wheat) in one turn.
  const canRoadThenSettle =
    you.hand.wood >= 2 && you.hand.brick >= 2 && you.hand.sheep >= 1 && you.hand.wheat >= 1;

  const buildDecision = (item: keyof typeof COSTS): AutopilotDecision | null => {
    if (item === "dev") {
      if (!devAvailable) return null;
      return { kind: "buy-dev", describe: "buy a development card" };
    }
    // No piece left in supply -> can't build it (5 settlements, 4 cities).
    if (!hasPiece(item)) return null;
    // Spatial builds need the captured board for coordinates.
    if (!gs || gs.youPlayer === null || !board) return null;
    if (item === "city") {
      const settlements = gs.state.buildings.filter(
        (b) => b.player === gs.youPlayer && b.kind === "settlement",
      );
      if (settlements.length === 0) return null;
      const target = settlements.reduce((a, b) =>
        vertexPips(board, a.vertexId) >= vertexPips(board, b.vertexId) ? a : b,
      );
      const v = board.vertices[target.vertexId];
      const coord = pixelToColonistCorner(v.x, v.y);
      if (coord) return { kind: "build-city", coord, describe: "upgrade best settlement to a city" };
    } else if (item === "settlement") {
      const spot = bestPlaceableNow(gs.state, gs.youPlayer);
      if (spot === null) return null;
      const v = board.vertices[spot];
      const coord = pixelToColonistCorner(v.x, v.y);
      if (coord) return { kind: "build-settlement", coord, describe: "settlement on your network" };
    } else if (item === "road") {
      // Only when the road opens a spot AND we can settle it this turn.
      if (advice && advice.roadEdges.length > 0 && advisedRoadOpensSpot && canRoadThenSettle) {
        const e = board.edges[advice.roadEdges[0]];
        const coord = pixelsToColonistEdge(board.vertices[e.a], board.vertices[e.b]);
        if (coord) {
          return { kind: "build-road", coord, describe: "road to open a settlement spot (settling it this turn)" };
        }
      }
    }
    return null;
  };

  for (const item of fit.strategy.buildOrder) {
    if (!afford(item)) continue;
    const d = buildDecision(item);
    if (d) return d;
  }

  // Hand-size pressure: at or over the discard limit, shed cards into any
  // affordable build rather than risk a 7 halving the hand. (>= so it acts
  // AT the limit, not only strictly over it.)
  if (handSize >= limit) {
    for (const item of ["city", "settlement", "dev", "road"] as const) {
      if (!afford(item)) continue;
      const d = buildDecision(item);
      if (d) {
        return { ...d, describe: `${d.describe} (dumping cards — at the ${limit}-card limit)` };
      }
    }
  }

  // Proactive bank/port trading: trade toward the FIRST strategy build we can
  // COMPLETE with trades — at any hand size, not just when over the limit.
  // e.g. trade 4 wood for the wheat that finishes a city. Only surplus of the
  // least-valued resource is given, so we never trade away what the build needs.
  for (const item of fit.strategy.buildOrder) {
    if (item === "road") continue; // don't 4:1-trade toward a cheap, eager road
    if (!canBuild(item)) continue; // bank/supply exhausted for this build
    const cost = BUILD_COSTS[item];
    if (afford(item)) continue; // would have built it already
    if (!affordableWithTrades(you.hand, you.bankRatio, cost)) continue;
    const trade = tradeTowardCost(you.hand, you.bankRatio, cost, fit.strategy.weights);
    if (trade) {
      return {
        kind: "bank-trade",
        trade,
        describe: `bank-trade ${trade.giveCount} ${trade.give} for ${trade.get} toward a ${item}`,
      };
    }
  }

  // At/over the limit with no build reachable: dump the most expendable surplus
  // so a 7 doesn't take half of it.
  if (handSize >= limit) {
    const trade = planBankTrade(you.hand, you.bankRatio, fit, canBuild);
    if (trade) {
      return {
        kind: "bank-trade",
        trade,
        describe: `bank-trade ${trade.giveCount} ${trade.give} for ${trade.get} (at the ${limit}-card limit)`,
      };
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
 * Handles rolls, the strategy build order, robber placement, forced discards
 * (choosing the worst cards itself), and ending the turn. Trades stay manual
 * (the overlay advises).
 */
export class Autopilot {
  enabled = false;
  wsTurnSeen = false;
  robberPending = false;
  discardPending = false;
  private myTurn = false;
  /** the two independent turn signals; myTurn is their OR */
  private wsMine = false;
  private domMine = false;
  private rolledThisTurn = false;
  /** dev-card rules: one play per turn, none the turn it was bought */
  private devPlayedThisTurn = false;
  private devsBoughtThisTurn = 0;
  private pending: { kind: ActionKind; t: number; via: "ws" | "dom"; label?: string } | null =
    null;
  /** DOM controls (per action) we clicked but the game never confirmed. */
  private domFailed = new Map<DomActionKind, Set<string>>();
  private note = "off";

  constructor(
    private learner: ProtocolLearner,
    /**
     * Send the decision as real colonist WebSocket action frames. Returns true
     * if it was dispatched (channel known + action resolvable). This is the
     * primary path now that the outbound protocol is reverse-engineered.
     */
    private dispatch: (decision: AutopilotDecision) => boolean = () => false,
    private domAct: (kind: DomActionKind, exclude?: ReadonlySet<string>) => string | null = (
      kind,
      exclude,
    ) => tryDomAction(kind, document, exclude),
    private domDiscard: (cards: Partial<Record<Resource, number>>) => string | null = tryDomDiscard,
  ) {}

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.note = on ? "on — waiting for your turn" : "off";
    if (!on) this.pending = null;
  }

  onTurnState(currentColor: number, myColor: number | null): void {
    this.wsTurnSeen = true;
    this.wsMine = myColor !== null && currentColor === myColor;
    this.recomputeTurn();
  }

  /**
   * DOM turn signal from colonist's "Your Turn" banner. Runs EVERY tick, not
   * only as a WS fallback: colonist's turn-state color ids don't always line
   * up with our detected `myColor` (or myColor may never arrive), and when
   * they don't, the WS signal alone would leave autopilot thinking it's never
   * our turn. The banner is authoritative for the local player — colonist only
   * shows it to you on your own turn — so we OR it with the WS signal.
   */
  noteDomTurn(mine: boolean): void {
    this.domMine = mine;
    this.recomputeTurn();
  }

  /** Fold the WS and DOM turn signals; reset per-turn state on the rising edge. */
  private recomputeTurn(): void {
    const mine = this.wsMine || this.domMine;
    if (mine && !this.myTurn) {
      // fresh turn: roll again, replay dev/knight limits, retry every control
      this.rolledThisTurn = false;
      this.devPlayedThisTurn = false;
      this.devsBoughtThisTurn = 0;
      this.domFailed.clear();
    }
    if (!mine && this.myTurn && this.pending?.kind === "end-turn") this.pending = null;
    this.myTurn = mine;
  }

  onYouRolled(): void {
    this.rolledThisTurn = true;
    if (this.pending?.kind === "roll") this.pending = null;
  }

  onConfirm(kind: ActionKind): void {
    if (this.pending?.kind === kind) this.pending = null;
    if (kind === "move-robber") this.robberPending = false;
    if (kind === "discard") this.discardPending = false;
    if (kind === "play-knight" || kind === "play-monopoly") this.devPlayedThisTurn = true;
    if (kind === "buy-dev") this.devsBoughtThisTurn++;
  }

  /** A non-knight dev card was played manually (YoP, Monopoly, Road Building). */
  markDevPlayed(): void {
    this.devPlayedThisTurn = true;
  }

  /** A 7 was rolled or a knight played — the current player must move the robber. */
  setRobberPending(pending: boolean): void {
    this.robberPending = pending;
  }

  /** The game is asking for discards (a 7 while someone is over the limit). */
  setDiscardPending(pending: boolean): void {
    this.discardPending = pending;
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
    /** knight cards visible in your hand (DOM count; includes unplayable new buys) */
    knightsInHand?: number;
    /** dev cards left in the bank (0 = sold out) */
    bankDevCards?: number | null;
    /** building pieces left in our supply (0 = can't build that piece) */
    piecesLeft?: { settlements: number | null; cities: number | null; roads: number | null };
    /** dev-card type ids we hold (13 = monopoly) */
    myDevCardIds?: number[];
    /** friendly robber: whether a given player may be robbed (>= 3 VP) */
    canRob?: (player: PlayerId) => boolean;
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
          // Wrong control — remember it so the retry clicks the next candidate.
          if (this.pending.label && this.pending.kind !== "discard") {
            const kind = this.pending.kind as DomActionKind;
            const failed = this.domFailed.get(kind) ?? new Set<string>();
            failed.add(this.pending.label);
            this.domFailed.set(kind, failed);
          }
          this.note = `clicked "${this.pending.label ?? this.pending.kind}" but the game didn't react — trying another control`;
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
    // A discard is NOT turn-bound: anyone over the limit discards on a 7. The
    // over-the-limit hand check keeps stray banner matches from acting.
    const you = ctx.tracker?.youName ? ctx.tracker.players.get(ctx.tracker.youName) : undefined;
    const mustDiscard =
      this.discardPending && !!you && handTotal(you) > (ctx.tracker?.discardLimit ?? 9);
    if (!robberMine && !mustDiscard && (!this.myTurn || !ctx.tracker || !ctx.tracker.youName)) {
      // Surface which turn signals are firing so a detection gap is diagnosable.
      const sig = this.domMine ? "banner" : this.wsMine ? "ws" : "none";
      this.note = `on — waiting for your turn (signal: ${sig})`;
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
      discardPending: mustDiscard,
      // Knights held (dev-card id 11, from ground-truth state) beyond any dev
      // bought this turn (a fresh buy can't be played), and no dev played yet.
      knightAvailable:
        !this.devPlayedThisTurn &&
        ((ctx.myDevCardIds ?? []).filter((id) => id === 11).length ||
          (ctx.knightsInHand ?? 0)) > this.devsBoughtThisTurn,
      bankDevCards: ctx.bankDevCards,
      piecesLeft: ctx.piecesLeft,
      // Playable only if we hold a monopoly (id 13), haven't played a dev this
      // turn, and hold more than we bought this turn (a fresh buy can't be played).
      hasMonopoly:
        !this.devPlayedThisTurn &&
        (ctx.myDevCardIds ?? []).filter((id) => id === 13).length > this.devsBoughtThisTurn,
      canRob: ctx.canRob,
    });
    if (!decision) {
      this.note = robberMine
        ? "on — move the robber manually (board not captured or no good tile)"
        : "on — nothing to do";
      return;
    }

    // Preferred: dispatch real colonist WebSocket action frames (rolls, builds,
    // robber, end turn) — reverse-engineered from the protocol, works for
    // placements too.
    if (this.dispatch(decision)) {
      this.pending = { kind: decision.kind, t: now, via: "ws" };
      this.note = `acting: ${decision.describe}`;
      return;
    }
    // Zero-setup fallback: click the game's own button for non-spatial acts.
    if (decision.kind === "roll" || decision.kind === "end-turn" || decision.kind === "buy-dev") {
      const clicked = this.domAct(decision.kind, this.domFailed.get(decision.kind));
      if (clicked) {
        this.pending = { kind: decision.kind, t: now, via: "dom", label: clicked };
        this.note = `acting: ${decision.describe} (clicked game button)`;
        return;
      }
    }
    // Zero-setup fallback: pick the cards in the game's own discard dialog.
    if (decision.kind === "discard" && decision.cards) {
      const clicked = this.domDiscard(decision.cards);
      if (clicked) {
        this.pending = { kind: "discard", t: now, via: "dom" };
        this.note = `acting: ${decision.describe} (clicked the discard dialog)`;
        return;
      }
    }
    // Board placements (settlement/road/city/robber) can't be automated: they
    // need a click on colonist's canvas board, which has no clickable DOM, and
    // the outbound action format isn't reconstructable from the socket. Point
    // the human at the exact spot instead.
    const spatial =
      decision.kind === "build-settlement" ||
      decision.kind === "build-road" ||
      decision.kind === "build-city" ||
      decision.kind === "move-robber";
    this.note = spatial
      ? `▶ Your click: ${decision.describe} — highlighted ① on the map above (board clicks aren't automated)`
      : decision.kind === "discard"
        ? `on — pick the discards manually once (${decision.describe}) so I can learn it`
        : decision.kind === "play-knight"
          ? `on — play a knight manually once so I can learn it (${decision.describe})`
          : `on — "${decision.kind}" not learned yet, do it manually once`;
  }
}
