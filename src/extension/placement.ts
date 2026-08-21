import { hexCornerPoints, vertexPips } from "../engine/board";
import {
  combineWeights,
  isVertexBuildable,
  playerProduction,
  rankVertices,
  scarcityWeights,
  scoreVertex,
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
  /** full road-path length to spot ① (roadEdges is trimmed to the next two) */
  roadPathLength?: number;
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
  fromVertices?: number[],
): number[] {
  const sources = new Set<number>();
  if (fromVertices) {
    for (const v of fromVertices) sources.add(v);
  } else {
    for (const b of state.buildings) if (b.player === player) sources.add(b.vertexId);
    for (const r of state.roads) {
      if (r.player === player) {
        const e = state.board.edges[r.edgeId];
        sources.add(e.a);
        sources.add(e.b);
      }
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

/**
 * Setup-placement ranking with diminishing returns. The pair of opening
 * settlements is a PORTFOLIO: a second brick/sheep corner adds little when
 * the first already makes brick and sheep, while the first wheat or wood
 * adds a lot. Score a candidate by the marginal sqrt-utility it adds to the
 * player's existing production per resource — concave, so coverage beats
 * piling pips onto one resource — plus the usual port bonus. (Game-log fix:
 * a 4p loss opened on 10- and 11-pip brick/sheep corners with no wheat or
 * wood at all, then burned 48 cards in 4:1 trades.)
 */
const SETUP_NEED: Record<Resource, number> = { wheat: 1.25, ore: 1.1, wood: 1.0, brick: 1.0, sheep: 0.85 };

export function rankSetupSpots(
  state: GameState,
  youPlayer: PlayerId,
  weights: Record<Resource, number>,
  limit = 3,
) {
  const existing = playerProduction(state, youPlayer); // cards/roll
  const scored = state.board.vertices
    .filter((v) => isVertexBuildable(state, v.id))
    .map((v) => {
      const base = scoreVertex(state.board, v.id, weights);
      const add: Partial<Record<Resource, number>> = {};
      for (const hid of v.hexIds) {
        const h = state.board.hexes[hid];
        if (h.kind === "desert" || h.token === null) continue;
        add[h.kind] = (add[h.kind] ?? 0) + pips(h.token);
      }
      let utility = 0;
      for (const r of RESOURCES) {
        const have = existing[r] * 36; // back to pips
        const more = add[r] ?? 0;
        utility += weights[r] * SETUP_NEED[r] * (Math.sqrt(have + more) - Math.sqrt(have));
      }
      // keep the port signal from scoreVertex (it's the only non-pip term we want)
      const portBonus = v.port ? (v.port.ratio === 2 ? 2.5 + (add[v.port.kind as Resource] ?? 0) * 0.4 : 1.5) : 0;
      const score = utility * 3 + portBonus; // ×3 puts it on scoreVertex's pip-ish scale
      const covers = RESOURCES.filter((r) => (add[r] ?? 0) > 0 && existing[r] === 0);
      const notes = [...base.notes];
      if (covers.length && state.buildings.some((b) => b.player === youPlayer)) notes.push(`adds ${covers.join("+")} you lack`);
      return { ...base, score, notes };
    })
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/**
 * Fewest roads any opponent needs to reach `target` from their current
 * network (buildings + road ends), honouring the rule that roads can't pass
 * through other players' buildings. 0 = they're already on it; Infinity =
 * unreachable / no opponents yet.
 */
export function opponentDistance(state: GameState, you: PlayerId, target: number): number {
  const opps = new Set<PlayerId>();
  for (const b of state.buildings) if (b.player !== you) opps.add(b.player);
  for (const r of state.roads) if (r.player !== you) opps.add(r.player);
  let best = Infinity;
  for (const opp of opps) {
    const from = new Set<number>();
    for (const b of state.buildings) if (b.player === opp) from.add(b.vertexId);
    for (const r of state.roads) {
      if (r.player === opp) {
        const e = state.board.edges[r.edgeId];
        from.add(e.a);
        from.add(e.b);
      }
    }
    if (from.has(target)) return 0;
    const path = roadPathTo(state, opp, target, [...from]);
    if (path.length > 0) best = Math.min(best, path.length);
  }
  return best;
}

/**
 * A corner is CONTESTED when an opponent can reach it in no more roads than
 * we need: racing for it usually loses the roads we spent. (Player feedback:
 * setup roads pointed at corners a neighbour was already building toward,
 * and the roads were wasted when they took the spot.)
 */
export function isContested(state: GameState, you: PlayerId, target: number, ourDist: number): boolean {
  return opponentDistance(state, you, target) <= ourDist;
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
  const yourRoads = state.roads.filter((r) => r.player === youPlayer);
  const setup = yourBuildings.length < 2 && state.buildings.length < 8;

  // Setup road step: a settlement was just placed and its road is pending.
  if (yourBuildings.length > yourRoads.length && (setup || yourBuildings.length <= 2)) {
    return adviseSetupRoad(state, youPlayer, yourBuildings, yourRoads);
  }

  if (setup) {
    const scarcity = scarcityWeights(state.board);
    const neutral = Object.fromEntries(RESOURCES.map((r) => [r, 1])) as Record<Resource, number>;
    const base = combineWeights(neutral, scarcity);
    // Both setup picks use the portfolio ranking: diminishing returns per
    // resource across what you already produce, so the second settlement
    // covers what the first lacks instead of doubling down on it.
    let note: string | null = null;
    if (yourBuildings.length === 1) {
      const covered = new Set(
        state.board.vertices[yourBuildings[0].vertexId].hexIds
          .map((h) => state.board.hexes[h].kind)
          .filter((k) => k !== "desert"),
      );
      const missing = RESOURCES.filter((r) => !covered.has(r));
      if (missing.length) note = `Your first spot lacks ${missing.join(", ")} — these picks weigh that heavily.`;
    }
    const top = rankSetupSpots(state, youPlayer, base, 3);
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
  // Ranked by value minus road distance (actual road path, not crow-flies),
  // with contested corners pushed down so we don't pour roads into a race an
  // opponent is already winning.
  const advice = advisePlayer(state, youPlayer);
  const scarcity = scarcityWeights(state.board);
  const expWeights = combineWeights(advice.recommended.strategy.weights, scarcity);
  const ranked = rankVertices(state, expWeights, 14)
    .map((s) => {
      const dist = roadPathTo(state, youPlayer, s.vertexId).length;
      const contested = dist > 0 && isContested(state, youPlayer, s.vertexId, dist);
      return { s, dist, contested, value: s.score - dist * 1.5 - (contested ? 3.5 : 0) };
    })
    .filter((x) => x.dist > 0 && x.dist <= 3)
    .sort((a, b) => b.value - a.value);
  const spots = ranked.slice(0, 3).map((x, i) => ({
    vertexId: x.s.vertexId,
    rank: i + 1,
    label: `${describeVertex(state, x.s.vertexId)}${x.contested ? " — contested" : ""}`,
  }));
  let roadEdges: number[] = [];
  let roadPathLength = 0;
  let note: string | null = null;
  if (spots.length > 0) {
    const path = roadPathTo(state, youPlayer, spots[0].vertexId);
    roadEdges = path.slice(0, 2);
    roadPathLength = path.length;
    if (path.length > 0) {
      note = `${path.length} road${path.length > 1 ? "s" : ""} to reach spot ①${path.length > 2 ? " — dashed segments are the next two" : ""}.`;
    }
  }
  return {
    phase: "main",
    heading: `Expand toward (${advice.recommended.strategy.name})`,
    spots,
    roadEdges,
    roadPathLength,
    note,
  };
}

/**
 * The setup road placement: point it from the just-placed settlement toward
 * the best future expansion spot (respecting the distance rule), and show
 * that target so the direction makes sense.
 */
function adviseSetupRoad(
  state: GameState,
  youPlayer: PlayerId,
  yourBuildings: Array<{ vertexId: number }>,
  yourRoads: Array<{ edgeId: number }>,
): PlacementAdvice {
  const pending =
    yourBuildings.find((b) => {
      return !yourRoads.some((r) => {
        const e = state.board.edges[r.edgeId];
        return e.a === b.vertexId || e.b === b.vertexId;
      });
    }) ?? yourBuildings[yourBuildings.length - 1];

  const scarcity = scarcityWeights(state.board);
  const neutral = Object.fromEntries(RESOURCES.map((r) => [r, 1])) as Record<Resource, number>;
  const weights = combineWeights(neutral, scarcity);

  // Candidate future spots, valued high but discounted by road distance from
  // the pending settlement, and heavily discounted when CONTESTED — an
  // opponent can reach the corner in as few roads as we can, so committing a
  // setup road toward it usually just donates the road. Then pick the first
  // EDGE by option value: the best target through it plus a share of the
  // other targets it keeps open, so one road doesn't commit us to one race.
  const scored = rankVertices(state, weights, 12)
    .map((s) => {
      const path = roadPathTo(state, youPlayer, s.vertexId, [pending.vertexId]);
      const oppDist = opponentDistance(state, youPlayer, s.vertexId);
      const contested = oppDist <= path.length;
      const raw = s.score - path.length * 1.5;
      // strictly closer opponent: a race we lose — near-zero. Equal distance:
      // a coin flip, half value. 1 road away we can still claim it next turn.
      const factor = !contested ? 1 : path.length === 1 ? 0.6 : oppDist < path.length ? 0.25 : 0.5;
      return { s, path, oppDist, contested, value: raw * factor };
    })
    .filter((c) => c.path.length > 0 && c.path.length <= 4);
  const byEdge = new Map<number, typeof scored>();
  for (const c of scored) {
    const list = byEdge.get(c.path[0]) ?? [];
    list.push(c);
    byEdge.set(c.path[0], list);
  }
  let bestEdge: { edge: number; list: typeof scored; value: number } | null = null;
  for (const [edge, list] of byEdge) {
    list.sort((a, b) => b.value - a.value);
    const value = list[0].value + 0.35 * list.slice(1).reduce((acc, c) => acc + Math.max(0, c.value), 0);
    if (!bestEdge || value > bestEdge.value) bestEdge = { edge, list, value };
  }
  const candidates = bestEdge ? bestEdge.list : [];
  // a contested corner that out-scores our pick on raw value — say why we passed
  const skipped = scored
    .filter((c) => c.contested && c !== candidates[0] && c.s.score > (candidates[0]?.s.score ?? -Infinity))
    .sort((a, b) => b.s.score - a.s.score)[0];

  if (candidates.length === 0) {
    return {
      phase: "setup",
      heading: "Place your road",
      spots: [],
      roadEdges: [],
      note: "No strong expansion direction — any coastal-facing road is fine.",
    };
  }
  const best = candidates[0];
  return {
    phase: "setup",
    heading: "Place your road here (dashed)",
    spots: candidates.slice(0, 2).map((c, i) => ({
      vertexId: c.s.vertexId,
      rank: i + 1,
      label: `${describeVertex(state, c.s.vertexId)} — ${c.path.length} road${c.path.length > 1 ? "s" : ""} away${c.contested ? " (contested)" : ""}`,
    })),
    roadEdges: [best.path[0]],
    note: skipped
      ? `The dashed edge points toward ①. Skipped ${describeVertex(state, skipped.s.vertexId)}: an opponent is ${skipped.oppDist} road${skipped.oppDist === 1 ? "" : "s"} from it — a race we'd likely lose.`
      : "The dashed edge points toward your best future settlement ①.",
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
