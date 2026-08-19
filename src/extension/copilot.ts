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
  let best: { n: number; res: Resource; amount: number } | null = null;
  for (const [n, delta] of p.incomeByNumber) {
    for (const [res, count] of Object.entries(delta)) {
      const value = (count ?? 0) * pips(n);
      if (!best || value > best.amount) best = { n, res: res as Resource, amount: value };
    }
  }
  const blockHint = best
    ? ` Their biggest earner is ${best.n} (pays them ${p.incomeByNumber.get(best.n) ? describeDelta(p.incomeByNumber.get(best.n)!) : best.res}) — block that tile.`
    : "";
  return {
    target: p.name,
    reason:
      `${p.name} leads the threat board: ${visibleVp(p)} visible VP, ` +
      `~${(productionTotal(expectedProduction(p)) * 36).toFixed(0)} pips of income, ` +
      `${handTotal(p)}${p.uncertainty ? `±${p.uncertainty}` : ""} cards in hand.` +
      blockHint,
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

export function tradeTips(state: TrackerState, name: string, fit: LiveStrategyFit | undefined): LiveTradeTip[] {
  const p = state.players.get(name);
  if (!p || !fit) return [];
  const tips: LiveTradeTip[] = [];
  const w = fit.strategy.weights;
  const prod = expectedProduction(p);

  // What is the next thing the strategy wants, and what's missing for it?
  for (const item of fit.strategy.buildOrder) {
    const cost = BUILD_COSTS[item];
    const missing = RESOURCES.filter((r) => (cost[r] ?? 0) > p.hand[r]);
    const missingCount = missing.reduce((s, r) => s + (cost[r] ?? 0) - p.hand[r], 0);
    if (missingCount === 0) {
      tips.push({ text: `You can afford a ${item} right now — build it.` });
      break;
    }
    if (missingCount <= 2) {
      const surplus = RESOURCES.filter((r) => p.hand[r] - (cost[r] ?? 0) >= 2);
      tips.push({
        text:
          `One trade from a ${item}: get ${missing.join(" + ")}` +
          (surplus.length ? `, offer ${surplus.join(" or ")}` : "") +
          ".",
      });
      break;
    }
  }

  const surplusRes = [...RESOURCES].sort(
    (a, b) => prod[b] * (2 - w[b]) - prod[a] * (2 - w[a]),
  )[0];
  const neededRes = [...RESOURCES].sort((a, b) => w[b] - w[a]).find((r) => prod[r] < 0.05);
  if (surplusRes && neededRes && surplusRes !== neededRes) {
    tips.push({
      text: `Long-term: your ${surplusRes} income is expendable for ${fit.strategy.name}; you produce almost no ${neededRes} — trade or port toward it.`,
    });
  }
  const ratio = RESOURCES.find((r) => (p.bankRatio[r] ?? 4) <= 3);
  if (ratio) {
    tips.push({
      text: `Never accept a worse deal than your ${p.bankRatio[ratio]}:1 bank rate on ${ratio}.`,
    });
  }
  return tips;
}
