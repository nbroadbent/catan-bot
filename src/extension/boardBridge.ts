import {
  buildBoard,
  colonistCornerToPixel,
  colonistEdgeToPixels,
  findEdgeBetween,
  findVertexAt,
} from "../engine/board";
import { Board, GameState, PlayerId, Resource, TileKind } from "../engine/types";

/** colonist.io wire enums (from open-source replay tooling — see README) */
const TILE_TYPE: Record<number, TileKind> = {
  0: "desert",
  1: "wood",
  2: "brick",
  3: "sheep",
  4: "wheat",
  5: "ore",
};

const PORT_TYPE: Record<number, Resource | "any"> = {
  1: "any",
  2: "wood",
  3: "brick",
  4: "sheep",
  5: "wheat",
  6: "ore",
};

/** WebSocket event type ids */
export const WS_EVENT = {
  GAME_START: 1,
  PLAY_ORDER: 8,
  PLAYER_STATE: 12,
  BOARD_DESCRIPTION: 14,
  BUILD_EDGE: 15,
  BUILD_CORNER: 16,
  GAME_END: 45,
} as const;

interface XY {
  x: number;
  y: number;
}
interface XYZ extends XY {
  z: number;
}

export interface WsBuilding {
  vertexId: number;
  colorId: number;
  kind: "settlement" | "city";
}

export interface WsRoad {
  edgeId: number;
  colorId: number;
}

/**
 * Folds colonist WebSocket events into an engine Board + buildings/roads.
 * Color ids are colonist's server-side player colors; myColor identifies the
 * signed-in user.
 */
export class BoardBridge {
  board: Board | null = null;
  buildings: WsBuilding[] = [];
  roads: WsRoad[] = [];
  myColor: number | null = null;
  colorToName = new Map<number, string>();

  reset(): void {
    this.board = null;
    this.buildings = [];
    this.roads = [];
    this.myColor = null;
    this.colorToName.clear();
  }

  handle(type: number, payload: unknown): boolean {
    switch (type) {
      case WS_EVENT.GAME_START:
        this.reset();
        return true;
      case WS_EVENT.GAME_END:
        return false;
      case WS_EVENT.PLAY_ORDER: {
        const p = payload as { myColor?: number };
        if (typeof p?.myColor === "number") this.myColor = p.myColor;
        return true;
      }
      case WS_EVENT.PLAYER_STATE: {
        const players = payload as Array<{ username?: string; color?: number }>;
        if (Array.isArray(players)) {
          for (const pl of players) {
            if (pl?.username && typeof pl.color === "number") {
              this.colorToName.set(pl.color, pl.username);
            }
          }
        }
        return true;
      }
      case WS_EVENT.BOARD_DESCRIPTION:
        this.loadBoard(payload);
        return true;
      case WS_EVENT.BUILD_CORNER:
        this.buildCorner(payload);
        return true;
      case WS_EVENT.BUILD_EDGE:
        this.buildEdge(payload);
        return true;
      default:
        return false;
    }
  }

  private loadBoard(payload: unknown): void {
    const p = payload as {
      tileState?: { tiles?: Array<{ hexFace: XY; tileType: number; _diceNumber?: number }> };
      portState?: { portEdges?: Array<{ hexEdge: XYZ; portType: number }> };
    };
    const tiles = p?.tileState?.tiles;
    if (!Array.isArray(tiles) || tiles.length === 0) return;

    this.board = buildBoard(
      0,
      tiles.map((t) => {
        const kind = TILE_TYPE[t.tileType] ?? "desert";
        const token = kind === "desert" || !t._diceNumber ? null : t._diceNumber;
        return { q: t.hexFace.x, r: t.hexFace.y, kind, token };
      }),
    );

    for (const pe of p?.portState?.portEdges ?? []) {
      const kind = PORT_TYPE[pe.portType] ?? "any";
      const port = { kind, ratio: kind === "any" ? 3 : 2 } as const;
      for (const pt of colonistEdgeToPixels(pe.hexEdge)) {
        const v = findVertexAt(this.board, pt.x, pt.y);
        if (v) v.port = { ...port };
      }
    }
    // rebuilding a board invalidates old ids; replay any recorded builds
    const oldBuildings = this.buildings;
    const oldRoads = this.roads;
    this.buildings = oldBuildings.filter((b) => b.vertexId < this.board!.vertices.length);
    this.roads = oldRoads.filter((r) => r.edgeId < this.board!.edges.length);
  }

  private buildCorner(payload: unknown): void {
    if (!this.board) return;
    const item = (Array.isArray(payload) ? payload[0] : payload) as {
      hexCorner?: XYZ;
      owner?: number;
      buildingType?: number;
    };
    if (!item?.hexCorner || typeof item.owner !== "number") return;
    const pt = colonistCornerToPixel(item.hexCorner);
    const v = findVertexAt(this.board, pt.x, pt.y);
    if (!v) return;
    const kind = item.buildingType === 2 ? "city" : "settlement";
    const existing = this.buildings.find((b) => b.vertexId === v.id);
    if (existing) {
      existing.kind = kind;
      existing.colorId = item.owner;
    } else {
      this.buildings.push({ vertexId: v.id, colorId: item.owner, kind });
    }
  }

  private buildEdge(payload: unknown): void {
    if (!this.board) return;
    const item = (Array.isArray(payload) ? payload[0] : payload) as {
      hexEdge?: XYZ;
      owner?: number;
    };
    if (!item?.hexEdge || typeof item.owner !== "number") return;
    const [p1, p2] = colonistEdgeToPixels(item.hexEdge);
    const va = findVertexAt(this.board, p1.x, p1.y);
    const vb = findVertexAt(this.board, p2.x, p2.y);
    if (!va || !vb) return;
    const edge = findEdgeBetween(this.board, va.id, vb.id);
    if (edge && !this.roads.some((r) => r.edgeId === edge.id)) {
      this.roads.push({ edgeId: edge.id, colorId: item.owner });
    }
  }

  /** Distinct color ids in stable order — index becomes engine PlayerId. */
  colorOrder(): number[] {
    const colors = new Set<number>();
    for (const b of this.buildings) colors.add(b.colorId);
    for (const r of this.roads) colors.add(r.colorId);
    if (this.myColor !== null) colors.add(this.myColor);
    for (const c of this.colorToName.keys()) colors.add(c);
    return [...colors].sort((a, b) => a - b);
  }

  /** Engine GameState for the strategy/placement advisor, or null. */
  toGameState(): { state: GameState; youPlayer: PlayerId | null } | null {
    if (!this.board) return null;
    const order = this.colorOrder();
    const toPid = (c: number) => Math.min(3, Math.max(0, order.indexOf(c))) as PlayerId;
    const state: GameState = {
      board: this.board,
      buildings: this.buildings.map((b) => ({
        vertexId: b.vertexId,
        player: toPid(b.colorId),
        kind: b.kind,
      })),
      roads: this.roads.map((r) => ({ edgeId: r.edgeId, player: toPid(r.colorId) })),
    };
    const youPlayer =
      this.myColor !== null && order.includes(this.myColor) ? toPid(this.myColor) : null;
    return { state, youPlayer };
  }
}
