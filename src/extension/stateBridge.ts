import {
  buildBoard,
  colonistCornerToPixel,
  colonistEdgeToPixels,
  findEdgeBetween,
  findVertexAt,
} from "../engine/board";
import { Board, GameState, PlayerId, RESOURCES, Resource, TileKind } from "../engine/types";

/**
 * Colonist.io's ACTUAL WebSocket protocol (reverse-engineered from a captured
 * game — the earlier event-type guesses were from a different client version).
 *
 *   type 4  = full game init: { playerColor, playerUserStates, gameState }
 *   type 91 = state diff:     { diff, timeLeftInState }   (deep-merge onto state)
 *
 * gameState holds everything we need: currentState (whose turn / phase),
 * diceState (rolled?), mapState (tiles/corners/edges/ports), playerStates
 * (hands, ratios, discard limits), mechanicRobberState (robber tile).
 */
export const STATE_EVENT = { INIT: 4, DIFF: 91 } as const;

const TILE_TYPE: Record<number, TileKind> = {
  0: "desert", 1: "wood", 2: "brick", 3: "sheep", 4: "wheat", 5: "ore",
};
const CARD_ID: Record<number, Resource> = {
  1: "wood", 2: "brick", 3: "sheep", 4: "wheat", 5: "ore",
};
// port type: 1 = generic 3:1; 2..6 = resource 2:1
const PORT_TYPE: Record<number, Resource | "any"> = {
  1: "any", 2: "wood", 3: "brick", 4: "sheep", 5: "wheat", 6: "ore",
};

/** colonist turn phases (currentState.turnState) */
const TURN_ROLL = 1; // "Roll Dice" — dice not yet thrown
const TURN_MAIN = 2; // build / trade

interface CurrentState {
  currentTurnPlayerColor?: number;
  turnState?: number;
  actionState?: number;
}
interface CornerState { x: number; y: number; z: number; owner?: number; buildingType?: number }
interface EdgeState { x: number; y: number; z: number; owner?: number }
interface PortState { x: number; y: number; z: number; type: number }
interface TileState { x: number; y: number; type: number; diceNumber: number }
interface GameStateShape {
  diceState?: { diceThrown?: boolean; dice1?: number; dice2?: number };
  currentState?: CurrentState;
  mapState?: {
    tileHexStates?: Record<string, TileState>;
    tileCornerStates?: Record<string, CornerState>;
    tileEdgeStates?: Record<string, EdgeState>;
    portEdgeStates?: Record<string, PortState>;
  };
  playerStates?: Record<string, {
    color?: number;
    resourceCards?: { cards?: number[] };
    cardDiscardLimit?: number;
    bankTradeRatiosState?: Record<string, number>;
  }>;
  mechanicRobberState?: { locationTileIndex?: number };
}

function deepMerge(target: Record<string, unknown>, src: Record<string, unknown>): void {
  for (const key of Object.keys(src)) {
    const v = src[key];
    const cur = target[key];
    if (
      v && typeof v === "object" && !Array.isArray(v) &&
      cur && typeof cur === "object" && !Array.isArray(cur)
    ) {
      deepMerge(cur as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      target[key] = v; // arrays and primitives replace wholesale
    }
  }
}

export interface WireBuilding { vertexId: number; colorId: number; kind: "settlement" | "city" }
export interface WireRoad { edgeId: number; colorId: number }

export class StateBridge {
  state: GameStateShape = {};
  myColor: number | null = null;
  colorToName = new Map<number, string>();
  colorIsBot = new Map<number, boolean>();
  board: Board | null = null;
  robberHex: { x: number; y: number } | null = null;
  private boardTilesKey = "";

  reset(): void {
    this.state = {};
    this.myColor = null;
    this.colorToName.clear();
    this.colorIsBot.clear();
    this.board = null;
    this.robberHex = null;
    this.boardTilesKey = "";
  }

  /** Feed a decoded frame. Returns true if it advanced game state. */
  apply(type: number, payload: unknown): boolean {
    if (type === STATE_EVENT.INIT) {
      const p = payload as {
        playerColor?: number;
        playerUserStates?: Array<{ username?: string; selectedColor?: number; isBot?: boolean }>;
        gameState?: GameStateShape;
      };
      this.reset();
      if (typeof p?.playerColor === "number") this.myColor = p.playerColor;
      for (const u of p?.playerUserStates ?? []) {
        if (u?.username && typeof u.selectedColor === "number") {
          this.colorToName.set(u.selectedColor, u.username);
          this.colorIsBot.set(u.selectedColor, !!u.isBot);
        }
      }
      this.state = (p?.gameState as GameStateShape) ?? {};
      this.rebuildBoard();
      this.syncRobber();
      return true;
    }
    if (type === STATE_EVENT.DIFF) {
      const diff = (payload as { diff?: GameStateShape })?.diff;
      if (!diff) return false;
      deepMerge(this.state as Record<string, unknown>, diff as Record<string, unknown>);
      if (diff.mapState?.tileHexStates) this.rebuildBoard();
      if (diff.mechanicRobberState || diff.mapState?.tileHexStates) this.syncRobber();
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- turn/roll

  get currentTurnColor(): number | null {
    return this.state.currentState?.currentTurnPlayerColor ?? null;
  }
  get turnState(): number | null {
    return this.state.currentState?.turnState ?? null;
  }
  get diceThrown(): boolean {
    return this.state.diceState?.diceThrown === true;
  }
  get isMyTurn(): boolean {
    return this.myColor !== null && this.currentTurnColor === this.myColor;
  }
  /** My turn, in the roll phase, dice not yet thrown → I must roll now. */
  get needsRoll(): boolean {
    return this.isMyTurn && this.turnState === TURN_ROLL && !this.diceThrown;
  }
  /** My turn, past the roll (build/trade phase). */
  get inMainPhase(): boolean {
    return this.isMyTurn && (this.turnState === TURN_MAIN || this.diceThrown);
  }

  // ---------------------------------------------------------------- board

  private rebuildBoard(): void {
    const tiles = this.state.mapState?.tileHexStates;
    if (!tiles) return;
    const key = Object.values(tiles)
      .map((t) => `${t.x},${t.y},${t.type},${t.diceNumber}`)
      .join("|");
    if (key === this.boardTilesKey && this.board) return;
    this.boardTilesKey = key;

    this.board = buildBoard(
      0,
      Object.values(tiles).map((t) => {
        const kind = TILE_TYPE[t.type] ?? "desert";
        return { q: t.x, r: t.y, kind, token: kind === "desert" || !t.diceNumber ? null : t.diceNumber };
      }),
    );
    for (const pe of Object.values(this.state.mapState?.portEdgeStates ?? {})) {
      const kind = PORT_TYPE[pe.type] ?? "any";
      const port = { kind, ratio: kind === "any" ? 3 : 2 } as const;
      for (const pt of colonistEdgeToPixels(pe)) {
        const v = findVertexAt(this.board, pt.x, pt.y);
        if (v) v.port = { ...port };
      }
    }
  }

  private syncRobber(): void {
    const idx = this.state.mechanicRobberState?.locationTileIndex;
    const tiles = this.state.mapState?.tileHexStates;
    if (idx === undefined || !tiles) return;
    const tile = tiles[String(idx)];
    if (tile) this.robberHex = { x: tile.x, y: tile.y };
  }

  get buildings(): WireBuilding[] {
    if (!this.board) return [];
    const out: WireBuilding[] = [];
    for (const c of Object.values(this.state.mapState?.tileCornerStates ?? {})) {
      if (c.owner === undefined || c.buildingType === undefined) continue;
      const pt = colonistCornerToPixel(c);
      const v = findVertexAt(this.board, pt.x, pt.y);
      if (v) out.push({ vertexId: v.id, colorId: c.owner, kind: c.buildingType === 2 ? "city" : "settlement" });
    }
    return out;
  }

  get roads(): WireRoad[] {
    if (!this.board) return [];
    const out: WireRoad[] = [];
    for (const e of Object.values(this.state.mapState?.tileEdgeStates ?? {})) {
      if (e.owner === undefined) continue;
      const [p1, p2] = colonistEdgeToPixels(e);
      const va = findVertexAt(this.board, p1.x, p1.y);
      const vb = findVertexAt(this.board, p2.x, p2.y);
      if (!va || !vb) continue;
      const edge = findEdgeBetween(this.board, va.id, vb.id);
      if (edge) out.push({ edgeId: edge.id, colorId: e.owner });
    }
    return out;
  }

  // ---------------------------------------------------------------- hands

  /** Exact resource counts for a color; opponents' cards are masked (id 0). */
  handOf(color: number): { total: number; known: Partial<Record<Resource, number>> } {
    const cards = this.state.playerStates?.[String(color)]?.resourceCards?.cards ?? [];
    const known: Partial<Record<Resource, number>> = {};
    for (const id of cards) {
      const r = CARD_ID[id];
      if (r) known[r] = (known[r] ?? 0) + 1;
    }
    return { total: cards.length, known };
  }

  discardLimit(color: number): number | null {
    return this.state.playerStates?.[String(color)]?.cardDiscardLimit ?? null;
  }

  bankRatios(color: number): Partial<Record<Resource, number>> {
    const raw = this.state.playerStates?.[String(color)]?.bankTradeRatiosState ?? {};
    const out: Partial<Record<Resource, number>> = {};
    for (const [id, ratio] of Object.entries(raw)) {
      const r = CARD_ID[Number(id)];
      if (r) out[r] = ratio;
    }
    return out;
  }

  // ---------------------------------------------------------------- engine view

  colorOrder(): number[] {
    return [...this.colorToName.keys()].sort((a, b) => a - b);
  }

  toGameState(): { state: GameState; youPlayer: PlayerId | null } | null {
    if (!this.board) return null;
    const order = this.colorOrder();
    const toPid = (c: number) => Math.min(3, Math.max(0, order.indexOf(c))) as PlayerId;
    const state: GameState = {
      board: this.board,
      buildings: this.buildings.map((b) => ({ vertexId: b.vertexId, player: toPid(b.colorId), kind: b.kind })),
      roads: this.roads.map((r) => ({ edgeId: r.edgeId, player: toPid(r.colorId) })),
    };
    const youPlayer = this.myColor !== null && order.includes(this.myColor) ? toPid(this.myColor) : null;
    return { state, youPlayer };
  }
}

export { RESOURCES };
