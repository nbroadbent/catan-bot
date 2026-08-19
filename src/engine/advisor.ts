import {
  buildingsOf,
  combineWeights,
  distanceFromPlayer,
  isVertexBuildable,
  playerProduction,
  rankVertices,
  resourceAbundance,
  scarcityWeights,
  scoreVertex,
  VertexScore,
} from "./analysis";
import { rankStrategies, StrategyFit } from "./strategy";
import { simulateStrategy, SimResult } from "./simulate";
import { GameState, PlayerId, RESOURCES, Resource } from "./types";

export interface BoardReport {
  abundance: Record<Resource, number>;
  scarcity: Record<Resource, number>;
  scarcest: Resource;
  richest: Resource;
  notes: string[];
}

export function analyzeBoard(state: GameState): BoardReport {
  const abundance = resourceAbundance(state.board);
  const scarcity = scarcityWeights(state.board);
  const sorted = [...RESOURCES].sort((a, b) => abundance[a] - abundance[b]);
  const scarcest = sorted[0];
  const richest = sorted[sorted.length - 1];

  const notes: string[] = [];
  notes.push(
    `${cap(richest)} is plentiful (${abundance[richest]} pips) — it will trade poorly, don't over-invest.`,
  );
  notes.push(
    `${cap(scarcest)} is scarce (${abundance[scarcest]} pips) — corner it and everyone trades with you.`,
  );
  const roadRes = abundance.wood + abundance.brick;
  const cityRes = abundance.ore + abundance.wheat;
  if (roadRes > cityRes + 4) {
    notes.push("Board favors road/settlement builds over city builds.");
  } else if (cityRes > roadRes + 4) {
    notes.push("Board favors ore+wheat city/dev-card play.");
  } else {
    notes.push("Road and city resources are evenly matched — placement decides it.");
  }
  return { abundance, scarcity, scarcest, richest, notes };
}

export interface PlacementAdvice {
  /** best legal spots under neutral+scarcity weighting */
  top: VertexScore[];
  /** for each strategy, its single best remaining spot */
  byStrategy: Array<{ strategyName: string; spot: VertexScore }>;
}

export function initialPlacementAdvice(state: GameState): PlacementAdvice {
  const scarcity = scarcityWeights(state.board);
  const neutral = Object.fromEntries(RESOURCES.map((r) => [r, 1])) as Record<Resource, number>;
  const top = rankVertices(state, combineWeights(neutral, scarcity), 5);

  const byStrategy = rankStrategies(state, 0)
    .map((fit) => {
      const spots = rankVertices(state, combineWeights(fit.strategy.weights, scarcity), 1);
      return spots.length
        ? { strategyName: fit.strategy.name, spot: spots[0] }
        : null;
    })
    .filter((x): x is { strategyName: string; spot: VertexScore } => x !== null);

  return { top, byStrategy };
}

export interface TradeTip {
  give: Resource;
  get: Resource;
  reason: string;
}

export interface PlayerAdvice {
  strategies: StrategyFit[];
  simulations: SimResult[];
  /** best strategy after blending heuristic fit with simulated VP */
  recommended: StrategyFit;
  expansion: VertexScore[];
  trades: TradeTip[];
}

export function advisePlayer(state: GameState, player: PlayerId): PlayerAdvice {
  const strategies = rankStrategies(state, player);
  const hasBuildings = buildingsOf(state, player).length > 0;

  const simulations = hasBuildings
    ? strategies.map((f) =>
        simulateStrategy(state, player, f.strategy, {
          rounds: 25,
          trials: 30,
          seed: state.board.seed + player,
        }),
      )
    : [];

  // Blend: normalize both signals, weight sim slightly higher when available.
  let recommended = strategies[0];
  if (simulations.length > 0) {
    const maxFit = Math.max(...strategies.map((s) => s.score), 1);
    const maxVp = Math.max(...simulations.map((s) => s.meanVp), 0.1);
    let best = -Infinity;
    for (const fit of strategies) {
      const sim = simulations.find((s) => s.strategy.id === fit.strategy.id)!;
      const blended = 0.45 * (fit.score / maxFit) + 0.55 * (sim.meanVp / maxVp);
      if (blended > best) {
        best = blended;
        recommended = fit;
      }
    }
  }

  const scarcity = scarcityWeights(state.board);
  const weights = combineWeights(recommended.strategy.weights, scarcity);
  // Nearby spots are cheaper to reach: penalize each edge of distance
  // by roughly the value of a road's worth of resources.
  const expansion = state.board.vertices
    .filter((v) => isVertexBuildable(state, v.id))
    .map((v) => ({
      score: scoreVertex(state.board, v.id, weights),
      dist: distanceFromPlayer(state, player, v.id),
    }))
    .filter((x) => x.dist <= 3)
    .sort((a, b) => b.score.score - b.dist * 1.5 - (a.score.score - a.dist * 1.5))
    .slice(0, 3)
    .map((x) => x.score);

  const trades = tradeTips(state, player, recommended);
  return { strategies, simulations, recommended, expansion, trades };
}

function tradeTips(state: GameState, player: PlayerId, fit: StrategyFit): TradeTip[] {
  const prod = playerProduction(state, player);
  const w = fit.strategy.weights;
  const tips: TradeTip[] = [];

  const surplus = [...RESOURCES].sort(
    (a, b) => prod[b] * (2 - w[b]) - prod[a] * (2 - w[a]),
  )[0];
  const needed = [...RESOURCES].sort(
    (a, b) => w[b] * (1 - Math.min(1, prod[b] * 12)) - w[a] * (1 - Math.min(1, prod[a] * 12)),
  )[0];

  if (surplus && needed && surplus !== needed && prod[surplus] > 0) {
    tips.push({
      give: surplus,
      get: needed,
      reason: `${cap(surplus)} is your most expendable income; ${cap(needed)} is the bottleneck for ${fit.strategy.name}.`,
    });
  }
  const scarcest = analyzeBoard(state).scarcest;
  if (prod[scarcest] > 0.08) {
    tips.push({
      give: scarcest,
      get: needed === scarcest ? surplus : needed,
      reason: `You produce scarce ${scarcest} — demand steep prices (2:1 or better) from other players.`,
    });
  }
  return tips;
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
