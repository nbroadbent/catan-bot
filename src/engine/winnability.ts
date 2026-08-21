import { RESOURCES, Resource } from "./types";

/**
 * Win-probability & path-to-victory model.
 *
 * For each player we work out the CHEAPEST plan that still reaches the VP
 * target, honouring the hard constraints of a real game:
 *   - pieces left in supply (0 cities → can't upgrade; 0 settlements → can't
 *     expand; 0 roads → can't chase Longest Road),
 *   - Largest Army / Longest Road are only VP sources you can still take from
 *     whoever holds them (and only if the dev deck / your roads can supply it),
 *   - Victory-Point dev cards as a slow fallback while the deck has cards.
 *
 * From that plan we estimate turns-to-win (cards still needed ÷ production,
 * penalising resources you don't produce) and turn the field of turn-counts
 * into probabilities with a softmax. Everything here is a documented heuristic
 * — it is an ESTIMATE, not a solver — but it respects what is actually
 * possible, so "eliminated" and "needs a road + settlement" are real.
 */

export type Hand = Record<Resource, number>;
export type Cost = Partial<Record<Resource, number>>;

export const BUILD: Record<"city" | "settlement" | "road" | "dev", Cost> = {
  city: { ore: 3, wheat: 2 },
  settlement: { wood: 1, brick: 1, sheep: 1, wheat: 1 },
  road: { wood: 1, brick: 1 },
  dev: { ore: 1, sheep: 1, wheat: 1 },
};

/** Base-game odds a bought dev card is a Victory Point card (5 of 25). */
const VP_CARD_RATE = 5 / 25;
/** Longest Road / Largest Army each award this many points. */
const BONUS_VP = 2;
/** softmax spread (turns) — larger = flatter probabilities. */
const TAU = 2.0;

export interface PlayerVictoryInput {
  name: string;
  isYou: boolean;
  /** public victory points (buildings + any bonus they already hold) */
  publicVp: number;
  settlementsLeft: number | null;
  citiesLeft: number | null;
  roadsLeft: number | null;
  /** their settlements on the board (upgrade targets for cities) */
  settlementsOnBoard: number;
  /** a legal settlement spot reachable now (else the next one needs a road) */
  settlementSpotOpen: boolean;
  knightsPlayed: number;
  /** their current longest continuous road (segments) */
  longestRoadLen: number;
  hand: Hand;
  /** expected cards per roll, per resource */
  production: Hand;
}

export interface WinContext {
  /** victory points needed to win (colonist: 10, some modes 15) */
  target: number;
  /** dev cards left in the bank (null = unknown → treat as plentiful) */
  devDeckLeft: number | null;
}

export type VictoryStepKind = "city" | "settlement" | "largest-army" | "longest-road" | "vp-dev";

export interface VictoryStep {
  kind: VictoryStepKind;
  vp: number;
  cost: Cost;
  note: string;
}

export interface VictoryPlan {
  name: string;
  isYou: boolean;
  publicVp: number;
  target: number;
  /** true = cannot reach the target with anything still available */
  eliminated: boolean;
  steps: VictoryStep[];
  planVp: number;
  /** resources still to acquire for the plan (plan cost minus hand) */
  need: Cost;
  turnsToWin: number;
  /** 0..1, normalised across the table */
  winProb: number;
  largestArmyReachable: boolean;
  longestRoadReachable: boolean;
  summary: string;
}

function costCards(c: Cost): number {
  return RESOURCES.reduce((s, r) => s + (c[r] ?? 0), 0);
}
function addCost(a: Cost, b: Cost): Cost {
  const out: Cost = { ...a };
  for (const r of RESOURCES) if (b[r]) out[r] = (out[r] ?? 0) + (b[r] ?? 0);
  return out;
}
function scaleCost(c: Cost, k: number): Cost {
  const out: Cost = {};
  for (const r of RESOURCES) if (c[r]) out[r] = (c[r] ?? 0) * k;
  return out;
}

/** A single VP "buy" available to a player. */
interface Buy {
  kind: VictoryStepKind;
  vp: number;
  cost: Cost;
  note: string;
}

/** Enumerate every VP source still open to a player, cheapest-first per unit. */
function buysFor(p: PlayerVictoryInput, ctx: WinContext, holdsLA: boolean, holdsLR: boolean, laReach: boolean, lrReach: boolean, knightsToLA: number, roadsToLR: number): Buy[] {
  const buys: Buy[] = [];

  // Cities: upgrade an existing settlement. Bounded by BOTH the pieces in
  // supply and the settlements actually on the board.
  const cityN = Math.min(p.citiesLeft ?? Infinity, p.settlementsOnBoard);
  for (let i = 0; i < cityN; i++) {
    buys.push({ kind: "city", vp: 1, cost: BUILD.city, note: "upgrade a settlement to a city" });
  }

  // Settlements: the first is free of roads if a spot is open now; each further
  // one assumes a road to open a new corner.
  const settN = p.settlementsLeft ?? 0;
  const freeSpots = p.settlementSpotOpen ? 1 : 0;
  for (let i = 0; i < settN; i++) {
    const needsRoad = i >= freeSpots;
    buys.push({
      kind: "settlement",
      vp: 1,
      cost: needsRoad ? addCost(BUILD.settlement, BUILD.road) : BUILD.settlement,
      note: needsRoad ? "road + settlement to a new spot" : "settlement on an open spot",
    });
  }

  // Largest Army (+2): only if we can still take it and the deck can supply it.
  if (!holdsLA && laReach) {
    buys.push({
      kind: "largest-army",
      vp: BONUS_VP,
      cost: scaleCost(BUILD.dev, knightsToLA),
      note: `${knightsToLA} more knight${knightsToLA > 1 ? "s" : ""} for Largest Army`,
    });
  }

  // Longest Road (+2): only if roads remain and we can beat the holder.
  if (!holdsLR && lrReach) {
    buys.push({
      kind: "longest-road",
      vp: BONUS_VP,
      cost: scaleCost(BUILD.road, roadsToLR),
      note: `${roadsToLR} more road${roadsToLR > 1 ? "s" : ""} for Longest Road`,
    });
  }

  // Victory-Point dev cards: slow filler while the deck has cards. Expected
  // dev cards per VP = 1 / rate; capped by what the deck can plausibly give.
  const perVp = Math.round(1 / VP_CARD_RATE);
  const vpDevCap = ctx.devDeckLeft === null ? 6 : Math.floor((ctx.devDeckLeft * VP_CARD_RATE) + 0.001);
  for (let i = 0; i < vpDevCap; i++) {
    buys.push({ kind: "vp-dev", vp: 1, cost: scaleCost(BUILD.dev, perVp), note: "victory-point dev card (expected)" });
  }

  return buys;
}

/**
 * Choose the subset of buys with the LOWEST TOTAL card cost that reaches `gap`
 * VP. A 0/1 knapsack (each city/settlement/bonus is one item) — greedy by
 * cost-per-VP would wrongly spend 9 cards on a +2 bonus to close a 1-VP gap a
 * 5-card city closes. gap ≤ target and the item pool is tiny, so this is cheap.
 */
function cheapestPlan(buys: Buy[], gap: number): Buy[] {
  if (gap <= 0) return [];
  const INF = Infinity;
  // dp[v] = cheapest way to have gained (capped) v VP
  const dp: Array<{ cost: number; items: Buy[] }> = Array.from({ length: gap + 1 }, (_, i) => ({
    cost: i === 0 ? 0 : INF,
    items: [],
  }));
  for (const b of buys) {
    const bc = costCards(b.cost);
    for (let v = gap; v >= 0; v--) {
      if (dp[v].cost === INF) continue;
      const nv = Math.min(gap, v + b.vp);
      if (dp[v].cost + bc < dp[nv].cost) {
        dp[nv] = { cost: dp[v].cost + bc, items: [...dp[v].items, b] };
      }
    }
  }
  return dp[gap].items;
}

function summarise(p: PlayerVictoryInput, plan: VictoryStep[], eliminated: boolean, laReach: boolean, lrReach: boolean): string {
  if (p.publicVp <= 0 && plan.length === 0 && eliminated) return "not in the game yet";
  if (eliminated) return "eliminated — nothing left to build to the target";
  if (plan.length === 0) return "already at the target";
  const counts = new Map<VictoryStepKind, number>();
  for (const s of plan) counts.set(s.kind, (counts.get(s.kind) ?? 0) + 1);
  const label: Record<VictoryStepKind, [string, string]> = {
    city: ["city", "cities"],
    settlement: ["settlement", "settlements"],
    "largest-army": ["Largest Army", "Largest Army"],
    "longest-road": ["Longest Road", "Longest Road"],
    "vp-dev": ["VP dev card", "VP dev cards"],
  };
  const parts: string[] = [];
  for (const [kind, n] of counts) parts.push(`${n} ${n > 1 ? label[kind][1] : label[kind][0]}`);
  let s = parts.join(" + ");
  // Call out a blocked natural path so the "why" is explicit.
  if ((p.citiesLeft ?? 1) === 0 && p.settlementsOnBoard > 0) s += " (no cities left)";
  if (!laReach && !lrReach && (p.roadsLeft ?? 1) === 0) s += "; roads spent";
  return s;
}

/**
 * Analyse the whole table at once (needed to know who holds Largest Army /
 * Longest Road) and return each player's plan with a normalised win chance.
 */
export function analyzeVictory(players: PlayerVictoryInput[], ctx: WinContext): VictoryPlan[] {
  const maxKnights = Math.max(0, ...players.map((p) => p.knightsPlayed));
  const knightLeaders = players.filter((p) => p.knightsPlayed === maxKnights && maxKnights >= 3);
  const maxRoad = Math.max(0, ...players.map((p) => p.longestRoadLen));
  const roadLeaders = players.filter((p) => p.longestRoadLen === maxRoad && maxRoad >= 5);

  const plans: VictoryPlan[] = players.map((p) => {
    const holdsLA = knightLeaders.length === 1 && knightLeaders[0].name === p.name;
    const holdsLR = roadLeaders.length === 1 && roadLeaders[0].name === p.name;

    // knights needed to seize Largest Army: beat the leader, or reach the
    // minimum of 3 if nobody holds it yet.
    const knightsToLA = holdsLA ? 0 : Math.max(3, maxKnights + 1) - p.knightsPlayed;
    const laReach =
      !holdsLA && knightsToLA >= 1 && (ctx.devDeckLeft === null || ctx.devDeckLeft >= knightsToLA);
    const roadsToLR = holdsLR ? 0 : Math.max(5, maxRoad + 1) - p.longestRoadLen;
    const lrReach = !holdsLR && roadsToLR >= 1 && (p.roadsLeft ?? 0) >= roadsToLR;

    const gap = ctx.target - p.publicVp;
    const buys = buysFor(p, ctx, holdsLA, holdsLR, laReach, lrReach, knightsToLA, roadsToLR);
    const maxAttainable = buys.reduce((s, b) => s + b.vp, 0);
    const eliminated = gap > 0 && maxAttainable < gap;
    const won = gap <= 0;

    const chosen = won ? [] : cheapestPlan(buys, gap);
    const steps: VictoryStep[] = chosen.map((b) => ({ kind: b.kind, vp: b.vp, cost: b.cost, note: b.note }));
    const planVp = steps.reduce((s, b) => s + b.vp, 0);

    const totalCost = steps.reduce<Cost>((acc, s) => addCost(acc, s.cost), {});
    const need: Cost = {};
    for (const r of RESOURCES) {
      const n = (totalCost[r] ?? 0) - p.hand[r];
      if (n > 0) need[r] = n;
    }

    // turns: cards still needed, weighting resources we DON'T produce (must be
    // traded for ~3:1) more heavily, divided by production per roll. Also bound
    // below by the number of build actions (roughly one major build per turn).
    const prodTotal = RESOURCES.reduce((s, r) => s + p.production[r], 0);
    const weightedNeed = RESOURCES.reduce(
      (s, r) => s + (need[r] ?? 0) * (p.production[r] > 0.05 ? 1 : 3),
      0,
    );
    const resourceTurns = weightedNeed / Math.max(prodTotal, 0.25);
    const buildTurns = steps.length * 0.8;
    const turnsToWin = won ? 0 : eliminated ? Infinity : Math.max(resourceTurns, buildTurns);

    return {
      name: p.name,
      isYou: p.isYou,
      publicVp: p.publicVp,
      target: ctx.target,
      eliminated,
      steps,
      planVp,
      need,
      turnsToWin,
      winProb: 0,
      largestArmyReachable: laReach,
      longestRoadReachable: lrReach,
      summary: summarise(p, steps, eliminated, laReach, lrReach),
    };
  });

  // Normalise turns → probabilities via softmax over -turns. A player already
  // at the target dominates; eliminated players get zero.
  const live = plans.filter((p) => !p.eliminated && Number.isFinite(p.turnsToWin));
  const tmin = Math.min(...live.map((p) => p.turnsToWin), Infinity);
  let wsum = 0;
  const weights = plans.map((p) => {
    if (p.eliminated || !Number.isFinite(p.turnsToWin)) return 0;
    const w = Math.exp(-(p.turnsToWin - tmin) / TAU);
    wsum += w;
    return w;
  });
  plans.forEach((p, i) => {
    p.winProb = wsum > 0 ? weights[i] / wsum : 0;
  });
  return plans.sort((a, b) => b.winProb - a.winProb);
}
