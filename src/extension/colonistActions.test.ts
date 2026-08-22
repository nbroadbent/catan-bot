import { describe, expect, it } from "vitest";
import {
  ACTION,
  DEV_CARD,
  bankTradeActions,
  knightActions,
  monopolyActions,
  buildCityActions,
  buildRoadActions,
  buildSettlementActions,
  buyDevAction,
  discardActions,
  endTurnAction,
  roadActions,
  roadBuildingActions,
  tradeResponseActions,
  robberActions,
  rollAction,
  settlementActions,
  yearOfPlentyActions,
} from "./colonistActions";
import { StateBridge } from "./stateBridge";
import slice from "./__fixtures__/capture-slice.json";

const S = slice as {
  init: { type: number; payload: unknown };
  buildDiff: { type: number; payload: unknown };
};

describe("colonist action encoders", () => {
  it("rolls, ends turn, buys a dev card with the right action codes", () => {
    expect(rollAction()).toEqual([{ action: ACTION.ROLL, payload: true }]);
    expect(endTurnAction()).toEqual([{ action: ACTION.END_TURN, payload: true }]);
    // buy dev = action 9, verified against every one of my captured purchases
    expect(buyDevAction()).toEqual([{ action: 9, payload: true }]);
  });

  it("places a SETUP settlement as hover, clear, build (matching the client gesture)", () => {
    expect(settlementActions(37)).toEqual([
      { action: ACTION.PRESELECT, payload: 37 },
      { action: ACTION.PRESELECT, payload: null },
      { action: ACTION.BUILD_SETTLEMENT, payload: 37 },
    ]);
  });

  it("builds a MAIN-GAME settlement with the intent step first (action 14 then 15)", () => {
    // verified byte-exact against the captured mid-game build (seq 116-117)
    expect(buildSettlementActions(52)).toEqual([
      { action: 14, payload: true },
      { action: ACTION.BUILD_SETTLEMENT, payload: 52 },
    ]);
  });

  it("places a SETUP road at an edge index", () => {
    const acts = roadActions(48);
    expect(acts[acts.length - 1]).toEqual({ action: ACTION.BUILD_ROAD, payload: 48 });
  });

  it("builds a MAIN-GAME road with the intent step (action 10 then 11)", () => {
    expect(buildRoadActions(36)).toEqual([
      { action: 10, payload: true },
      { action: ACTION.BUILD_ROAD, payload: 36 },
    ]);
  });

  it("builds a city with intent then place (action 17 then 18), byte-verified", () => {
    expect(buildCityActions(47)).toEqual([
      { action: 17, payload: true },
      { action: ACTION.BUILD_CITY, payload: 47 },
    ]);
  });

  it("discards by selecting each card cumulatively, then confirming", () => {
    // matches the captured discard of [3,5,1,3] (seq 6-13), verified byte-exact
    expect(discardActions([3, 5, 1, 3])).toEqual([
      { action: ACTION.DISCARD_SELECT, payload: [3] },
      { action: ACTION.DISCARD_SELECT, payload: [3, 5] },
      { action: ACTION.DISCARD_SELECT, payload: [3, 5, 1] },
      { action: ACTION.DISCARD_SELECT, payload: [3, 5, 1, 3] },
      { action: ACTION.DISCARD_CONFIRM, payload: [3, 5, 1, 3] },
    ]);
    expect(discardActions([])).toEqual([]);
  });

  it("plays a knight by playing dev card 11 (then the robber flow follows)", () => {
    // card 11 = knight, confirmed from a capture (played 6x, id logged each time)
    expect(knightActions()).toEqual([{ action: ACTION.PLAY_DEV, payload: DEV_CARD.KNIGHT }]);
    expect(DEV_CARD.KNIGHT).toBe(11);
  });

  it("plays a monopoly: play card 13, select then confirm the resource", () => {
    // verified byte-exact against the capture (seq 15-16 for ore, seq 19-20 for wood)
    expect(monopolyActions(5)).toEqual([
      { action: ACTION.PLAY_DEV, payload: DEV_CARD.MONOPOLY }, // 48, 13
      { action: ACTION.DISCARD_SELECT, payload: [5] }, // 8, [ore]
      { action: ACTION.DISCARD_CONFIRM, payload: [5] }, // 7, [ore]
    ]);
  });

  it("plays road building by playing dev card 14 (free roads follow)", () => {
    // card 14 = road building, confirmed from a capture: play 14 -> free-road
    // placement states (30/31) -> two roads with no bank cost
    expect(roadBuildingActions()).toEqual([
      { action: ACTION.PLAY_DEV, payload: DEV_CARD.ROAD_BUILDING },
    ]);
    expect(DEV_CARD.ROAD_BUILDING).toBe(14);
  });

  it("plays year of plenty: play card 15, cumulative select, confirm both", () => {
    // id 15 by elimination (11 knight, 12 VP, 13 monopoly, 14 road building);
    // the pick dialog mirrors the discard/monopoly select->confirm pattern
    expect(yearOfPlentyActions([5, 4])).toEqual([
      { action: ACTION.PLAY_DEV, payload: DEV_CARD.YEAR_OF_PLENTY }, // 48, 15
      { action: ACTION.DISCARD_SELECT, payload: [5] }, // 8, [ore]
      { action: ACTION.DISCARD_SELECT, payload: [5, 4] }, // 8, [ore, wheat]
      { action: ACTION.DISCARD_CONFIRM, payload: [5, 4] }, // 7, [ore, wheat]
    ]);
  });

  it("answers a trade offer with action 50 {id, response}: accept = 0, decline = 1", () => {
    // captured live: clicking accept on offer "mZyt" sent {action:50,payload:{id:"mZyt",response:0}}
    expect(tradeResponseActions("mZyt", true)).toEqual([{ action: 50, payload: { id: "mZyt", response: 0 } }]);
    expect(tradeResponseActions("mZyt", false)).toEqual([{ action: 50, payload: { id: "mZyt", response: 1 } }]);
  });

  it("builds a bank trade matching the captured format", () => {
    // real captured trade: give 3 ore (id 5) for 1 wood (id 1)
    expect(bankTradeActions(1, 5, 3, 1)).toEqual([
      {
        action: ACTION.CREATE_TRADE,
        payload: {
          creator: 1,
          isBankTrade: true,
          counterOfferInResponseToTradeId: null,
          offeredResources: [5, 5, 5],
          wantedResources: [1],
        },
      },
    ]);
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
