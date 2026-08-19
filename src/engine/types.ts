export type Resource = "wood" | "brick" | "sheep" | "wheat" | "ore";
export const RESOURCES: Resource[] = ["wood", "brick", "sheep", "wheat", "ore"];

export type TileKind = Resource | "desert";

export interface Hex {
  id: number;
  /** axial coordinates */
  q: number;
  r: number;
  kind: TileKind;
  /** number token 2..12, or null for desert */
  token: number | null;
  /** pixel-space center (unit hex size), shared with the renderer */
  cx: number;
  cy: number;
}

export interface Vertex {
  id: number;
  x: number;
  y: number;
  /** hexes touching this vertex */
  hexIds: number[];
  /** neighboring vertex ids (connected by an edge) */
  adjacent: number[];
  /** port at this vertex, if any */
  port: Port | null;
}

export interface Edge {
  id: number;
  a: number; // vertex id
  b: number; // vertex id
}

export type PortKind = "any" | Resource;

export interface Port {
  kind: PortKind;
  /** trade ratio: 3 for generic, 2 for resource ports */
  ratio: number;
}

export interface Board {
  seed: number;
  hexes: Hex[];
  vertices: Vertex[];
  edges: Edge[];
}

export type PlayerId = 0 | 1 | 2 | 3;
export const PLAYER_NAMES = ["Red", "Blue", "Orange", "White"];

export interface Building {
  vertexId: number;
  player: PlayerId;
  kind: "settlement" | "city";
}

export interface Road {
  edgeId: number;
  player: PlayerId;
}

export interface GameState {
  board: Board;
  buildings: Building[];
  roads: Road[];
}

export type StrategyId = "road-expand" | "city-dev" | "port-trade" | "balanced";

export interface Strategy {
  id: StrategyId;
  name: string;
  tagline: string;
  /** how much this strategy values each resource */
  weights: Record<Resource, number>;
  /** build priority used by the simulator */
  buildOrder: Array<"road" | "settlement" | "city" | "dev">;
}

/** pips on the number token: how many of the 36 dice combos roll it */
export function pips(token: number | null): number {
  if (token === null) return 0;
  return 6 - Math.abs(7 - token);
}
