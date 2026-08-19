import { Board, Edge, Hex, Port, TileKind, Vertex, pips } from "./types";

/** Deterministic PRNG so boards are reproducible by seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(arr: T[], rand: () => number): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const TILE_POOL: TileKind[] = [
  "wood", "wood", "wood", "wood",
  "wheat", "wheat", "wheat", "wheat",
  "sheep", "sheep", "sheep", "sheep",
  "brick", "brick", "brick",
  "ore", "ore", "ore",
  "desert",
];

/** Classic token set (18 tokens, desert gets none). */
const TOKEN_POOL = [2, 3, 3, 4, 4, 5, 5, 6, 6, 8, 8, 9, 9, 10, 10, 11, 11, 12];

/** Axial coordinates of the 19 hexes (hexagon of radius 2). */
function hexCoords(): Array<{ q: number; r: number }> {
  const coords: Array<{ q: number; r: number }> = [];
  for (let q = -2; q <= 2; q++) {
    for (let r = -2; r <= 2; r++) {
      if (Math.abs(q + r) <= 2) coords.push({ q, r });
    }
  }
  return coords;
}

const SQRT3 = Math.sqrt(3);

function hexCenter(q: number, r: number): { x: number; y: number } {
  // pointy-top axial -> pixel, unit size
  return { x: SQRT3 * q + (SQRT3 / 2) * r, y: 1.5 * r };
}

function hexCorner(cx: number, cy: number, i: number): { x: number; y: number } {
  const angle = (Math.PI / 180) * (60 * i - 30);
  return { x: cx + Math.cos(angle), y: cy + Math.sin(angle) };
}

function vkey(x: number, y: number): string {
  // `|| 0` normalizes -0 so corners at x≈±1e-16 dedupe to the same key
  const rx = Math.round(x * 100) || 0;
  const ry = Math.round(y * 100) || 0;
  return `${rx},${ry}`;
}

function hexesAdjacent(a: Hex, b: Hex): boolean {
  const dq = a.q - b.q;
  const dr = a.r - b.r;
  return [
    [1, 0], [-1, 0], [0, 1], [0, -1], [1, -1], [-1, 1],
  ].some(([q, r]) => dq === q && dr === r);
}

/**
 * Lay number tokens randomly, rejecting layouts where 6s/8s touch
 * (the classic "no red tokens adjacent" rule).
 */
function assignTokens(hexes: Hex[], rand: () => number): void {
  for (let attempt = 0; attempt < 500; attempt++) {
    const tokens = shuffle(TOKEN_POOL, rand);
    let ti = 0;
    for (const h of hexes) h.token = h.kind === "desert" ? null : tokens[ti++];
    const hot = hexes.filter((h) => h.token === 6 || h.token === 8);
    const clash = hot.some((a) => hot.some((b) => a.id !== b.id && hexesAdjacent(a, b)));
    if (!clash) return;
  }
  // extremely unlikely after 500 tries; keep the last layout
}

/**
 * The 9 port slots live on coastal edges. We order coastal edges by angle
 * around the board center and space ports out roughly like the real frame.
 */
const PORT_SLOT_SPACING = [0, 3, 7, 10, 13, 17, 20, 23, 27];

const PORT_POOL: Port[] = [
  { kind: "any", ratio: 3 },
  { kind: "any", ratio: 3 },
  { kind: "any", ratio: 3 },
  { kind: "any", ratio: 3 },
  { kind: "wood", ratio: 2 },
  { kind: "brick", ratio: 2 },
  { kind: "sheep", ratio: 2 },
  { kind: "wheat", ratio: 2 },
  { kind: "ore", ratio: 2 },
];

export function generateBoard(seed: number): Board {
  const rand = mulberry32(seed);

  const hexes: Hex[] = shuffle(TILE_POOL, rand).map((kind, id) => {
    const { q, r } = hexCoords()[id];
    const { x, y } = hexCenter(q, r);
    return { id, q, r, kind, token: null, cx: x, cy: y };
  });
  assignTokens(hexes, rand);

  // Build vertices by deduping hex corners geometrically.
  const vertexByKey = new Map<string, Vertex>();
  const vertices: Vertex[] = [];
  const cornerIds: number[][] = []; // per hex, its 6 vertex ids in corner order

  for (const h of hexes) {
    const ids: number[] = [];
    for (let i = 0; i < 6; i++) {
      const { x, y } = hexCorner(h.cx, h.cy, i);
      const key = vkey(x, y);
      let v = vertexByKey.get(key);
      if (!v) {
        v = { id: vertices.length, x, y, hexIds: [], adjacent: [], port: null };
        vertexByKey.set(key, v);
        vertices.push(v);
      }
      v.hexIds.push(h.id);
      ids.push(v.id);
    }
    cornerIds.push(ids);
  }

  // Edges: consecutive corners of each hex, deduped.
  const edgeByKey = new Map<string, Edge>();
  const edges: Edge[] = [];
  for (const ids of cornerIds) {
    for (let i = 0; i < 6; i++) {
      const a = ids[i];
      const b = ids[(i + 1) % 6];
      const key = a < b ? `${a}-${b}` : `${b}-${a}`;
      if (!edgeByKey.has(key)) {
        const e = { id: edges.length, a, b };
        edgeByKey.set(key, e);
        edges.push(e);
        vertices[a].adjacent.push(b);
        vertices[b].adjacent.push(a);
      }
    }
  }

  // Ports: coastal edges (border exactly one hex... i.e. appear in only one hex's
  // corner walk) ordered by angle around the center.
  const edgeUseCount = new Map<string, number>();
  for (const ids of cornerIds) {
    for (let i = 0; i < 6; i++) {
      const a = ids[i];
      const b = ids[(i + 1) % 6];
      const key = a < b ? `${a}-${b}` : `${b}-${a}`;
      edgeUseCount.set(key, (edgeUseCount.get(key) ?? 0) + 1);
    }
  }
  const coastal = edges
    .filter((e) => {
      const key = e.a < e.b ? `${e.a}-${e.b}` : `${e.b}-${e.a}`;
      return edgeUseCount.get(key) === 1;
    })
    .map((e) => {
      const mx = (vertices[e.a].x + vertices[e.b].x) / 2;
      const my = (vertices[e.a].y + vertices[e.b].y) / 2;
      return { e, angle: Math.atan2(my, mx) };
    })
    .sort((a, b) => a.angle - b.angle)
    .map((c) => c.e);

  const ports = shuffle(PORT_POOL, rand);
  PORT_SLOT_SPACING.forEach((slot, i) => {
    const e = coastal[slot % coastal.length];
    vertices[e.a].port = ports[i];
    vertices[e.b].port = ports[i];
  });

  return { seed, hexes, vertices, edges };
}

/** Total pips a vertex collects across its adjacent hexes. */
export function vertexPips(board: Board, vertexId: number): number {
  return board.vertices[vertexId].hexIds.reduce(
    (sum, hid) => sum + pips(board.hexes[hid].token),
    0,
  );
}
