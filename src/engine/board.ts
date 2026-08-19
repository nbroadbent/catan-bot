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

export interface TileSpec {
  q: number;
  r: number;
  kind: TileKind;
  token: number | null;
}

/**
 * Construct board topology (vertices, edges, adjacency) from an explicit tile
 * list — used both by the random generator and by the colonist.io board
 * bridge, which receives real tiles over the wire in the same axial system.
 * Ports are NOT assigned here.
 */
export function buildBoard(seed: number, tiles: TileSpec[]): Board {
  const hexes: Hex[] = tiles.map((t, id) => {
    const { x, y } = hexCenter(t.q, t.r);
    return { id, q: t.q, r: t.r, kind: t.kind, token: t.token, cx: x, cy: y };
  });

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

  return { seed, hexes, vertices, edges };
}

export function generateBoard(seed: number): Board {
  const rand = mulberry32(seed);
  const kinds = shuffle(TILE_POOL, rand);
  const tiles: TileSpec[] = hexCoords().map(({ q, r }, i) => ({
    q,
    r,
    kind: kinds[i],
    token: null,
  }));
  const board = buildBoard(seed, tiles);
  assignTokens(board.hexes, rand);

  // Ports: coastal edges (its two vertices share exactly one hex) ordered by
  // angle around the center, with real-frame-like spacing.
  const coastal = board.edges
    .filter((e) => {
      const shared = board.vertices[e.a].hexIds.filter((h) =>
        board.vertices[e.b].hexIds.includes(h),
      );
      return shared.length === 1;
    })
    .map((e) => {
      const mx = (board.vertices[e.a].x + board.vertices[e.b].x) / 2;
      const my = (board.vertices[e.a].y + board.vertices[e.b].y) / 2;
      return { e, angle: Math.atan2(my, mx) };
    })
    .sort((a, b) => a.angle - b.angle)
    .map((c) => c.e);

  const ports = shuffle(PORT_POOL, rand);
  PORT_SLOT_SPACING.forEach((slot, i) => {
    const e = coastal[slot % coastal.length];
    board.vertices[e.a].port = ports[i];
    board.vertices[e.b].port = ports[i];
  });

  return board;
}

/** Pixel positions of a hex's 6 corners (unit size) — for rendering. */
export function hexCornerPoints(hex: Hex): Array<{ x: number; y: number }> {
  return Array.from({ length: 6 }, (_, i) => hexCorner(hex.cx, hex.cy, i));
}

/**
 * Pixel position of a colonist.io corner coordinate (x, y, z): face (x, y)
 * with z=0 the TOP corner and z=1 the BOTTOM corner (y grows downward).
 */
export function colonistCornerToPixel(c: { x: number; y: number; z: number }): {
  x: number;
  y: number;
} {
  const { x, y } = hexCenter(c.x, c.y);
  return hexCorner(x, y, c.z === 0 ? 5 : 2); // angles 270° (top) / 90° (bottom)
}

/**
 * Pixel positions of the two endpoints of a colonist.io edge coordinate
 * (x, y, z): the face's left edges, z 0..2 from top to bottom.
 */
export function colonistEdgeToPixels(e: { x: number; y: number; z: number }): [
  { x: number; y: number },
  { x: number; y: number },
] {
  const { x, y } = hexCenter(e.x, e.y);
  const i = 5 - e.z;
  return [hexCorner(x, y, i), hexCorner(x, y, i - 1)];
}

/** Find the board vertex nearest to a pixel position (within tolerance). */
export function findVertexAt(board: Board, x: number, y: number): Vertex | null {
  let best: Vertex | null = null;
  let bestD = 0.05;
  for (const v of board.vertices) {
    const d = Math.hypot(v.x - x, v.y - y);
    if (d < bestD) {
      best = v;
      bestD = d;
    }
  }
  return best;
}

export function findEdgeBetween(board: Board, a: number, b: number): Edge | null {
  return (
    board.edges.find(
      (e) => (e.a === a && e.b === b) || (e.a === b && e.b === a),
    ) ?? null
  );
}

/** Total pips a vertex collects across its adjacent hexes. */
export function vertexPips(board: Board, vertexId: number): number {
  return board.vertices[vertexId].hexIds.reduce(
    (sum, hid) => sum + pips(board.hexes[hid].token),
    0,
  );
}
