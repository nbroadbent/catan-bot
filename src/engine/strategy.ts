import { playerProduction, rankVertices, scarcityWeights, combineWeights } from "./analysis";
import { GameState, PlayerId, RESOURCES, Resource, Strategy, StrategyId } from "./types";

export const STRATEGIES: Strategy[] = [
  {
    id: "road-expand",
    name: "Road & Expand",
    tagline: "Wood + brick: settle fast, take Longest Road",
    weights: { wood: 1.5, brick: 1.5, sheep: 0.9, wheat: 0.9, ore: 0.5 },
    buildOrder: ["road", "settlement", "road", "settlement", "city"],
  },
  {
    id: "city-dev",
    name: "Cities & Development",
    tagline: "Ore + wheat: cities, dev cards, Largest Army",
    weights: { wood: 0.5, brick: 0.5, sheep: 1.0, wheat: 1.5, ore: 1.6 },
    buildOrder: ["city", "dev", "city", "dev", "settlement"],
  },
  {
    id: "port-trade",
    name: "Port Monopoly",
    tagline: "Overload one abundant resource and trade through a 2:1 port",
    weights: { wood: 1.0, brick: 1.0, sheep: 1.0, wheat: 1.0, ore: 1.0 },
    buildOrder: ["settlement", "city", "settlement", "dev", "city"],
  },
  {
    id: "balanced",
    name: "Balanced",
    tagline: "No strong lean yet — take the highest-production spots and stay flexible",
    weights: { wood: 1.0, brick: 1.0, sheep: 1.0, wheat: 1.0, ore: 1.0 },
    buildOrder: ["settlement", "road", "city", "dev", "settlement"],
  },
];

export function getStrategy(id: StrategyId): Strategy {
  return STRATEGIES.find((s) => s.id === id)!;
}

export interface StrategyFit {
  strategy: Strategy;
  score: number;
  rationale: string[];
}

/**
 * Score how well each strategy fits a player, from:
 *  1. current production alignment with the strategy's key resources
 *  2. quality of remaining board spots that feed the strategy
 *  3. port access for port-trade
 */
export function rankStrategies(state: GameState, player: PlayerId): StrategyFit[] {
  const prod = playerProduction(state, player);
  const scarcity = scarcityWeights(state.board);
  const totalProd = RESOURCES.reduce((s, r) => s + prod[r], 0);

  const fits = STRATEGIES.map((strategy) => {
    const rationale: string[] = [];

    // 1. production alignment (expected cards/roll, weighted)
    let alignment = 0;
    for (const r of RESOURCES) alignment += prod[r] * strategy.weights[r];
    const alignScore = alignment * 36; // scale to weighted pips for readability

    // 2. what the board still offers this strategy
    const spots = rankVertices(state, combineWeights(strategy.weights, scarcity), 3);
    const boardScore = spots.reduce((s, v) => s + v.score, 0) * 0.25;

    let score = alignScore + boardScore;

    // 3. strategy-specific adjustments
    if (strategy.id === "port-trade") {
      const ports = state.buildings
        .filter((b) => b.player === player)
        .map((b) => state.board.vertices[b.vertexId].port)
        .filter((p) => p !== null);
      const twoToOne = ports.find((p) => p!.ratio === 2);
      if (twoToOne) {
        const feed = prod[twoToOne!.kind as Resource] * 36;
        score += feed * 1.5;
        rationale.push(`You hold a 2:1 ${twoToOne!.kind} port with ${feed.toFixed(0)} pips feeding it`);
      } else if (ports.length > 0) {
        score += 3;
        rationale.push("You hold a 3:1 port");
      } else {
        score *= 0.6;
        rationale.push("No port yet — grab one before committing to this");
      }
    }

    const keyRes = RESOURCES.filter((r) => strategy.weights[r] >= 1.4);
    if (keyRes.length > 0) {
      const keyProd = keyRes.reduce((s, r) => s + prod[r], 0) * 36;
      if (totalProd > 0 && keyProd >= totalProd * 36 * 0.45) {
        rationale.push(`Strong ${keyRes.join("+")} base (${keyProd.toFixed(0)} of your pips)`);
      } else if (totalProd > 0) {
        rationale.push(`Needs more ${keyRes.join("/")} than you currently produce`);
      }
    }
    if (spots.length > 0 && spots[0].score > 10) {
      rationale.push(`Board still has strong expansion spots for this plan`);
    }

    return { strategy, score, rationale };
  });

  return fits.sort((a, b) => b.score - a.score);
}
