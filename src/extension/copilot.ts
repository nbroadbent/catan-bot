import { STRATEGIES } from "../engine/strategy";
import { BalancedDice } from "../engine/simulate";
import { mulberry32 } from "../engine/board";
import { RESOURCES, Resource, Strategy, pips } from "../engine/types";
import { PlayerState, TrackerState, handTotal, visibleVp } from "./tracker";

// ---------------------------------------------------------------- dice deck

export interface DeckStatus {
  /** cards left in the assumed deck for each total 2..12 */
  remaining: Map<number, number>;
  totalRemaining: number;
  /** probability the next roll is each total */
  prob: Map<number, number>;
  /** totals that are over-due vs. their base rate */
  due: number[];
  /** totals that are exhausted (or nearly) in this deck */
  cold: number[];
  rollsIntoDeck: number;
}

export function deckStatus(state: TrackerState): DeckStatus {
  const remaining = new Map<number, number>();
  for (let n = 2; n <= 12; n++) remaining.set(n, n === 7 ? 6 : pips(n));
  for (const roll of state.rollsThisDeck) {
    remaining.set(roll, Math.max(0, (remaining.get(roll) ?? 0) - 1));
  }
  const totalRemaining = [...remaining.values()].reduce((a, b) => a + b, 0);
  const prob = new Map<number, number>();
  const due: number[] = [];
  const cold: number[] = [];
  for (let n = 2; n <= 12; n++) {
    const base = (n === 7 ? 6 : pips(n)) / 36;
    const p = totalRemaining > 0 ? (remaining.get(n) ?? 0) / totalRemaining : base;
    prob.set(n, p);
    if (p >= base * 1.35 && (remaining.get(n) ?? 0) > 0) due.push(n);
    if ((remaining.get(n) ?? 0) === 0) cold.push(n);
  }
  return { remaining, totalRemaining, prob, due, cold, rollsIntoDeck: state.rollsThisDeck.length };
}

// ------------------------------------------------------------- production

/** Expected cards per (non-7) roll, from the learned income table. */
export function expectedProduction(
  p: PlayerState,
  probOf?: (n: number) => number,
): Record<Resource, number> {
  const out = Object.fromEntries(RESOURCES.map((r) => [r, 0])) as Record<Resource, number>;
  for (const [n, delta] of p.incomeByNumber) {
    const prob = probOf ? probOf(n) : pips(n) / 36;
    for (const [res, count] of Object.entries(delta)) {
      out[res as Resource] += prob * (count ?? 0);
    }
  }
  return out;
}

export function productionTotal(prod: Record<Resource, number>): number {
  return RESOURCES.reduce((s, r) => s + prod[r], 0);
}

// ---------------------------------------------------------------- strategy

export interface LiveStrategyFit {
  strategy: Strategy;
  score: number;
  simVp: number;
  rationale: string[];
}

const BUILD_COSTS: Record<"road" | "settlement" | "city" | "dev", Partial<Record<Resource, number>>> = {
  road: { wood: 1, brick: 1 },
  settlement: { wood: 1, brick: 1, sheep: 1, wheat: 1 },
  city: { ore: 3, wheat: 2 },
  dev: { ore: 1, sheep: 1, wheat: 1 },
};

/**
 * Board-free forward sim: sample balanced-dice rolls, pay costs greedily along
 * the strategy's build order, trade at the player's learned bank ratios.
 * New buildings add income at the player's average income-per-building rate.
 */
function simulateLive(
  p: PlayerState,
  strategy: Strategy,
  seed: number,
  rounds = 25,
  trials = 30,
): number {
  const buildingCount = Math.max(1, p.settlements + p.cities);
  const baseProd = expectedProduction(p);
  const perBuilding = productionTotal(baseProd) / buildingCount;
  // distribute a new building's income in the same mix as current production
  const mixTotal = productionTotal(baseProd) || 1;

  let vpSum = 0;
  for (let t = 0; t < trials; t++) {
    const rand = mulberry32(seed + t * 104729);
    const dice = new BalancedDice(rand, 4);
    const hand: Record<Resource, number> = { ...p.hand };
    let extraBuildings = 0;
    let orderIdx = 0;
    const built = { settlements: 0, cities: 0, devs: 0, roads: 0 };

    const ratioFor = (res: Resource) => p.bankRatio[res] ?? 4;

    const tryBuy = (item: keyof typeof BUILD_COSTS): boolean => {
      const cost = BUILD_COSTS[item];
      let missing = 0;
      const need: Partial<Record<Resource, number>> = {};
      for (const r of RESOURCES) {
        const gap = (cost[r] ?? 0) - hand[r];
        if (gap > 0) {
          need[r] = gap;
          missing += gap;
        }
      }
      if (missing > 0) {
        for (const give of RESOURCES) {
          if (missing === 0) break;
          const ratio = ratioFor(give);
          let spare = Math.floor(Math.max(0, hand[give] - (cost[give] ?? 0)) / ratio);
          while (spare > 0 && missing > 0) {
            const wanted = RESOURCES.find((r) => (need[r] ?? 0) > 0)!;
            hand[give] -= ratio;
            hand[wanted] += 1;
            need[wanted]! -= 1;
            missing--;
            spare--;
          }
        }
        for (const r of RESOURCES) if ((cost[r] ?? 0) > hand[r]) return false;
      }
      for (const r of RESOURCES) hand[r] -= cost[r] ?? 0;
      if (item === "settlement") {
        built.settlements++;
        extraBuildings++;
      } else if (item === "city") {
        // upgrading needs a settlement to exist
        if (p.settlements + built.settlements === 0) return false;
        built.cities++;
        extraBuildings++;
      } else if (item === "dev") built.devs++;
      else built.roads++;
      return true;
    };

    for (let round = 0; round < rounds; round++) {
      const roll = dice.roll();
      if (roll !== 7) {
        const income = p.incomeByNumber.get(roll);
        if (income) {
          for (const [res, count] of Object.entries(income)) {
            hand[res as Resource] += count ?? 0;
          }
        }
        // fractional income from sim-built buildings, in the current mix
        // (perBuilding is expected cards/roll for one building)
        if (extraBuildings > 0 && mixTotal > 0) {
          for (const r of RESOURCES) {
            hand[r] += (baseProd[r] / mixTotal) * perBuilding * extraBuildings;
          }
        }
      } else if (handTotal({ ...p, hand } as PlayerState) > 7) {
        for (const r of RESOURCES) hand[r] = Math.floor(hand[r] * 0.55);
      }

      const order = strategy.buildOrder;
      if (tryBuy(order[orderIdx % order.length])) orderIdx++;
      else {
        for (const alt of ["city", "settlement", "dev", "road"] as const) {
          if (alt !== order[orderIdx % order.length] && tryBuy(alt)) break;
        }
      }
    }
    vpSum += built.settlements + built.cities + built.devs * 0.3 + (built.devs >= 5 ? 2 : 0);
  }
  return vpSum / trials;
}

export function rankLiveStrategies(state: TrackerState, name: string): LiveStrategyFit[] {
  const p = state.players.get(name);
  if (!p) return [];
  const prod = expectedProduction(p);
  const total = productionTotal(prod);

  const fits = STRATEGIES.map((strategy, i) => {
    const rationale: string[] = [];
    let score = 0;
    for (const r of RESOURCES) score += prod[r] * strategy.weights[r] * 36;

    const keyRes = RESOURCES.filter((r) => strategy.weights[r] >= 1.4);
    if (keyRes.length > 0 && total > 0) {
      const keyShare = keyRes.reduce((s, r) => s + prod[r], 0) / total;
      if (keyShare >= 0.45) {
        rationale.push(`${Math.round(keyShare * 100)}% of your income is ${keyRes.join("+")}`);
      } else {
        rationale.push(`only ${Math.round(keyShare * 100)}% of your income is ${keyRes.join("/")}`);
      }
    }

    if (strategy.id === "port-trade") {
      const port = RESOURCES.find((r) => (p.bankRatio[r] ?? 4) === 2);
      if (port) {
        score += prod[port] * 36 * 1.5;
        rationale.push(`2:1 ${port} port confirmed from your bank trades`);
      } else {
        score *= 0.6;
        rationale.push("no 2:1 port observed yet");
      }
    }
    if (strategy.id === "city-dev" && p.knightsPlayed >= 2) {
      score += 3;
      rationale.push(`${p.knightsPlayed} knights played — Largest Army is in reach`);
    }
    if (strategy.id === "road-expand" && p.roads >= 6) {
      score += 3;
      rationale.push(`${p.roads} roads down — press for Longest Road`);
    }

    const simVp = simulateLive(p, strategy, 1000 + i * 31);
    return { strategy, score, simVp, rationale };
  });

  const maxScore = Math.max(...fits.map((f) => f.score), 1);
  const maxVp = Math.max(...fits.map((f) => f.simVp), 0.1);
  return fits.sort(
    (a, b) =>
      0.45 * (b.score / maxScore) + 0.55 * (b.simVp / maxVp) -
      (0.45 * (a.score / maxScore) + 0.55 * (a.simVp / maxVp)),
  );
}

// ---------------------------------------------------------------- robber

export interface RobberAdvice {
  target: string;
  reason: string;
}

/** The strategy weights that best match a player's current production. */
function bestFitWeights(p: PlayerState): Record<Resource, number> {
  const prod = expectedProduction(p);
  let best = STRATEGIES[0];
  let bestScore = -Infinity;
  for (const s of STRATEGIES) {
    const score = RESOURCES.reduce((sum, r) => sum + prod[r] * s.weights[r], 0);
    if (score > bestScore) {
      bestScore = score;
      best = s;
    }
  }
  return best.weights;
}

export function robberAdvice(state: TrackerState): RobberAdvice | null {
  const you = state.youName;
  const opponents = [...state.players.values()].filter((p) => p.name !== you);
  if (opponents.length === 0) return null;

  const scored = opponents
    .map((p) => {
      const prod = productionTotal(expectedProduction(p));
      return { p, threat: visibleVp(p) * 1.2 + prod * 36 * 0.6 + handTotal(p) * 0.15 };
    })
    .sort((a, b) => b.threat - a.threat);

  const { p } = scored[0];

  // Block the number that feeds what their game plan NEEDS, not just their
  // biggest raw earner: weight each number's payout by their best-fit
  // strategy's resource weights.
  const needs = bestFitWeights(p);
  const yourIncome = you ? state.players.get(you)?.incomeByNumber : undefined;
  let best: { n: number; value: number } | null = null;
  for (const [n, delta] of p.incomeByNumber) {
    let value = 0;
    for (const [res, count] of Object.entries(delta)) {
      value += (count ?? 0) * pips(n) * needs[res as Resource];
    }
    if (yourIncome?.has(n)) value *= 0.5; // that tile may pay you too
    if (!best || value > best.value) best = { n, value };
  }

  let blockHint = "";
  if (best) {
    const payout = describeDelta(p.incomeByNumber.get(best.n)!);
    const alsoYours = yourIncome?.has(best.n)
      ? " (careful: a tile on that number may pay you too)"
      : "";
    blockHint = ` Block their ${best.n} — it pays them ${payout}, which their plan needs most${alsoYours}.`;
  }
  const friendly =
    visibleVp(p) < 3
      ? ` They're under 3 VP, so with friendly robber you can't steal — blocking the tile still works.`
      : "";
  return {
    target: p.name,
    reason:
      `${p.name} leads the threat board: ${visibleVp(p)} visible VP, ` +
      `~${(productionTotal(expectedProduction(p)) * 36).toFixed(0)} pips of income, ` +
      `${handTotal(p)}${p.uncertainty ? `±${p.uncertainty}` : ""} cards in hand.` +
      blockHint +
      friendly,
  };
}

function describeDelta(d: Partial<Record<Resource, number>>): string {
  return Object.entries(d)
    .filter(([, v]) => (v ?? 0) > 0)
    .map(([r, v]) => `${v} ${r}`)
    .join(", ");
}

// ---------------------------------------------------------------- trading

export interface LiveTradeTip {
  text: string;
}

/** 2 players = colonist 1v1: no player-to-player trading, 15 VP to win. */
export function isOneVsOne(state: TrackerState): boolean {
  return state.players.size === 2;
}

export function tradeTips(state: TrackerState, name: string, fit: LiveStrategyFit | undefined): LiveTradeTip[] {
  const p = state.players.get(name);
  if (!p || !fit) return [];
  const tips: LiveTradeTip[] = [];
  const w = fit.strategy.weights;
  const prod = expectedProduction(p);
  const oneVsOne = isOneVsOne(state);

  // What is the next thing the strategy wants, and what's missing for it?
  for (const item of fit.strategy.buildOrder) {
    const cost = BUILD_COSTS[item];
    const missing = RESOURCES.filter((r) => (cost[r] ?? 0) > p.hand[r]);
    const missingCount = missing.reduce((s, r) => s + (cost[r] ?? 0) - p.hand[r], 0);
    if (missingCount === 0) break; // the Your-move box covers "build it now"
    if (missingCount <= 2) {
      const surplus = RESOURCES.filter(
        (r) => p.hand[r] - (cost[r] ?? 0) >= (p.bankRatio[r] ?? 4),
      );
      if (oneVsOne) {
        if (surplus.length) {
          tips.push({
            text: `${missingCount} card${missingCount > 1 ? "s" : ""} short of a ${item}: bank-trade ${surplus[0]} (${p.bankRatio[surplus[0]] ?? 4}:1) for ${missing.join(" + ")}.`,
          });
        }
      } else {
        tips.push({
          text:
            `One trade from a ${item}: get ${missing.join(" + ")}` +
            (surplus.length ? `, offer ${surplus.join(" or ")}` : "") +
            ".",
        });
      }
      break;
    }
  }

  const surplusRes = [...RESOURCES].sort(
    (a, b) => prod[b] * (2 - w[b]) - prod[a] * (2 - w[a]),
  )[0];
  const neededRes = [...RESOURCES].sort((a, b) => w[b] - w[a]).find((r) => prod[r] < 0.05);
  if (surplusRes && neededRes && surplusRes !== neededRes) {
    tips.push({
      text: oneVsOne
        ? `Long-term: you produce almost no ${neededRes}. No player trades in 1v1 — funnel surplus ${surplusRes} through the bank or grab a ${neededRes} port.`
        : `Long-term: your ${surplusRes} income is expendable for ${fit.strategy.name}; you produce almost no ${neededRes} — trade or port toward it.`,
    });
  }
  const ratio = RESOURCES.find((r) => (p.bankRatio[r] ?? 4) <= 3);
  if (ratio && !oneVsOne) {
    tips.push({
      text: `Never accept a worse deal than your ${p.bankRatio[ratio]}:1 bank rate on ${ratio}.`,
    });
  }
  return tips;
}

// ---------------------------------------------------------------- your move

export interface MoveAction {
  text: string;
  /** primary = do this now; the rest are context */
  primary: boolean;
}

export interface PlacementFacts {
  /** a legal settlement spot is reachable RIGHT NOW on your road network */
  canPlaceSettlement: boolean;
  /** description of the best settlement spot (rank ① on the map) */
  bestSpotLabel: string | null;
  /** a suggested road exists (dashed on the map) */
  hasRoadSuggestion: boolean;
  /** description of your best settlement to upgrade to a city */
  cityUpgradeLabel: string | null;
}

/**
 * Turn-by-turn instruction list: what to do immediately with the cards in
 * hand, in the recommended strategy's priority order, respecting what the
 * board actually allows.
 */
export function nextMoves(
  state: TrackerState,
  name: string,
  fit: LiveStrategyFit | undefined,
  facts: PlacementFacts | null,
): MoveAction[] {
  const p = state.players.get(name);
  if (!p || !fit) return [];
  const actions: MoveAction[] = [];
  const hand = { ...p.hand };

  // Discard plan: shown proactively whenever a 7 would force a discard.
  const total = RESOURCES.reduce((s, r) => s + hand[r], 0);
  if (total > 7) {
    const toDiscard = Math.floor(total / 2);
    const keepFor = fit.strategy.buildOrder[0];
    const keep = { ...BUILD_COSTS[keepFor] };
    const discards: string[] = [];
    const pool = { ...hand };
    for (let i = 0; i < toDiscard; i++) {
      // drop the resource with the most cards beyond what the next build needs,
      // breaking ties toward the strategy's least-valued resource
      const pick = [...RESOURCES].sort(
        (a, b) =>
          pool[b] - (keep[b] ?? 0) - (pool[a] - (keep[a] ?? 0)) ||
          fit.strategy.weights[a] - fit.strategy.weights[b],
      )[0];
      pool[pick]--;
      discards.push(pick);
    }
    const counts = new Map<string, number>();
    for (const d of discards) counts.set(d, (counts.get(d) ?? 0) + 1);
    actions.push({
      text: `If a 7 rolls, discard ${[...counts].map(([r, n]) => `${n} ${r}`).join(" + ")} — keep the makings of a ${keepFor}.`,
      primary: false,
    });
  }

  const canAfford = (item: keyof typeof BUILD_COSTS): boolean =>
    RESOURCES.every((r) => hand[r] >= (BUILD_COSTS[item][r] ?? 0));
  const pay = (item: keyof typeof BUILD_COSTS): void => {
    for (const r of RESOURCES) hand[r] -= BUILD_COSTS[item][r] ?? 0;
  };

  // Walk the strategy's priorities and emit everything affordable this turn.
  const tried = new Set<string>();
  for (const item of [...fit.strategy.buildOrder, "city", "settlement", "dev", "road"] as const) {
    if (tried.has(item)) continue;
    tried.add(item);
    if (!canAfford(item)) continue;

    if (item === "city") {
      if (p.settlements > 0) {
        actions.push({
          text: facts?.cityUpgradeLabel
            ? `Build a city: upgrade your settlement at ${facts.cityUpgradeLabel}.`
            : "Build a city on your best-producing settlement.",
          primary: true,
        });
        pay(item);
      }
    } else if (item === "settlement") {
      if (!facts || facts.canPlaceSettlement) {
        actions.push({
          text: facts?.bestSpotLabel
            ? `Build a settlement at ① ${facts.bestSpotLabel}.`
            : "Build a settlement at the marked spot.",
          primary: true,
        });
        pay(item);
      } else {
        actions.push({
          text: `You can afford a settlement but nowhere legal is connected — build the dashed road toward ① first.`,
          primary: !actions.some((a) => a.primary),
        });
      }
    } else if (item === "dev") {
      actions.push({ text: "Buy a development card.", primary: true });
      pay(item);
    } else if (item === "road") {
      if (!facts || facts.hasRoadSuggestion) {
        actions.push({
          text: "Build a road along the dashed segment toward ①.",
          primary: true,
        });
        pay(item);
      }
    }
  }

  if (!actions.some((a) => a.primary)) {
    // Nothing affordable: name the closest goal and how to get there.
    let bestItem: keyof typeof BUILD_COSTS = fit.strategy.buildOrder[0];
    let bestMissing = Infinity;
    for (const item of fit.strategy.buildOrder) {
      const missing = RESOURCES.reduce(
        (s, r) => s + Math.max(0, (BUILD_COSTS[item][r] ?? 0) - hand[r]),
        0,
      );
      if (missing < bestMissing) {
        bestMissing = missing;
        bestItem = item;
      }
    }
    const missingList = RESOURCES.filter((r) => (BUILD_COSTS[bestItem][r] ?? 0) > hand[r])
      .map((r) => `${(BUILD_COSTS[bestItem][r] ?? 0) - hand[r]} ${r}`)
      .join(" + ");
    actions.push({
      text: `Nothing to build yet — save for a ${bestItem} (need ${missingList || "nothing"}).`,
      primary: true,
    });
  }

  return actions;
}
