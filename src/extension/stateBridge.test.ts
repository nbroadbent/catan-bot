import { describe, expect, it } from "vitest";
import { StateBridge } from "./stateBridge";
import { advisePlacement } from "./placement";
import { isVertexBuildable } from "../engine/analysis";
import slice from "./__fixtures__/capture-slice.json";

/**
 * These frames are a real slice of a captured colonist.io game (type 4 init +
 * type 91 diffs), so the bridge is validated against the actual wire format.
 */
const S = slice as {
  init: { type: number; payload: unknown };
  buildDiff: { type: number; payload: unknown };
  myTurnRoll: { type: number; payload: unknown };
  handDiff: { type: number; payload: unknown };
};

describe("StateBridge (real capture)", () => {
  it("parses the init: my color, roster, and a standard board", () => {
    const b = new StateBridge();
    b.apply(S.init.type, S.init.payload);
    expect(b.myColor).toBe(1); // playerColor
    expect(b.colorToName.get(1)).toBe("LadyboyNick");
    expect(b.colorToName.size).toBe(4);
    expect(b.board).not.toBeNull();
    expect(b.board!.hexes).toHaveLength(19);
    expect(b.board!.vertices).toHaveLength(54);
    expect(b.board!.edges).toHaveLength(72);
    // exactly one desert, 18 numbered tiles
    expect(b.board!.hexes.filter((h) => h.kind === "desert")).toHaveLength(1);
    expect(b.board!.hexes.filter((h) => h.token !== null)).toHaveLength(18);
  });

  it("assigns all nine ports (4 generic, 5 resource)", () => {
    const b = new StateBridge();
    b.apply(S.init.type, S.init.payload);
    const ports = b.board!.vertices.map((v) => v.port).filter(Boolean);
    // each port spans an edge = 2 vertices
    const resourcePorts = new Set(
      ports.filter((p) => p!.ratio === 2).map((p) => p!.kind),
    );
    expect(resourcePorts.size).toBe(5);
    expect(ports.some((p) => p!.kind === "any")).toBe(true);
  });

  it("tracks whose turn it is and the roll phase", () => {
    const b = new StateBridge();
    b.apply(S.init.type, S.init.payload);
    b.apply(S.myTurnRoll.type, S.myTurnRoll.payload);
    // the diff set currentTurnPlayerColor to 1 (us)
    expect(b.currentTurnColor).toBe(1);
    expect(b.isMyTurn).toBe(true);
  });

  it("maps a corner build to a real board vertex", () => {
    const b = new StateBridge();
    b.apply(S.init.type, S.init.payload);
    b.apply(S.buildDiff.type, S.buildDiff.payload);
    const built = b.buildings;
    expect(built.length).toBeGreaterThan(0);
    for (const bd of built) {
      expect(bd.vertexId).toBeGreaterThanOrEqual(0);
      expect(bd.vertexId).toBeLessThan(54);
      expect(["settlement", "city"]).toContain(bd.kind);
    }
  });

  it("reads our exact hand from resource card ids", () => {
    const b = new StateBridge();
    b.apply(S.init.type, S.init.payload);
    b.apply(S.handDiff.type, S.handDiff.payload);
    const hand = b.handOf(1);
    expect(hand.total).toBeGreaterThan(0);
    const sum = Object.values(hand.known).reduce((s, n) => s + (n ?? 0), 0);
    expect(sum).toBe(hand.total); // our cards are fully identified
  });

  it("masks opponents' card identities but keeps the count", () => {
    const b = new StateBridge();
    b.apply(S.init.type, S.init.payload);
    b.apply(S.handDiff.type, S.handDiff.payload);
    for (const color of [2, 3, 4]) {
      const hand = b.handOf(color);
      // any known cards can't exceed the total; masked ids contribute 0 known
      const known = Object.values(hand.known).reduce((s, n) => s + (n ?? 0), 0);
      expect(known).toBeLessThanOrEqual(hand.total);
    }
  });

  it("detects the setup placement (settlement or its road) from the real board", () => {
    const b = new StateBridge();
    b.apply(S.init.type, S.init.payload);
    const gs = b.toGameState()!;
    const advice = advisePlacement(gs.state, gs.youPlayer)!;
    expect(advice).not.toBeNull();
    // A concrete placement recommendation, not "board not captured".
    expect(advice.heading.toLowerCase()).toMatch(/settlement|road|expand/);
    // Any recommended settlement spot must be a legal, distinct vertex.
    for (const s of advice.spots) {
      if (advice.phase === "setup" && advice.roadEdges.length === 0) {
        expect(isVertexBuildable(gs.state, s.vertexId)).toBe(true);
      }
      expect(s.vertexId).toBeGreaterThanOrEqual(0);
    }
    // Either a settlement spot or a concrete road to lay was produced.
    expect(advice.spots.length + advice.roadEdges.length).toBeGreaterThan(0);
  });

  it("produces an engine GameState with our player index", () => {
    const b = new StateBridge();
    b.apply(S.init.type, S.init.payload);
    b.apply(S.buildDiff.type, S.buildDiff.payload);
    const gs = b.toGameState()!;
    expect(gs.state.board.hexes).toHaveLength(19);
    expect(gs.youPlayer).not.toBeNull();
  });
});
