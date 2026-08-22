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
export const STATE_EVENT = { GAME_META: 1, INIT: 4, DIFF: 91 } as const;

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
    victoryPointsState?: Record<string, number>;
  }>;
  tradeState?: {
    activeOffers?: Record<
      string,
      {
        id?: string;
        creator?: number;
        offeredResources?: number[];
        wantedResources?: number[];
        playerResponses?: Record<string, number>;
      } | null
    >;
  };
  mechanicRobberState?: { locationTileIndex?: number };
  mechanicLongestRoadState?: Record<string, { longestRoad?: number }>;
  mechanicDevelopmentCardsState?: {
    bankDevelopmentCards?: { cards?: number[] };
    players?: Record<string, { developmentCards?: { cards?: number[] } }>;
  };
  mechanicSettlementState?: Record<string, { bankSettlementAmount?: number }>;
  mechanicCityState?: Record<string, { bankCityAmount?: number }>;
  mechanicRoadState?: Record<string, { bankRoadAmount?: number }>;
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
  /** colonist send-channel id (serverId), needed to build outbound frames */
  serverId: string | null = null;
  /** friendly robber: can't rob a player with < 3 public VP */
  friendlyRobber = false;
  /** colonist gameSettings.modeSetting (0 = normal turns; Rush uses another value) */
  modeSetting: number | null = null;
  private winTargetValue: number | null = null;
  private boardTilesKey = "";
  /** engine vertex id -> colonist corner index, and edge id -> edge index */
  private vertexToCorner = new Map<number, number>();
  private edgeToIndex = new Map<number, number>();

  reset(): void {
    this.state = {};
    this.myColor = null;
    this.colorToName.clear();
    this.colorIsBot.clear();
    this.board = null;
    this.robberHex = null;
    this.friendlyRobber = false;
    this.modeSetting = null;
    this.winTargetValue = null;
    this.boardTilesKey = "";
    this.vertexToCorner.clear();
    this.edgeToIndex.clear();
  }

  /** Feed a decoded frame. Returns true if it advanced game state. */
  apply(type: number, payload: unknown): boolean {
    if (type === STATE_EVENT.GAME_META) {
      const id = (payload as { serverId?: string })?.serverId;
      if (id) this.serverId = id;
      return false;
    }
    if (type === STATE_EVENT.INIT) {
      const p = payload as {
        playerColor?: number;
        playerUserStates?: Array<{ username?: string; selectedColor?: number; isBot?: boolean }>;
        gameSettings?: { friendlyRobber?: boolean; modeSetting?: number; victoryPointsToWin?: number };
        gameState?: GameStateShape;
      };
      this.reset();
      if (typeof p?.playerColor === "number") this.myColor = p.playerColor;
      this.friendlyRobber = p?.gameSettings?.friendlyRobber === true;
      this.modeSetting =
        typeof p?.gameSettings?.modeSetting === "number" ? p.gameSettings.modeSetting : null;
      if (typeof p?.gameSettings?.victoryPointsToWin === "number")
        this.winTargetValue = p.gameSettings.victoryPointsToWin;
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
  /** dev cards left in the bank, or null if the state hasn't shown them yet */
  get bankDevCards(): number | null {
    const cards = this.state.mechanicDevelopmentCardsState?.bankDevelopmentCards?.cards;
    return Array.isArray(cards) ? cards.length : null;
  }

  /** a player's total public victory points (sum of victoryPointsState). */
  /**
   * Public victory points from colonist's victoryPointsState breakdown. The
   * keys are VP SOURCES whose values are NOT uniformly points (decoded from
   * captures): buildings and VP dev cards store points directly, but Longest
   * Road and Largest Army are stored as a flag of 1 and are each worth 2 VP —
   * summing raw undercounts a bonus holder by 1.
   *   0 = settlements (count, 1 VP each)   1 = cities (count, 2 VP each —
   *       a settlement leaves key 0 when it's upgraded: {"0":1,"1":1} = 3 VP)
   *   2 = Longest Road (flag → 2)          3 = Largest Army (flag → 2)
   *   4 = victory-point dev cards (points)
   * Verified against a real 15-9 game that the old "+1 per city" weighting
   * reported as 11-6 (4 and 2 cities under-counted by one each).
   */
  publicVp(color: number): number {
    const vp = this.state.playerStates?.[String(color)]?.victoryPointsState;
    if (!vp) return 0;
    let total = 0;
    for (const [k, n] of Object.entries(vp)) {
      const v = (n as number) ?? 0;
      if (k === "1") total += v * 2;
      else if (k === "2" || k === "3") total += v > 0 ? 2 : 0;
      else total += v;
    }
    return total;
  }

  /** our own dev-card type ids (playable ones we hold), e.g. 13 = monopoly */
  myDevCardIds(): number[] {
    if (this.myColor === null) return [];
    const cards =
      this.state.mechanicDevelopmentCardsState?.players?.[String(this.myColor)]?.developmentCards?.cards;
    return Array.isArray(cards) ? cards.slice() : [];
  }

  /** Building pieces still in a player's supply (null = state not seen yet). */
  piecesLeft(color: number): { settlements: number | null; cities: number | null; roads: number | null } {
    const key = String(color);
    return {
      settlements: this.state.mechanicSettlementState?.[key]?.bankSettlementAmount ?? null,
      cities: this.state.mechanicCityState?.[key]?.bankCityAmount ?? null,
      roads: this.state.mechanicRoadState?.[key]?.bankRoadAmount ?? null,
    };
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

    // Reverse maps: colonist addresses builds by corner/edge INDEX, so record
    // which board vertex/edge each index refers to. These are the payloads for
    // the settlement (action 15) and road (action 11) messages.
    this.vertexToCorner.clear();
    this.edgeToIndex.clear();
    for (const [idx, c] of Object.entries(this.state.mapState?.tileCornerStates ?? {})) {
      const pt = colonistCornerToPixel(c);
      const v = findVertexAt(this.board, pt.x, pt.y);
      if (v) this.vertexToCorner.set(v.id, Number(idx));
    }
    for (const [idx, e] of Object.entries(this.state.mapState?.tileEdgeStates ?? {})) {
      const [p1, p2] = colonistEdgeToPixels(e);
      const va = findVertexAt(this.board, p1.x, p1.y);
      const vb = findVertexAt(this.board, p2.x, p2.y);
      if (!va || !vb) continue;
      const edge = findEdgeBetween(this.board, va.id, vb.id);
      if (edge) this.edgeToIndex.set(edge.id, Number(idx));
    }
  }

  /** colonist corner index for an engine vertex (settlement/city payload). */
  cornerIndexForVertex(vertexId: number): number | null {
    return this.vertexToCorner.get(vertexId) ?? null;
  }
  /** colonist edge index for an engine edge (road payload). */
  edgeIndexForEdge(edgeId: number): number | null {
    return this.edgeToIndex.get(edgeId) ?? null;
  }
  /** colonist tile (hex) index at axial q,r (robber payload). */
  tileIndexForHex(q: number, r: number): number | null {
    for (const [idx, t] of Object.entries(this.state.mapState?.tileHexStates ?? {})) {
      if (t.x === q && t.y === r) return Number(idx);
    }
    return null;
  }

  /** corner index whose stored {x,y,z} equals the given colonist coord. */
  cornerIndexForCoord(c: { x: number; y: number; z?: number }): number | null {
    for (const [idx, s] of Object.entries(this.state.mapState?.tileCornerStates ?? {})) {
      if (s.x === c.x && s.y === c.y && s.z === (c.z ?? s.z)) return Number(idx);
    }
    return null;
  }
  /** edge index whose stored {x,y,z} equals the given colonist coord. */
  edgeIndexForCoord(c: { x: number; y: number; z?: number }): number | null {
    for (const [idx, s] of Object.entries(this.state.mapState?.tileEdgeStates ?? {})) {
      if (s.x === c.x && s.y === c.y && s.z === (c.z ?? s.z)) return Number(idx);
    }
    return null;
  }

  /** Opponent colors with a building on the given tile index, richest first. */
  opponentsOnTile(tileIndex: number): number[] {
    if (!this.board) return [];
    const tile = this.state.mapState?.tileHexStates?.[String(tileIndex)];
    if (!tile) return [];
    const hex = this.board.hexes.find((h) => h.q === tile.x && h.r === tile.y);
    if (!hex) return [];
    return this.buildings
      .filter(
        (b) => b.colorId !== this.myColor && this.board!.vertices[b.vertexId].hexIds.includes(hex.id),
      )
      .sort((a, b) => this.handOf(b.colorId).total - this.handOf(a.colorId).total)
      .map((b) => b.colorId);
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

  /**
   * Player-trade offers awaiting OUR answer: offers from other players we
   * haven't responded to yet (playerResponses[me] 0/absent). Closed offers
   * arrive as null and are skipped. Responses: 1 = accepted, 2 = declined.
   */
  pendingTradeOffers(): Array<{
    id: string;
    creator: number;
    offered: Partial<Record<Resource, number>>;
    wanted: Partial<Record<Resource, number>>;
  }> {
    if (this.myColor === null) return [];
    const out: Array<{ id: string; creator: number; offered: Partial<Record<Resource, number>>; wanted: Partial<Record<Resource, number>> }> = [];
    const count = (ids: number[] | undefined) => {
      const m: Partial<Record<Resource, number>> = {};
      for (const id of ids ?? []) {
        const r = CARD_ID[id];
        if (r) m[r] = (m[r] ?? 0) + 1;
      }
      return m;
    };
    for (const [id, o] of Object.entries(this.state.tradeState?.activeOffers ?? {})) {
      if (!o || typeof o.creator !== "number" || o.creator === this.myColor) continue;
      if ((o.playerResponses?.[String(this.myColor)] ?? 0) !== 0) continue;
      out.push({ id, creator: o.creator, offered: count(o.offeredResources), wanted: count(o.wantedResources) });
    }
    return out;
  }

  /** a player's longest continuous road (segments), 0 if unseen. */
  longestRoad(color: number): number {
    return this.state.mechanicLongestRoadState?.[String(color)]?.longestRoad ?? 0;
  }

  /** victory points needed to win (colonist default 10; some modes 15). */
  get winTarget(): number {
    return this.winTargetValue ?? 10;
  }

  /** Our own active trade offer (id + who has accepted), or null. */
  myOpenOffer(): { id: string; acceptedBy: number[] } | null {
    if (this.myColor === null) return null;
    for (const [id, o] of Object.entries(this.state.tradeState?.activeOffers ?? {})) {
      if (!o || o.creator !== this.myColor) continue;
      const acceptedBy = Object.entries(o.playerResponses ?? {}).filter(([, v]) => v === 1).map(([c]) => Number(c));
      return { id, acceptedBy };
    }
    return null;
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
