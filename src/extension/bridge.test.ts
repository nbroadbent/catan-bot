// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { decode } from "./msgpack";
import { BoardBridge, WS_EVENT } from "./boardBridge";
import { advisePlacement, roadPathTo, renderMiniMap } from "./placement";
import { generateBoard } from "../engine/board";
import { isVertexBuildable } from "../engine/analysis";

describe("msgpack decoder", () => {
  it("decodes fix types", () => {
    // {"a": 5, "b": [-1, true, null, "hi"]}
    const bytes = new Uint8Array([
      0x82, 0xa1, 0x61, 0x05, 0xa1, 0x62, 0x94, 0xff, 0xc3, 0xc0, 0xa2, 0x68, 0x69,
    ]);
    expect(decode(bytes)).toEqual({ a: 5, b: [-1, true, null, "hi"] });
  });

  it("decodes sized ints, floats and strings", () => {
    // [uint8 200, int16 -1000, float64 1.5, str8 "abc"]
    const bytes = new Uint8Array([
      0x94,
      0xcc, 200,
      0xd1, 0xfc, 0x18,
      0xcb, 0x3f, 0xf8, 0, 0, 0, 0, 0, 0,
      0xd9, 3, 0x61, 0x62, 0x63,
    ]);
    expect(decode(bytes)).toEqual([200, -1000, 1.5, "abc"]);
  });

  it("decodes nested colonist-style frames", () => {
    // {"id": 130, "data": {"type": 14, "payload": {"n": 8}}}
    const bytes = new Uint8Array([
      0x82,
      0xa2, 0x69, 0x64, 0xcc, 130,
      0xa4, 0x64, 0x61, 0x74, 0x61,
      0x82,
      0xa4, 0x74, 0x79, 0x70, 0x65, 14,
      0xa7, 0x70, 0x61, 0x79, 0x6c, 0x6f, 0x61, 0x64,
      0x81, 0xa1, 0x6e, 8,
    ]);
    expect(decode(bytes)).toEqual({ id: 130, data: { type: 14, payload: { n: 8 } } });
  });
});

/**
 * Build a colonist-style board payload from an engine-generated board so the
 * bridge's coordinate mapping is exercised against known topology.
 */
function colonistBoardPayload(seed = 42) {
  const ref = generateBoard(seed);
  const KIND_TO_TILE_TYPE: Record<string, number> = {
    desert: 0, wood: 1, brick: 2, sheep: 3, wheat: 4, ore: 5,
  };
  return {
    ref,
    payload: {
      tileState: {
        tiles: ref.hexes.map((h) => ({
          hexFace: { x: h.q, y: h.r },
          tileType: KIND_TO_TILE_TYPE[h.kind],
          _diceNumber: h.token ?? 0,
        })),
      },
      portState: { portEdges: [] },
    },
  };
}

describe("boardBridge", () => {
  it("rebuilds the board with identical topology from wire tiles", () => {
    const { ref, payload } = colonistBoardPayload();
    const bridge = new BoardBridge();
    bridge.handle(WS_EVENT.BOARD_DESCRIPTION, payload);
    expect(bridge.board).not.toBeNull();
    expect(bridge.board!.hexes).toHaveLength(19);
    expect(bridge.board!.vertices).toHaveLength(54);
    expect(bridge.board!.edges).toHaveLength(72);
    for (let i = 0; i < 19; i++) {
      expect(bridge.board!.hexes[i].kind).toBe(ref.hexes[i].kind);
      expect(bridge.board!.hexes[i].token).toBe(ref.hexes[i].token);
    }
  });

  it("maps corner and edge builds onto the right vertices", () => {
    const { payload } = colonistBoardPayload();
    const bridge = new BoardBridge();
    bridge.handle(WS_EVENT.BOARD_DESCRIPTION, payload);

    // corner (0,0,0) = top corner of the center hex
    bridge.handle(WS_EVENT.BUILD_CORNER, [
      { hexCorner: { x: 0, y: 0, z: 0 }, owner: 2, buildingType: 1 },
    ]);
    expect(bridge.buildings).toHaveLength(1);
    const v = bridge.board!.vertices[bridge.buildings[0].vertexId];
    // top corner of center hex sits at (0, -1) in unit space
    expect(Math.abs(v.x)).toBeLessThan(0.01);
    expect(Math.abs(v.y + 1)).toBeLessThan(0.01);

    // upgrading the same corner to a city replaces, not duplicates
    bridge.handle(WS_EVENT.BUILD_CORNER, [
      { hexCorner: { x: 0, y: 0, z: 0 }, owner: 2, buildingType: 2 },
    ]);
    expect(bridge.buildings).toHaveLength(1);
    expect(bridge.buildings[0].kind).toBe("city");

    // edge z=0 on center hex touches that same top corner
    bridge.handle(WS_EVENT.BUILD_EDGE, [{ hexEdge: { x: 0, y: 0, z: 0 }, owner: 2 }]);
    expect(bridge.roads).toHaveLength(1);
    const e = bridge.board!.edges[bridge.roads[0].edgeId];
    expect([e.a, e.b]).toContain(bridge.buildings[0].vertexId);
  });

  it("assigns ports from port edges", () => {
    const { payload } = colonistBoardPayload();
    // attach a 2:1 ore port to a coastal edge of the top-left hex
    (payload.portState.portEdges as unknown[]).push({
      hexEdge: { x: 0, y: -2, z: 0 },
      portType: 6,
    });
    const bridge = new BoardBridge();
    bridge.handle(WS_EVENT.BOARD_DESCRIPTION, payload);
    const portVerts = bridge.board!.vertices.filter((v) => v.port?.kind === "ore");
    expect(portVerts).toHaveLength(2);
    expect(portVerts[0].port!.ratio).toBe(2);
  });

  it("produces a GameState with you-mapping", () => {
    const { payload } = colonistBoardPayload();
    const bridge = new BoardBridge();
    bridge.handle(WS_EVENT.GAME_START, {});
    bridge.handle(WS_EVENT.BOARD_DESCRIPTION, payload);
    bridge.handle(WS_EVENT.PLAY_ORDER, { myColor: 3 });
    bridge.handle(WS_EVENT.PLAYER_STATE, [
      { username: "LadyboyNick", color: 3 },
      { username: "Padegs6907", color: 1 },
    ]);
    bridge.handle(WS_EVENT.BUILD_CORNER, [
      { hexCorner: { x: 0, y: 0, z: 0 }, owner: 3, buildingType: 1 },
    ]);
    const gs = bridge.toGameState()!;
    expect(gs.youPlayer).not.toBeNull();
    expect(gs.state.buildings).toHaveLength(1);
    expect(gs.state.buildings[0].player).toBe(gs.youPlayer);
  });
});

describe("placement advice", () => {
  function bridgeWithBoard() {
    const { payload } = colonistBoardPayload();
    const bridge = new BoardBridge();
    bridge.handle(WS_EVENT.BOARD_DESCRIPTION, payload);
    bridge.handle(WS_EVENT.PLAY_ORDER, { myColor: 2 });
    bridge.handle(WS_EVENT.PLAYER_STATE, [{ username: "Nick", color: 2 }]);
    return bridge;
  }

  it("recommends 3 legal spots for the first settlement", () => {
    const bridge = bridgeWithBoard();
    const gs = bridge.toGameState()!;
    const advice = advisePlacement(gs.state, gs.youPlayer)!;
    expect(advice.phase).toBe("setup");
    expect(advice.heading).toContain("1st settlement");
    expect(advice.spots).toHaveLength(3);
    for (const s of advice.spots) {
      expect(isVertexBuildable(gs.state, s.vertexId)).toBe(true);
      expect(s.label).toMatch(/\d+ pips/);
    }
  });

  it("biases the 2nd settlement toward uncovered resources", () => {
    const bridge = bridgeWithBoard();
    let gs = bridge.toGameState()!;
    const first = advisePlacement(gs.state, gs.youPlayer)!.spots[0];
    bridge.buildings.push({ vertexId: first.vertexId, colorId: 2, kind: "settlement" });
    gs = bridge.toGameState()!;
    const advice = advisePlacement(gs.state, gs.youPlayer)!;
    expect(advice.heading).toContain("2nd settlement");
    expect(advice.spots.length).toBeGreaterThan(0);
    // the top pick must respect the distance rule vs the first settlement
    for (const s of advice.spots) {
      expect(isVertexBuildable(gs.state, s.vertexId)).toBe(true);
    }
  });

  it("finds a road path to expansion targets in the main game", () => {
    const bridge = bridgeWithBoard();
    let gs = bridge.toGameState()!;
    const spots = advisePlacement(gs.state, gs.youPlayer)!.spots;
    bridge.buildings.push({ vertexId: spots[0].vertexId, colorId: 2, kind: "settlement" });
    bridge.buildings.push({ vertexId: spots[1].vertexId, colorId: 2, kind: "settlement" });
    // opponent buildings to make it a real mid-game
    bridge.buildings.push({ vertexId: spots[2].vertexId, colorId: 1, kind: "settlement" });
    gs = bridge.toGameState()!;
    const advice = advisePlacement(gs.state, gs.youPlayer)!;
    expect(advice.phase).toBe("main");
    if (advice.spots.length > 0) {
      const path = roadPathTo(gs.state, gs.youPlayer!, advice.spots[0].vertexId);
      expect(path.length).toBeGreaterThan(0);
    }
  });

  it("renders a minimap with badges, tiles and numbers", () => {
    const bridge = bridgeWithBoard();
    const gs = bridge.toGameState()!;
    const advice = advisePlacement(gs.state, gs.youPlayer)!;
    const svg = renderMiniMap(gs.state, {
      spots: advice.spots,
      roadEdges: [],
      buildings: [],
      roads: [],
    });
    expect(svg).toContain("<svg");
    expect((svg.match(/<polygon/g) ?? []).length).toBe(19);
    expect((svg.match(/var\(--gold/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(svg).toContain(">8<"); // a number token rendered
  });
});
