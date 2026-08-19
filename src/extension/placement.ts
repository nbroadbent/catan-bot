import { hexCornerPoints, vertexPips } from "../engine/board";
import {
  combineWeights,
  isVertexBuildable,
  rankVertices,
  scarcityWeights,
} from "../engine/analysis";
import { advisePlayer } from "../engine/advisor";
import { GameState, PlayerId, RESOURCES, Resource, pips } from "../engine/types";

/** colonist.io server color ids (from open-source replay tooling) */
export const COLONIST_COLORS: Record<number, string> = {
  1: "#E27174",
  2: "#223697",
  3: "#E09742",
  4: "#62B95D",
  5: "#9B6EA9",
  6: "#F5D442",
  7: "#5FB3B3",
  8: "#8B5A2B",
};

export interface SpotAdvice {
  vertexId: number;
  rank: number;
  label: string;
}

export interface PlacementAdvice {
  phase: "setup" | "main";
  heading: string;
  spots: SpotAdvice[];
  /** edge ids to highlight as the next road(s) to build */
  roadEdges: number[];
  note: string | null;
}

export function describeVertex(state: GameState, vertexId: number): string {
  const v = state.board.vertices[vertexId];
  const parts = v.hexIds
    .map((hid) => state.board.hexes[hid])
    .filter((h) => h.kind !== "desert" && h.token !== null)
    .sort((a, b) => pips(b.token) - pips(a.token))
    .map((h) => `${h.token}-${h.kind}`);
  const total = vertexPips(state.board, vertexId);
  const port = v.port ? (v.port.ratio === 2 ? `, 2:1 ${v.port.kind} port` : ", 3:1 port") : "";
  return `${parts.join(" + ") || "coastal"} (${total} pips${port})`;
}

/**
 * Shortest road path from the player's network to a target vertex.
 * Traverses only edges without roads; cannot pass through opponents' buildings.
 * Returns edge ids along the path.
 */
export function roadPathTo(
  state: GameState,
  player: PlayerId,
  target: number,
): number[] {
  const sources = new Set<number>();
  for (const b of state.buildings) if (b.player === player) sources.add(b.vertexId);
  for (const r of state.roads) {
    if (r.player === player) {
      const e = state.board.edges[r.edgeId];
      sources.add(e.a);
      sources.add(e.b);
    }
  }
  if (sources.size === 0) return [];

  const blocked = new Set(
    state.buildings.filter((b) => b.player !== player).map((b) => b.vertexId),
  );
  const takenEdges = new Set(state.roads.map((r) => r.edgeId));

  const prev = new Map<number, { vertex: number; edge: number }>();
  const queue: number[] = [...sources];
  const seen = new Set(queue);
  while (queue.length) {
    const cur = queue.shift()!;
    if (cur === target) break;
    if (blocked.has(cur) && !sources.has(cur)) continue;
    for (const n of state.board.vertices[cur].adjacent) {
      if (seen.has(n)) continue;
      const edge = state.board.edges.find(
        (e) => (e.a === cur && e.b === n) || (e.a === n && e.b === cur),
      );
      if (!edge || takenEdges.has(edge.id)) continue;
      seen.add(n);
      prev.set(n, { vertex: cur, edge: edge.id });
      queue.push(n);
    }
  }
  if (!seen.has(target)) return [];
  const path: number[] = [];
  let cur = target;
  while (prev.has(cur)) {
    const p = prev.get(cur)!;
    path.unshift(p.edge);
    cur = p.vertex;
  }
  return path;
}

export function advisePlacement(
  state: GameState,
  youPlayer: PlayerId | null,
): PlacementAdvice | null {
  if (youPlayer === null) {
    // No self-identification yet: still useful during setup — show the best
    // open spots on the board.
    const scarcity = scarcityWeights(state.board);
    const neutral = Object.fromEntries(RESOURCES.map((r) => [r, 1])) as Record<Resource, number>;
    const top = rankVertices(state, combineWeights(neutral, scarcity), 3);
    return {
      phase: "setup",
      heading: "Best open spots",
      spots: top.map((s, i) => ({
        vertexId: s.vertexId,
        rank: i + 1,
        label: describeVertex(state, s.vertexId),
      })),
      roadEdges: [],
      note: null,
    };
  }

  const yourBuildings = state.buildings.filter((b) => b.player === youPlayer);
  const setup = yourBuildings.length < 2 && state.buildings.length < 8;

  if (setup) {
    const scarcity = scarcityWeights(state.board);
    const neutral = Object.fromEntries(RESOURCES.map((r) => [r, 1])) as Record<Resource, number>;
    const base = combineWeights(neutral, scarcity);
    // Second settlement: bias toward completing a build-cost spread the first
    // settlement doesn't cover.
    let weights = base;
    let note: string | null = null;
    if (yourBuildings.length === 1) {
      const covered = new Set(
        state.board.vertices[yourBuildings[0].vertexId].hexIds
          .map((h) => state.board.hexes[h].kind)
          .filter((k) => k !== "desert"),
      );
      weights = { ...base };
      for (const r of RESOURCES) if (!covered.has(r)) weights[r] *= 1.35;
      const missing = RESOURCES.filter((r) => !covered.has(r));
      if (missing.length) note = `Your first spot lacks ${missing.join(", ")} — these picks fill the gap.`;
    }
    const top = rankVertices(state, weights, 3);
    return {
      phase: "setup",
      heading: yourBuildings.length === 0 ? "Place your 1st settlement here" : "Place your 2nd settlement here",
      spots: top.map((s, i) => ({
        vertexId: s.vertexId,
        rank: i + 1,
        label: describeVertex(state, s.vertexId),
      })),
      roadEdges: [],
      note,
    };
  }

  // Main game: expansion targets + the concrete road path to the best one.
  const advice = advisePlayer(state, youPlayer);
  const spots = advice.expansion.slice(0, 3).map((s, i) => ({
    vertexId: s.vertexId,
    rank: i + 1,
    label: describeVertex(state, s.vertexId),
  }));
  let roadEdges: number[] = [];
  let note: string | null = null;
  if (spots.length > 0) {
    const path = roadPathTo(state, youPlayer, spots[0].vertexId);
    roadEdges = path.slice(0, 2);
    if (path.length > 0) {
      note = `${path.length} road${path.length > 1 ? "s" : ""} to reach spot ①${path.length > 2 ? " — dashed segments are the next two" : ""}.`;
    }
  }
  return {
    phase: "main",
    heading: `Expand toward (${advice.recommended.strategy.name})`,
    spots,
    roadEdges,
    note,
  };
}

/**
 * Facts the Your-move planner needs from the board: can a settlement actually
 * be placed right now (legal spot connected to your road network), where the
 * best spot is, and which settlement is the best city upgrade.
 */
export function placementFacts(
  state: GameState,
  youPlayer: PlayerId,
  advice: PlacementAdvice | null,
): {
  canPlaceSettlement: boolean;
  bestSpotLabel: string | null;
  hasRoadSuggestion: boolean;
  cityUpgradeLabel: string | null;
} {
  const network = new Set<number>();
  for (const b of state.buildings) if (b.player === youPlayer) network.add(b.vertexId);
  for (const r of state.roads) {
    if (r.player === youPlayer) {
      const e = state.board.edges[r.edgeId];
      network.add(e.a);
      network.add(e.b);
    }
  }
  const canPlaceSettlement = [...network].some((v) => isVertexBuildable(state, v));

  const yourSettlements = state.buildings.filter(
    (b) => b.player === youPlayer && b.kind === "settlement",
  );
  let cityUpgradeLabel: string | null = null;
  if (yourSettlements.length > 0) {
    const best = yourSettlements.reduce((a, b) =>
      vertexPips(state.board, a.vertexId) >= vertexPips(state.board, b.vertexId) ? a : b,
    );
    cityUpgradeLabel = describeVertex(state, best.vertexId);
  }

  return {
    canPlaceSettlement,
    bestSpotLabel: advice?.spots[0]?.label ?? null,
    hasRoadSuggestion: (advice?.roadEdges.length ?? 0) > 0,
    cityUpgradeLabel,
  };
}

// ------------------------------------------------------------------ minimap

const TILE_FILL: Record<string, string> = {
  brick: "var(--brick)",
  wheat: "var(--wheat)",
  sheep: "var(--sheep)",
  ore: "var(--ore)",
  wood: "var(--wood)",
  desert: "var(--desert, #d8cba0)",
};

export interface MiniMapMarks {
  spots: SpotAdvice[];
  roadEdges: number[];
  buildings: Array<{ vertexId: number; colorId: number; kind: "settlement" | "city" }>;
  roads: Array<{ edgeId: number; colorId: number }>;
}

/** Render the board + advice markers as an SVG string for the overlay. */
export function renderMiniMap(state: GameState, marks: MiniMapMarks): string {
  const b = state.board;
  const S = 26; // px per unit
  const xs = b.vertices.map((v) => v.x);
  const ys = b.vertices.map((v) => v.y);
  const minX = Math.min(...xs) - 0.5;
  const minY = Math.min(...ys) - 0.5;
  const w = Math.max(...xs) - minX + 0.5;
  const h = Math.max(...ys) - minY + 0.5;
  const px = (x: number) => ((x - minX) * S).toFixed(1);
  const py = (y: number) => ((y - minY) * S).toFixed(1);

  const parts: string[] = [];
  parts.push(
    `<svg viewBox="0 0 ${(w * S).toFixed(0)} ${(h * S).toFixed(0)}" style="width:100%;display:block" role="img" aria-label="board map with recommended placements">`,
  );

  for (const hex of b.hexes) {
    const pts = hexCornerPoints(hex)
      .map((p) => `${px(p.x)},${py(p.y)}`)
      .join(" ");
    parts.push(`<polygon points="${pts}" fill="${TILE_FILL[hex.kind]}" stroke="var(--surface)" stroke-width="1.5" opacity="0.85"/>`);
    if (hex.token !== null) {
      const hot = hex.token === 6 || hex.token === 8;
      parts.push(
        `<circle cx="${px(hex.cx)}" cy="${py(hex.cy)}" r="7.5" fill="var(--surface)"/>` +
          `<text x="${px(hex.cx)}" y="${py(hex.cy)}" text-anchor="middle" dominant-baseline="central" font-size="9" font-weight="${hot ? 700 : 500}" fill="${hot ? "var(--brick)" : "var(--ink)"}">${hex.token}</text>`,
      );
    }
  }

  // ports as small labels on their vertices
  for (const v of b.vertices) {
    if (v.port) {
      const label = v.port.ratio === 2 ? `2:1` : `3:1`;
      parts.push(
        `<text x="${px(v.x)}" y="${py(v.y)}" text-anchor="middle" dominant-baseline="central" font-size="5.5" fill="var(--ink-3)">${label}</text>`,
      );
    }
  }

  // existing roads
  for (const r of marks.roads) {
    const e = b.edges[r.edgeId];
    parts.push(
      `<line x1="${px(b.vertices[e.a].x)}" y1="${py(b.vertices[e.a].y)}" x2="${px(b.vertices[e.b].x)}" y2="${py(b.vertices[e.b].y)}" stroke="${COLONIST_COLORS[r.colorId] ?? "#888"}" stroke-width="3" stroke-linecap="round"/>`,
    );
  }
  // suggested next roads
  for (const edgeId of marks.roadEdges) {
    const e = b.edges[edgeId];
    parts.push(
      `<line x1="${px(b.vertices[e.a].x)}" y1="${py(b.vertices[e.a].y)}" x2="${px(b.vertices[e.b].x)}" y2="${py(b.vertices[e.b].y)}" stroke="var(--gold, #b8860b)" stroke-width="3.5" stroke-dasharray="4 3" stroke-linecap="round"/>`,
    );
  }
  // existing buildings
  for (const bd of marks.buildings) {
    const v = b.vertices[bd.vertexId];
    const c = COLONIST_COLORS[bd.colorId] ?? "#888";
    if (bd.kind === "city") {
      parts.push(`<rect x="${(parseFloat(px(v.x)) - 4.5).toFixed(1)}" y="${(parseFloat(py(v.y)) - 4.5).toFixed(1)}" width="9" height="9" fill="${c}" stroke="var(--surface)" stroke-width="1.2"/>`);
    } else {
      parts.push(`<circle cx="${px(v.x)}" cy="${py(v.y)}" r="4" fill="${c}" stroke="var(--surface)" stroke-width="1.2"/>`);
    }
  }
  // recommended spots: gold numbered badges
  for (const s of marks.spots) {
    const v = b.vertices[s.vertexId];
    parts.push(
      `<circle cx="${px(v.x)}" cy="${py(v.y)}" r="7" fill="var(--gold, #b8860b)" stroke="var(--surface)" stroke-width="1.5"/>` +
        `<text x="${px(v.x)}" y="${py(v.y)}" text-anchor="middle" dominant-baseline="central" font-size="8.5" font-weight="700" fill="#fff">${s.rank}</text>`,
    );
  }

  parts.push("</svg>");
  return parts.join("");
}
