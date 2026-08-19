import { vertexPips } from "./board";
import {
  Board,
  Building,
  GameState,
  PlayerId,
  RESOURCES,
  Resource,
  pips,
} from "./types";

/** Total pips on the board for each resource — the abundance profile. */
export function resourceAbundance(board: Board): Record<Resource, number> {
  const out = Object.fromEntries(RESOURCES.map((r) => [r, 0])) as Record<Resource, number>;
  for (const h of board.hexes) {
    if (h.kind !== "desert") out[h.kind] += pips(h.token);
  }
  return out;
}

/**
 * Scarcity weight per resource: scarce resources are worth more because
 * everyone will be short of them and they trade well.
 * Normalized so an average-abundance resource weighs 1.0.
 */
export function scarcityWeights(board: Board): Record<Resource, number> {
  const abundance = resourceAbundance(board);
  const avg = RESOURCES.reduce((s, r) => s + abundance[r], 0) / RESOURCES.length;
  const out = {} as Record<Resource, number>;
  for (const r of RESOURCES) {
    // clamp so a near-dead resource doesn't dominate every score
    out[r] = Math.min(1.8, Math.max(0.6, avg / Math.max(1, abundance[r])));
  }
  return out;
}

/** Expected cards/roll for each resource for one player's buildings. */
export function playerProduction(state: GameState, player: PlayerId): Record<Resource, number> {
  const out = Object.fromEntries(RESOURCES.map((r) => [r, 0])) as Record<Resource, number>;
  for (const b of state.buildings) {
    if (b.player !== player) continue;
    const mult = b.kind === "city" ? 2 : 1;
    for (const hid of state.board.vertices[b.vertexId].hexIds) {
      const h = state.board.hexes[hid];
      if (h.kind !== "desert" && h.token !== null) {
        out[h.kind] += (pips(h.token) / 36) * mult;
      }
    }
  }
  return out;
}

/** Distance rule: a vertex is buildable if it and all neighbors are empty. */
export function isVertexBuildable(state: GameState, vertexId: number): boolean {
  const occupied = new Set(state.buildings.map((b) => b.vertexId));
  if (occupied.has(vertexId)) return false;
  return !state.board.vertices[vertexId].adjacent.some((n) => occupied.has(n));
}

export interface VertexScore {
  vertexId: number;
  score: number;
  pips: number;
  resources: Resource[];
  notes: string[];
}

/**
 * Score a vertex for settlement placement.
 * weights: per-resource multipliers (strategy preferences x scarcity).
 */
export function scoreVertex(
  board: Board,
  vertexId: number,
  weights: Record<Resource, number>,
): VertexScore {
  const v = board.vertices[vertexId];
  const notes: string[] = [];
  const resources: Resource[] = [];
  let score = 0;
  let totalPips = 0;

  for (const hid of v.hexIds) {
    const h = board.hexes[hid];
    if (h.kind === "desert" || h.token === null) continue;
    const p = pips(h.token);
    totalPips += p;
    score += p * weights[h.kind];
    if (!resources.includes(h.kind)) resources.push(h.kind);
  }

  // Diversity: touching 3 distinct resources beats a mono-resource corner
  // of the same pip count (fewer dead rolls, easier building costs).
  score += (resources.length - 1) * 1.2;
  if (resources.length >= 3) notes.push("3-resource diversity");

  if (v.port) {
    const bonus = v.port.ratio === 2 ? 2.0 : 1.0;
    score += bonus;
    notes.push(v.port.ratio === 2 ? `2:1 ${v.port.kind} port` : "3:1 port");
  }
  if (totalPips >= 10) notes.push(`strong production (${totalPips} pips)`);

  return { vertexId, score, pips: totalPips, resources, notes };
}

/** Rank all legal settlement spots under the given weights. */
export function rankVertices(
  state: GameState,
  weights: Record<Resource, number>,
  limit = 5,
): VertexScore[] {
  return state.board.vertices
    .filter((v) => isVertexBuildable(state, v.id))
    .map((v) => scoreVertex(state.board, v.id, weights))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** Combine two weight maps multiplicatively. */
export function combineWeights(
  a: Record<Resource, number>,
  b: Record<Resource, number>,
): Record<Resource, number> {
  const out = {} as Record<Resource, number>;
  for (const r of RESOURCES) out[r] = a[r] * b[r];
  return out;
}

export function buildingsOf(state: GameState, player: PlayerId): Building[] {
  return state.buildings.filter((b) => b.player === player);
}

/** Graph distance (in edges) from any of the player's buildings to a vertex. */
export function distanceFromPlayer(state: GameState, player: PlayerId, vertexId: number): number {
  const sources = buildingsOf(state, player).map((b) => b.vertexId);
  if (sources.length === 0) return Infinity;
  const dist = new Map<number, number>();
  const queue: number[] = [];
  for (const s of sources) {
    dist.set(s, 0);
    queue.push(s);
  }
  while (queue.length) {
    const cur = queue.shift()!;
    const d = dist.get(cur)!;
    if (cur === vertexId) return d;
    for (const n of state.board.vertices[cur].adjacent) {
      if (!dist.has(n)) {
        dist.set(n, d + 1);
        queue.push(n);
      }
    }
  }
  return dist.get(vertexId) ?? Infinity;
}

export { vertexPips };
