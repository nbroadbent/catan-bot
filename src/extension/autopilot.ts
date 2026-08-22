import { GameState, PlayerId, RESOURCES, Resource, pips } from "../engine/types";
import { vertexPips } from "../engine/board";
import { isVertexBuildable } from "../engine/analysis";
import { pixelToColonistCorner, pixelsToColonistEdge } from "./coords";
import { DomActionKind, tryDomAction, tryDomDiscard } from "./domActions";
import { ActionKind, ProtocolLearner } from "./protocolLearner";
import { LiveStrategyFit, expectedProduction, planDiscard } from "./copilot";
import { PlacementAdvice } from "./placement";
import { RESOURCE_TO_CARD_ID, TrackerState, handTotal, visibleVp } from "./tracker";
import { TradeOffer, decideTradeResponse } from "./trading";

export interface AutopilotDecision {
  kind: ActionKind;
  coord?: { x: number; y: number; z?: number };
  /** for "discard": how many of each resource to give up */
  cards?: Partial<Record<Resource, number>>;
  /** for "bank-trade": give `giveCount` of `give` to get one `get` */
  trade?: { give: Resource; get: Resource; giveCount: number };
  /** for "play-monopoly": the resource to steal from everyone */
  resource?: Resource;
  /** for "play-year-of-plenty": the two resources to take from the bank */
  resources?: [Resource, Resource];
  /** for "build-road": a free Road Building placement (no intent, no cost) */
  free?: boolean;
  /** for "trade-response": which offer, and our answer */
  tradeId?: string;
  accept?: boolean;
  describe: string;
}

/** The builds we're saving for, in order, as costs — the plan a trade must serve. */
export function planCosts(fit: LiveStrategyFit | null, vp: number, target = 10): Array<Partial<Record<Resource, number>>> {
  const order: Array<keyof typeof BUILD_COSTS> =
    vp < target - 2 ? ["settlement", "city"] : fit ? fit.strategy.buildOrder.filter((i) => i !== "road") : ["city", "settlement"];
  return order.map((i) => BUILD_COSTS[i]);
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
    const ratio = ratios[g] ?? 4; // ground-truth port ratio (2/3) or 4:1 bank
    const surplus = hand[g] - (cost[g] ?? 0);
    if (surplus < ratio) continue; // can't trade this away without hurting the build
    // Port-aware: a lower ratio (a 2:1/3:1 port) dominates, so we never burn 4
    // cards when a port would cost 2. Then prefer the least-valued resource and,
    // last, the most spare.
    const score = -ratio * 100 - weights[g] * 5 + surplus;
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
 * Best edge for a FREE road (Road Building): an untaken edge extending the
 * player's network, preferring one whose far end is a legal settlement corner
 * (that's the expansion we played the card for), then by that corner's pips.
 */
export function bestFreeRoadEdge(state: GameState, player: PlayerId): number | null {
  const network = new Set<number>();
  for (const b of state.buildings) if (b.player === player) network.add(b.vertexId);
  for (const r of state.roads) {
    if (r.player === player) {
      const e = state.board.edges[r.edgeId];
      network.add(e.a);
      network.add(e.b);
    }
  }
  const taken = new Set(state.roads.map((r) => r.edgeId));
  const oppBuildings = new Set(
    state.buildings.filter((b) => b.player !== player).map((b) => b.vertexId),
  );
  let best: number | null = null;
  let bestScore = -1;
  for (const e of state.board.edges) {
    if (taken.has(e.id)) continue;
    const aIn = network.has(e.a);
    const bIn = network.has(e.b);
    if (!aIn && !bIn) continue;
    const from = aIn ? e.a : e.b;
    if (oppBuildings.has(from)) continue; // roads can't pass an opponent's building
    const far = aIn ? e.b : e.a;
    const score = vertexPips(state.board, far) + (isVertexBuildable(state, far) ? 6 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = e.id;
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
  /** we hold a playable road building card this turn */
  hasRoadBuilding?: boolean;
  /** we hold a playable year of plenty card this turn */
  hasYearOfPlenty?: boolean;
  /** free roads still owed from a played Road Building (game is blocked on them) */
  freeRoadsPending?: number;
  /** friendly robber: whether a given player may be robbed (>= 3 VP) */
  canRob?: (player: PlayerId) => boolean;
  /** victory points to win (colonist: 10; casual 1v1: 15). Default 10. */
  winTarget?: number;
  /** our cheapest next VP step from the path-to-victory analysis (endgame steering) */
  endgameStep?: "city" | "settlement" | "dev" | "road";
  /**
   * Restrict the kinds of action this decision may return (e.g. Rush mode:
   * placements + robber only). Omitted = everything, the normal turn game.
   */
  allow?: ReadonlySet<ActionKind>;
}): AutopilotDecision | null {
  const { tracker, youName, fit, gs, advice, rolledThisTurn, robberPending, robberHex, discardPending } =
    opts;
  const you = tracker.players.get(youName);
  if (!you) return null;
  const allowed = (kind: ActionKind): boolean => !opts.allow || opts.allow.has(kind);
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

  // Road Building placement: a played card owes the game free roads — it
  // blocks everything else until they're placed. Follow the advised expansion
  // path first; otherwise extend toward the best reachable corner.
  if ((opts.freeRoadsPending ?? 0) > 0 && board && gs && gs.youPlayer !== null) {
    const advised = (advice?.roadEdges ?? []).find(
      (id) => !gs.state.roads.some((r) => r.edgeId === id),
    );
    const edgeId = advised ?? bestFreeRoadEdge(gs.state, gs.youPlayer);
    if (edgeId !== null && edgeId !== undefined) {
      const e = board.edges[edgeId];
      const coord = pixelsToColonistEdge(board.vertices[e.a], board.vertices[e.b]);
      if (coord) {
        return { kind: "build-road", coord, free: true, describe: "place a free road (Road Building)" };
      }
    }
    return null; // no sensible edge — let the human place it
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

  // Knight discipline (from game-log analysis: 13 knights played was wasteful).
  // Play a knight ONLY to un-block your own tile, or to take/hold Largest Army
  // (>= 3 knights AND more than any opponent). Once you hold it, HOLD the rest —
  // extra knights add zero VP.
  const knightReason = ((): string | null => {
    if (!opts.knightAvailable || !allowed("play-knight")) return null;
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
    const myKnights = you.knightsPlayed;
    const oppMaxKnights = Math.max(
      0,
      ...[...tracker.players.values()].filter((p) => p.name !== youName).map((p) => p.knightsPlayed),
    );
    // chase to 3 (Largest Army minimum) or 1 past a leading opponent; then stop.
    const targetKnights = Math.max(3, oppMaxKnights + 1);
    if (myKnights < targetKnights) return "to take/hold Largest Army";
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
  const devAvailable = opts.bankDevCards !== 0 && allowed("buy-dev");
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
  if (opts.hasMonopoly && allowed("play-monopoly")) {
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
  // that just telegraphs a spot the opponent then takes. Roads are only built
  // (or funded) as part of a CLAIM: the advised road path (1–2 edges) ends at
  // a legal settlement corner, and roads + settlement are paid for together so
  // the spot is taken the SAME turn it's opened, before the opponent moves.
  const rawSpot =
    gs && gs.youPlayer !== null ? bestPlaceableNow(gs.state, gs.youPlayer) : null;
  // Weak-spot guard (batch 3: a 2-pip settlement was built for a 3:1 port —
  // 4 cards + roads for almost no production). Below 4 pips a corner is only
  // worth settling for a 2:1 port, or in the endgame where any VP counts.
  const spotOnNetwork = ((): number | null => {
    if (rawSpot === null || !board) return rawSpot;
    const v = board.vertices[rawSpot];
    const pipsHere = vertexPips(board, rawSpot);
    const endgame = visibleVp(you) >= (opts.winTarget ?? 10) - 2;
    if (pipsHere >= 3 || endgame || (v.port && v.port.ratio === 2)) return rawSpot;
    return null;
  })();
  const ownSettlements =
    gs && gs.youPlayer !== null
      ? gs.state.buildings.filter((b) => b.player === gs.youPlayer && b.kind === "settlement").length
      : 0;
  const claim = ((): { roads: number; cost: Partial<Record<Resource, number>> } | null => {
    if (spotOnNetwork !== null) return null; // can settle without roads
    if (!advice || advice.roadEdges.length === 0 || !board || !gs || gs.youPlayer === null) return null;
    if (!hasPiece("settlement")) return null;
    const roads = advice.roadEdges.length; // the advised path is pre-trimmed to <= 2 edges
    const last = board.edges[advice.roadEdges[roads - 1]];
    // the path must actually reach a buildable corner within those edges
    if (!isVertexBuildable(gs.state, last.a) && !isVertexBuildable(gs.state, last.b)) return null;
    return { roads, cost: { wood: 1 + roads, brick: 1 + roads, sheep: 1, wheat: 1 } };
  })();
  const canClaimNow =
    !!claim && RESOURCES.every((r) => you.hand[r] >= (claim.cost[r] ?? 0));

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
      if (!advice || advice.roadEdges.length === 0) return null;
      const e = board.edges[advice.roadEdges[0]];
      if (gs.state.roads.some((r) => r.edgeId === e.id)) return null; // stale advice
      const coord = pixelsToColonistEdge(board.vertices[e.a], board.vertices[e.b]);
      if (!coord) return null;
      // 1. A fully-funded claim: roads + settlement land this turn.
      if (claim && canClaimNow) {
        return {
          kind: "build-road",
          coord,
          describe: `road toward spot ① (${claim.roads} road${claim.roads > 1 ? "s" : ""}, settling it this turn)`,
        };
      }
      // 2. A development road. Game-log fix: a whole game with 0 roads built
      //    while wood+brick were discarded to 7s three times — spot ① was
      //    more than two roads away, so a same-turn claim was never possible
      //    and expansion simply froze. When the spot can't be claimed this
      //    turn anyway there is nothing to telegraph: extend toward it while
      //    keeping a road's worth for the claim, or whenever a 7 would
      //    otherwise take the cards.
      const nearLimit = handSize >= limit - 2;
      // keep a road's worth AND the settlement's own wood/brick (batch-1: four
      // roads in a row by minute 2.6 with no settlement until 4.6)
      const surplus = you.hand.wood >= 3 && you.hand.brick >= 3;
      const len = advice.roadPathLength ?? advice.roadEdges.length;
      // Road bloat guard (ranked 1v1 loss: 10 roads for 3 settlements): once we
      // have laid well more roads than buildings, stop speculative extension
      // unless a 7 is about to take the cards anyway.
      const myRoads = gs.state.roads.filter((r) => r.player === gs.youPlayer).length;
      const myBuildings = gs.state.buildings.filter((b) => b.player === gs.youPlayer).length;
      const bloated = myRoads >= myBuildings + 3;
      // absolute: the near-limit exception let a 2:1-ore-port hand lay 13 roads
      // for 3 buildings (batch 2) — surplus goes to trades/devs instead.
      // Exception: the win model says Longest Road is our cheapest +2.
      if (bloated && opts.endgameStep !== "road") return null;
      if (opts.endgameStep === "road" && afford("road")) {
        return { kind: "build-road", coord, describe: "road toward Longest Road (cheapest +2)" };
      }
      // with a claim in reach, prefer funding it (trade loop) over a lone road
      const claimStuck = !!claim && !affordableWithTrades(you.hand, you.bankRatio, claim.cost);
      const worthExtending = claim ? nearLimit && claimStuck : surplus || nearLimit;
      if (hasPiece("settlement") && worthExtending) {
        return {
          kind: "build-road",
          coord,
          describe: `development road toward spot ① (${len} road${len > 1 ? "s" : ""} away)`,
        };
      }
    }
    return null;
  };

  // Growth phasing (from game-log analysis: a dev-card-first plan built 0 new
  // settlements and lost 35 pips to 63). EXPAND EARLY — settlements and cities
  // are the investment that pays off later — and only shift to a dev-card focus
  // once the economy is built (or expansion is exhausted). While growing, dev
  // cards are dropped from the plan so resources bank toward real production.
  const canExpandMore = (pieces?.settlements ?? 1) !== 0 || (pieces?.cities ?? 1) !== 0;
  // grow the board until we're within a couple points of winning, then let the
  // strategy (dev cards / army) close it out.
  // Grow until within 2 points of the TARGET (10-point game: 8; 15-point 1v1:
  // 13) — the old hard-coded 8 stopped expanding with 7 points still to go.
  const winTarget = opts.winTarget ?? 10;
  const growthPhase = canExpandMore && visibleVp(you) < winTarget - 2;
  // Post-growth (>= target-2, i.e. endgame): a settlement is a GUARANTEED point
  // for 4 cards while a dev card averages well under half a point (log game:
  // at 8 VP the bot sat on 11 cards buying dev cards and lost by one build).
  // Keep the strategy's order but never let "dev" outrank a settlement.
  const lateOrder = (bo: ReadonlyArray<keyof typeof COSTS>): ReadonlyArray<keyof typeof COSTS> => {
    const devAt = bo.indexOf("dev");
    if (devAt === -1 || bo.indexOf("settlement") < devAt) return bo;
    const rest: Array<keyof typeof COSTS> = bo.filter((x) => x !== "settlement");
    rest.splice(rest.indexOf("dev"), 0, "settlement");
    return rest;
  };
  const lateWithRoads = (bo: ReadonlyArray<keyof typeof COSTS>): ReadonlyArray<keyof typeof COSTS> => {
    let out: Array<keyof typeof COSTS> = bo.includes("road") ? [...bo] : [...bo, "road"]; // claim roads stay buildable late
    // and a dev card as the last resort: VP cards and knights (Largest Army)
    // close games — road-expand had no "dev" and held cards while behind
    if (!out.includes("dev")) out = [...out, "dev"];
    return out;
  };
  // City-vs-settlement (game-log fix: two losses sprawled to 3-5 settlements
  // with 0-1 cities while the winners made 3 cities). A city is the same +1 VP
  // as a settlement but DOUBLES an existing producer with no new road, spot,
  // or robber exposure — so upgrade before sprawling UNLESS a new settlement
  // spot clearly out-produces our best upgrade target (grab the great spot).
  const bestUpgradePips =
    gs && gs.youPlayer !== null && board
      ? gs.state.buildings
          .filter((b) => b.player === gs.youPlayer && b.kind === "settlement")
          .reduce((mx, b) => Math.max(mx, vertexPips(board, b.vertexId)), -1)
      : -1;
  const bestSpotPips = spotOnNetwork !== null && board ? vertexPips(board, spotOnNetwork) : -1;
  // upgrade first when we hold a settlement to convert and no clearly better
  // (2+ pips) new spot is sitting on our network
  const cityFirst = bestUpgradePips >= 0 && bestSpotPips < bestUpgradePips + 2;
  const growthOrder: ReadonlyArray<keyof typeof COSTS> = cityFirst
    ? ["city", "settlement", "road"]
    : ["settlement", "city", "road"];
  // Endgame steering: the win-chance model already knows our cheapest next VP
  // (city vs settlement vs dev/army vs longest road) — put it first so builds
  // AND trades pull toward it instead of the strategy's generic order.
  const steer = (bo: ReadonlyArray<keyof typeof COSTS>): ReadonlyArray<keyof typeof COSTS> =>
    opts.endgameStep ? [opts.endgameStep, ...bo.filter((x) => x !== opts.endgameStep)] : bo;
  const order: ReadonlyArray<keyof typeof COSTS> = growthPhase
    ? growthOrder // grow the board first; no dev-card buys
    : steer(lateWithRoads(lateOrder(fit.strategy.buildOrder)));

  // What would funding this build actually buy us? null = don't spend on it:
  // supply/bank exhausted, a settlement with no reachable spot, or a city
  // with nothing to upgrade. A settlement that needs the advised road(s)
  // first is funded at the full claim cost (roads + settlement together).
  const fundingTarget = (item: keyof typeof COSTS): Partial<Record<Resource, number>> | null => {
    if (!canBuild(item)) return null;
    if (item === "settlement" && gs && gs.youPlayer !== null && spotOnNetwork === null) {
      return claim ? claim.cost : null;
    }
    if (item === "city" && gs && gs.youPlayer !== null && ownSettlements === 0) return null;
    return BUILD_COSTS[item];
  };

  // Road Building: two free roads. Play it whenever we have a road target at
  // all — a same-turn claim (best), or the advised development path toward
  // spot ① (the roads we'd otherwise pay 2 wood + 2 brick for). Player
  // feedback: holding it for a perfect claim meant it was never played; two
  // free roads toward the next spot are worth more early than late, and the
  // free-road placer already follows the path (or extends to the best corner).
  if (
    opts.hasRoadBuilding &&
    allowed("play-road-building") &&
    hasPiece("road") &&
    advice &&
    advice.roadEdges.length > 0
  ) {
    const why = claim
      ? `free road${claim.roads > 1 ? "s" : ""} to claim spot ①`
      : `free roads toward spot ① (${advice.roadPathLength ?? advice.roadEdges.length} away)`;
    return { kind: "play-road-building", describe: `play road building — ${why}` };
  }

  // Year of Plenty: take exactly the 1–2 cards that COMPLETE the first build
  // in the plan we can't yet afford. Never played into a build that can't be
  // placed, and held when nothing is within 2 cards of completion.
  if (opts.hasYearOfPlenty && allowed("play-year-of-plenty")) {
    for (const item of order) {
      if (item === "road") continue;
      const cost = fundingTarget(item);
      if (!cost) continue;
      const missing: Resource[] = [];
      for (const r of RESOURCES) {
        for (let i = you.hand[r]; i < (cost[r] ?? 0); i++) missing.push(r);
      }
      if (missing.length === 0) continue;
      // Endgame (within 3 of the target): never hold YoP — take the two cards
      // the build is most short of even if it won't complete this turn (batch
      // 2: lost 13-11 with three dev cards unplayed). Otherwise only to finish.
      const endgame = visibleVp(you) >= winTarget - 3;
      if (missing.length > 2 && !endgame) continue;
      if (missing.length > 2) missing.length = 2;
      while (missing.length < 2) {
        // second pick is a bonus: the strategy's most-valued resource
        missing.push([...RESOURCES].sort((a, b) => fit.strategy.weights[b] - fit.strategy.weights[a])[0]);
      }
      return {
        kind: "play-year-of-plenty",
        resources: [missing[0], missing[1]],
        describe: `play year of plenty — take ${missing.join(" + ")} to complete a ${item}`,
      };
    }
  }

  for (const item of order) {
    if (!afford(item)) continue;
    const d = buildDecision(item);
    if (d) return d;
  }

  // Growth-phase dev card. Growth excludes dev buys so resources bank toward
  // production, with three exceptions (batch-1 ranked analysis):
  //  (a) the robber is camping our tile and we hold no knight — a dev card is
  //      a 56% knight and the only way to move it (7-8 robs/game in losses);
  //  (b) NO settlement/city is reachable even with trades, so ore+sheep+wheat
  //      would just sit until a 7 halves it;
  //  (c) the hand is about to hit the limit and no trade toward a build exists.
  // Never while 2+ dev cards sit unplayed (15-dev-card spam in one loss), and
  // (c) runs AFTER the near-limit trades below so a reachable city wins.
  const robberOnMine =
    !!robberHex && !!gs && gs.youPlayer !== null && !!board &&
    gs.state.buildings.some(
      (b) => b.player === gs.youPlayer &&
        board.vertices[b.vertexId].hexIds.some((h) => board.hexes[h].q === robberHex.x && board.hexes[h].r === robberHex.y),
    );
  const devBuyOk = growthPhase && allowed("buy-dev") && devAvailable && afford("dev") && !!gs && gs.youPlayer !== null && you.devCards < 2;
  if (devBuyOk) {
    const targets = (["settlement", "city"] as const).map(fundingTarget).filter((c): c is NonNullable<typeof c> => !!c);
    const reachable = targets.some((c) => affordableWithTrades(you.hand, you.bankRatio, c));
    if (robberOnMine && !opts.knightAvailable) {
      return { kind: "buy-dev", describe: "buy a development card (robber on our tile, no knight in hand)" };
    }
    if (!reachable) {
      return { kind: "buy-dev", describe: "buy a development card (nothing else reachable)" };
    }
  }

  // Hand-size pressure: at or over the discard limit, shed cards into any
  // affordable build rather than risk a 7 halving the hand. (>= so it acts
  // AT the limit, not only strictly over it.)
  if (handSize >= limit) {
    // a dev card is the LAST resort here: if a city/settlement is reachable
    // with trades, the trade loop below converts the surplus toward it instead
    const buildReachable =
      !!gs && gs.youPlayer !== null && // without the board, placeability is unknown — dump into a dev
      (["settlement", "city"] as const)
        .map(fundingTarget)
        .some((c) => !!c && affordableWithTrades(you.hand, you.bankRatio, c));
    for (const item of ["city", "settlement", "dev", "road"] as const) {
      if (item === "dev" && buildReachable) continue;
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
  // Placement-gated (game-log fix: a whole city's worth of wheat/ore was
  // 4:1-traded toward settlements with no legal spot): a settlement with no
  // network spot is funded at the CLAIM cost (roads + settlement together) or
  // not at all, and a city needs a settlement to upgrade.
  for (const item of allowed("bank-trade") ? order : []) {
    if (item === "road") continue; // roads are only funded via a claim (above)
    const cost = fundingTarget(item);
    if (!cost) continue;
    const short = RESOURCES.some((r) => (cost[r] ?? 0) > you.hand[r]);
    if (!short) continue; // affordable as-is — the build loop handles it
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

  // Near/over the limit with no build completable THIS turn: still convert
  // surplus toward the next placeable build. Game-log fix (real 1v1 loss): a
  // 12-card wood/sheep pile with a city 4 cards away sat untouched — the loop
  // above only trades when it can finish the build — and was halved by 7s
  // three times. One 4:1 a turn toward the city beats losing 6 cards.
  // (needs the board: without it placeability is unknown, so no speculative trades)
  // In the endgame (within 2 of the target) holding cards has no future value:
  // trade toward the next VP step at ANY hand size (batch 4: lost at 13/15 with
  // 11 cards in hand).
  const endgameNow = visibleVp(you) >= winTarget - 2;
  if ((endgameNow || handSize >= limit - 1) && allowed("bank-trade") && gs && gs.youPlayer !== null) {
    for (const item of order) {
      if (item === "road") continue;
      const cost = fundingTarget(item);
      if (!cost) continue;
      const trade = tradeTowardCost(you.hand, you.bankRatio, cost, fit.strategy.weights);
      // (batch 4: restricting 4:1s here cost tempo — 1-9 — so any trade that
      // moves the next build along is taken; the cards were buying speed)
      if (trade) {
        return {
          kind: "bank-trade",
          trade,
          describe: `bank-trade ${trade.giveCount} ${trade.give} for ${trade.get} toward a ${item} (near the ${limit}-card limit)`,
        };
      }
    }
  }
  // (c) near the limit, nothing tradeable toward a build: a dev card beats a discard
  if (devBuyOk && handSize >= limit - 2) {
    return { kind: "buy-dev", describe: "buy a development card (hand near the limit, no trade toward a build)" };
  }

  // At/over the limit with no placeable target at all: dump the most
  // expendable surplus so a 7 doesn't take half of it.
  if (handSize >= limit && allowed("bank-trade")) {
    const trade = planBankTrade(you.hand, you.bankRatio, fit, canBuild);
    if (trade) {
      return {
        kind: "bank-trade",
        trade,
        describe: `bank-trade ${trade.giveCount} ${trade.give} for ${trade.get} (at the ${limit}-card limit)`,
      };
    }
  }

  return allowed("end-turn") ? { kind: "end-turn", describe: "end the turn" } : null;
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
  /** free roads still owed after playing Road Building */
  private freeRoads = 0;
  /** trade offer ids we've already answered this game */
  private answeredOffers = new Set<string>();
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
      this.freeRoads = 0;
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
    if (
      kind === "play-knight" ||
      kind === "play-monopoly" ||
      kind === "play-road-building" ||
      kind === "play-year-of-plenty"
    ) {
      this.devPlayedThisTurn = true;
    }
    if (kind === "play-road-building") this.freeRoads = 2; // the game now owes us two roads
    if (kind === "build-road" && this.freeRoads > 0) this.freeRoads--;
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
    /** other players' trade offers awaiting our answer (any turn) */
    tradeOffers?: TradeOffer[];
    /** victory points to win for this game */
    winTarget?: number;
    /** our cheapest next VP step (from the win-chance model) */
    endgameStep?: "city" | "settlement" | "dev" | "road";
    now?: number;
  }): void {
    if (!this.enabled) return;
    const now = ctx.now ?? Date.now();

    // Player-trade offers are answered on ANY turn, ahead of everything else:
    // an unanswered offer holds the table on our timer. Each offer is answered
    // once (colonist closes it or records our response).
    const you0 = ctx.tracker?.youName ? ctx.tracker.players.get(ctx.tracker.youName) : undefined;
    for (const offer of ctx.tradeOffers ?? []) {
      if (this.answeredOffers.has(offer.id) || !you0) continue;
      const plan = planCosts(ctx.fit, visibleVp(you0), ctx.winTarget ?? 10);
      const verdict = decideTradeResponse(you0.hand, offer, plan);
      const decision: AutopilotDecision = {
        kind: "trade-response",
        tradeId: offer.id,
        accept: verdict.accept,
        describe: `${verdict.accept ? "accept" : "decline"} trade — ${verdict.reason}`,
      };
      this.answeredOffers.add(offer.id);
      if (this.answeredOffers.size > 200) this.answeredOffers.clear();
      if (this.dispatch(decision)) {
        this.note = `acting: ${decision.describe}`;
        return;
      }
      this.note = `▶ ${decision.describe} (answer it manually — response frame not learned yet)`;
    }

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
      // Playable only if we hold the card, haven't played a dev this turn, and
      // hold more than we bought this turn (a fresh buy can't be played).
      // 13 = monopoly, 14 = road building, 15 = year of plenty.
      hasMonopoly:
        !this.devPlayedThisTurn &&
        (ctx.myDevCardIds ?? []).filter((id) => id === 13).length > this.devsBoughtThisTurn,
      hasRoadBuilding:
        !this.devPlayedThisTurn &&
        (ctx.myDevCardIds ?? []).filter((id) => id === 14).length > this.devsBoughtThisTurn,
      hasYearOfPlenty:
        !this.devPlayedThisTurn &&
        (ctx.myDevCardIds ?? []).filter((id) => id === 15).length > this.devsBoughtThisTurn,
      freeRoadsPending: this.freeRoads,
      canRob: ctx.canRob,
      winTarget: ctx.winTarget,
      endgameStep: ctx.endgameStep,
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
          : decision.kind === "play-road-building" || decision.kind === "play-year-of-plenty"
            ? `on — ${decision.describe} (couldn't send it — play the card manually)`
            : `on — "${decision.kind}" not learned yet, do it manually once`;
  }
}
