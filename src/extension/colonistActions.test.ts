import { describe, expect, it } from "vitest";
import {
  ACTION,
  endTurnAction,
  roadActions,
  robberActions,
  rollAction,
  settlementActions,
} from "./colonistActions";
import { StateBridge } from "./stateBridge";
import slice from "./__fixtures__/capture-slice.json";

const S = slice as {
  init: { type: number; payload: unknown };
  buildDiff: { type: number; payload: unknown };
};

describe("colonist action encoders", () => {
  it("rolls, ends turn with the right action codes", () => {
    expect(rollAction()).toEqual([{ action: ACTION.ROLL, payload: true }]);
    expect(endTurnAction()).toEqual([{ action: ACTION.END_TURN, payload: true }]);
  });

  it("places a settlement as hover, clear, build (matching the client gesture)", () => {
    expect(settlementActions(37)).toEqual([
      { action: ACTION.PRESELECT, payload: 37 },
      { action: ACTION.PRESELECT, payload: null },
      { action: ACTION.BUILD_SETTLEMENT, payload: 37 },
    ]);
  });

  it("places a road at an edge index", () => {
    const acts = roadActions(48);
    expect(acts[acts.length - 1]).toEqual({ action: ACTION.BUILD_ROAD, payload: 48 });
  });

  it("moves the robber and steals from the victim", () => {
    expect(robberActions(7, 3)).toEqual([
      { action: ACTION.MOVE_ROBBER, payload: 7 },
      { action: ACTION.STEAL, payload: 3 },
    ]);
    // no victim (empty tile): move only, no steal
    expect(robberActions(7, null)).toEqual([{ action: ACTION.MOVE_ROBBER, payload: 7 }]);
  });
});

describe("state bridge index resolution (payloads for real actions)", () => {
  it("resolves a corner coord to the same index the state uses", () => {
    const b = new StateBridge();
    b.apply(S.init.type, S.init.payload);
    // pick a real corner from state and round-trip its coord -> index
    const cornerStates = (b as unknown as {
      state: { mapState: { tileCornerStates: Record<string, { x: number; y: number; z: number }> } };
    }).state.mapState.tileCornerStates;
    const [idx, coord] = Object.entries(cornerStates)[10];
    expect(b.cornerIndexForCoord(coord)).toBe(Number(idx));
  });

  it("maps a built settlement's vertex back to its colonist corner index", () => {
    const b = new StateBridge();
    b.apply(S.init.type, S.init.payload);
    b.apply(S.buildDiff.type, S.buildDiff.payload);
    const built = b.buildings[0];
    const idx = b.cornerIndexForVertex(built.vertexId);
    expect(idx).not.toBeNull();
    // the index must point back at a corner the board maps to that vertex
    const coord = (b as unknown as {
      state: { mapState: { tileCornerStates: Record<string, { x: number; y: number; z: number }> } };
    }).state.mapState.tileCornerStates[String(idx)];
    expect(b.cornerIndexForCoord(coord)).toBe(idx);
  });

  it("finds the tile index under an axial hex (robber payload)", () => {
    const b = new StateBridge();
    b.apply(S.init.type, S.init.payload);
    const tiles = (b as unknown as {
      state: { mapState: { tileHexStates: Record<string, { x: number; y: number }> } };
    }).state.mapState.tileHexStates;
    const [idx, t] = Object.entries(tiles)[5];
    expect(b.tileIndexForHex(t.x, t.y)).toBe(Number(idx));
  });
});
