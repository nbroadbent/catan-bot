import { mulberry32 } from "./board";
import { isVertexBuildable, distanceFromPlayer, scoreVertex, scarcityWeights, combineWeights } from "./analysis";
import {
  GameState,
  PlayerId,
  RESOURCES,
  Resource,
  Strategy,
  pips,
} from "./types";

/**
 * Catan's "balanced dice" (and most online implementations) draw from a deck
 * of the 36 possible two-die combinations instead of rolling fair dice, so
 * over a full deck every number appears exactly its expected count.
 * We reshuffle when the deck is empty.
 */
export class BalancedDice {
  private deck: number[] = [];
  /**
   * discardAt > 0 mimics colonist.io: the deck reshuffles with a few cards
   * still unplayed, so counting cards never becomes fully deterministic.
   */
  constructor(private rand: () => number, private discardAt = 0) {}

  private refill() {
    this.deck = [];
    for (let d1 = 1; d1 <= 6; d1++) {
      for (let d2 = 1; d2 <= 6; d2++) this.deck.push(d1 + d2);
    }
    for (let i = this.deck.length - 1; i > 0; i--) {
      const j = Math.floor(this.rand() * (i + 1));
      [this.deck[i], this.deck[j]] = [this.deck[j], this.deck[i]];
    }
  }

  roll(): number {
    if (this.deck.length <= this.discardAt) this.refill();
    return this.deck.pop()!;
  }
}

type Hand = Record<Resource, number>;

const COSTS: Record<"road" | "settlement" | "city" | "dev", Partial<Hand>> = {
  road: { wood: 1, brick: 1 },
  settlement: { wood: 1, brick: 1, sheep: 1, wheat: 1 },
  city: { ore: 3, wheat: 2 },
  dev: { ore: 1, sheep: 1, wheat: 1 },
};

function emptyHand(): Hand {
  return Object.fromEntries(RESOURCES.map((r) => [r, 0])) as Hand;
}

export interface SimResult {
  strategy: Strategy;
  /** mean victory points added over the horizon (excludes starting buildings) */
  meanVp: number;
  meanBuilds: { roads: number; settlements: number; cities: number; devs: number };
}

/**
 * Rough forward simulation of ONE player following a strategy for `rounds`
 * turns, against a static board (opponents don't move — this is a copilot
 * heuristic, not a full game engine). Uses balanced dice, greedy building
 * along the strategy's build order, and bank/port trading.
 */
export function simulateStrategy(
  state: GameState,
  player: PlayerId,
  strategy: Strategy,
  opts: { rounds?: number; trials?: number; seed?: number } = {},
): SimResult {
  const { rounds = 25, trials = 40, seed = 1 } = opts;
  const totals = { roads: 0, settlements: 0, cities: 0, devs: 0, vp: 0 };

  const scarcity = scarcityWeights(state.board);
  const weights = combineWeights(strategy.weights, scarcity);

  for (let t = 0; t < trials; t++) {
    const rand = mulberry32(seed + t * 7919);
    const dice = new BalancedDice(rand, 4); // colonist.io-style early reshuffle
    const hand = emptyHand();

    // Working copy of buildings/roads so the sim can add its own.
    const sim: GameState = {
      board: state.board,
      buildings: state.buildings.map((b) => ({ ...b })),
      roads: state.roads.map((r) => ({ ...r })),
    };
    let reach = sim.roads.filter((r) => r.player === player).length;
    const built = { roads: 0, settlements: 0, cities: 0, devs: 0 };
    let orderIdx = 0;

    const bestRatio = (res: Resource): number => {
      let ratio = 4;
      for (const b of sim.buildings) {
        if (b.player !== player) continue;
        const port = sim.board.vertices[b.vertexId].port;
        if (!port) continue;
        if (port.kind === "any") ratio = Math.min(ratio, 3);
        else if (port.kind === res) ratio = Math.min(ratio, 2);
      }
      return ratio;
    };

    const tryBuy = (item: keyof typeof COSTS): boolean => {
      const cost = COSTS[item];
      const missing: Partial<Hand> = {};
      let missingTotal = 0;
      for (const r of RESOURCES) {
        const need = (cost[r] ?? 0) - hand[r];
        if (need > 0) {
          missing[r] = need;
          missingTotal += need;
        }
      }
      if (missingTotal > 0) {
        // trade surplus toward missing, best ratio per resource
        for (const give of RESOURCES) {
          if (missingTotal === 0) break;
          const surplus = hand[give] - (cost[give] ?? 0);
          const ratio = bestRatio(give);
          let tradeable = Math.floor(Math.max(0, surplus) / ratio);
          while (tradeable > 0 && missingTotal > 0) {
            const wanted = RESOURCES.find((r) => (missing[r] ?? 0) > 0)!;
            hand[give] -= ratio;
            hand[wanted] += 1;
            missing[wanted]! -= 1;
            missingTotal -= 1;
            tradeable -= 1;
          }
        }
        for (const r of RESOURCES) if ((cost[r] ?? 0) > hand[r]) return false;
      }

      // structural checks + placement
      if (item === "settlement") {
        const spots = sim.board.vertices
          .filter((v) => isVertexBuildable(sim, v.id))
          .filter((v) => distanceFromPlayer(sim, player, v.id) <= Math.max(1, reach))
          .map((v) => scoreVertex(sim.board, v.id, weights))
          .sort((a, b) => b.score - a.score);
        if (spots.length === 0) return false;
        sim.buildings.push({ vertexId: spots[0].vertexId, player, kind: "settlement" });
        built.settlements++;
      } else if (item === "city") {
        const target = sim.buildings.find((b) => b.player === player && b.kind === "settlement");
        if (!target) return false;
        target.kind = "city";
        built.cities++;
      } else if (item === "road") {
        reach++;
        built.roads++;
      } else {
        built.devs++;
      }
      for (const r of RESOURCES) hand[r] -= COSTS[item][r] ?? 0;
      return true;
    };

    for (let round = 0; round < rounds; round++) {
      const roll = dice.roll();
      if (roll !== 7) {
        for (const b of sim.buildings) {
          if (b.player !== player) continue;
          const mult = b.kind === "city" ? 2 : 1;
          for (const hid of sim.board.vertices[b.vertexId].hexIds) {
            const h = sim.board.hexes[hid];
            if (h.kind !== "desert" && h.token === roll) hand[h.kind] += mult;
          }
        }
      } else {
        // robber: discard half if over 7 (rounded down), dump the largest piles
        let count = RESOURCES.reduce((s, r) => s + hand[r], 0);
        if (count > 7) {
          let toDiscard = Math.floor(count / 2);
          while (toDiscard > 0) {
            const biggest = RESOURCES.reduce((a, b) => (hand[a] >= hand[b] ? a : b));
            hand[biggest]--;
            toDiscard--;
          }
        }
      }

      // Greedy: try current build-order item, else anything else affordable.
      const order = strategy.buildOrder;
      if (tryBuy(order[orderIdx % order.length])) {
        orderIdx++;
      } else {
        for (const alt of ["city", "settlement", "dev", "road"] as const) {
          if (alt !== order[orderIdx % order.length] && tryBuy(alt)) break;
        }
      }
    }

    totals.roads += built.roads;
    totals.settlements += built.settlements;
    totals.cities += built.cities;
    totals.devs += built.devs;
    // VP: settlement 1, city upgrade +1, dev card ~0.3 expected (5 VP cards +
    // knights toward Largest Army), +2 if enough devs to plausibly take it.
    totals.vp +=
      built.settlements + built.cities + built.devs * 0.3 + (built.devs >= 5 ? 2 : 0);
  }

  return {
    strategy,
    meanVp: totals.vp / trials,
    meanBuilds: {
      roads: totals.roads / trials,
      settlements: totals.settlements / trials,
      cities: totals.cities / trials,
      devs: totals.devs / trials,
    },
  };
}

/** Sanity helper: distribution of a full balanced-dice deck. */
export function expectedRollCounts(): Map<number, number> {
  const counts = new Map<number, number>();
  for (let s = 2; s <= 12; s++) counts.set(s, pips(s) === 0 ? 0 : 0);
  for (let d1 = 1; d1 <= 6; d1++) {
    for (let d2 = 1; d2 <= 6; d2++) {
      counts.set(d1 + d2, (counts.get(d1 + d2) ?? 0) + 1);
    }
  }
  return counts;
}
