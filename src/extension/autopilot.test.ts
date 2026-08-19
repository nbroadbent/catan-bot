// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from "vitest";
import {
  colonistCornerToPixel,
  colonistEdgeToPixels,
  findVertexAt,
  generateBoard,
} from "../engine/board";
import { pixelToColonistCorner, pixelsToColonistEdge } from "./coords";
import { ProtocolLearner } from "./protocolLearner";
import { Autopilot, bestPlaceableNow, decideNext } from "./autopilot";
import { createTracker, applyEvent } from "./tracker";
import { rankLiveStrategies } from "./copilot";
import { GameState } from "../engine/types";

const board = generateBoard(42);

describe("coordinate reverse-mapping", () => {
  it("round-trips every vertex through colonist corner coords", () => {
    for (const v of board.vertices) {
      const corner = pixelToColonistCorner(v.x, v.y);
      expect(corner).not.toBeNull();
      const px = colonistCornerToPixel(corner!);
      expect(findVertexAt(board, px.x, px.y)?.id).toBe(v.id);
    }
  });

  it("round-trips every edge through colonist edge coords", () => {
    for (const e of board.edges) {
      const wire = pixelsToColonistEdge(board.vertices[e.a], board.vertices[e.b]);
      expect(wire).not.toBeNull();
      const [p1, p2] = colonistEdgeToPixels(wire!);
      const ids = [findVertexAt(board, p1.x, p1.y)?.id, findVertexAt(board, p2.x, p2.y)?.id];
      expect(ids.sort()).toEqual([e.a, e.b].sort());
    }
  });
});

describe("protocol learner", () => {
  beforeEach(() => localStorage.clear());

  it("pairs a confirmed action with the frame that caused it", () => {
    const learner = new ProtocolLearner();
    learner.recordOutbound({ id: 10, data: { type: 99, payload: "heartbeat" } }, 1000);
    learner.recordOutbound(
      { id: 11, data: { type: 50, payload: [{ hexCorner: { x: 1, y: -1, z: 0 }, kind: 2 }] } },
      2000,
    );
    learner.confirm("build-settlement", 2500);
    expect(learner.status()["build-settlement"]).toBe(true);

    const frame = learner.buildFrame("build-settlement", { x: 0, y: 2, z: 1 }) as {
      data: { payload: Array<{ hexCorner: { x: number; y: number; z: number } }> };
    };
    expect(frame.data.payload[0].hexCorner).toEqual({ x: 0, y: 2, z: 1 });
  });

  it("skips coordinate-less frames when the action needs coordinates", () => {
    const learner = new ProtocolLearner();
    learner.recordOutbound({ id: 1, data: { type: 50, payload: [{ hexCorner: { x: 0, y: 0, z: 0 } }] } }, 1000);
    learner.recordOutbound({ id: 2, data: { type: 99 } }, 1800); // heartbeat after the action
    learner.confirm("build-road", 2000);
    // paired past the heartbeat to the coordinate frame
    expect(learner.status()["build-road"]).toBe(true);
  });

  it("bumps sequence counters on built frames", () => {
    const learner = new ProtocolLearner();
    for (let i = 1; i <= 4; i++) {
      learner.recordOutbound({ id: 100 + i, data: { type: 7 } }, i * 1000);
    }
    learner.confirm("roll", 4500);
    const frame = learner.buildFrame("roll") as { id: number };
    expect(frame.id).toBe(105); // last seen 104, bumped
  });

  it("un-learns a template on discard (self-correction)", () => {
    const learner = new ProtocolLearner();
    learner.recordOutbound({ id: 1, data: { type: 7 } }, 1000);
    learner.confirm("roll", 1200);
    expect(learner.status().roll).toBe(true);
    learner.discard("roll");
    expect(learner.status().roll).toBe(false);
    expect(learner.buildFrame("roll")).toBeNull();
  });

  it("persists templates across instances", () => {
    const a = new ProtocolLearner();
    a.recordOutbound({ id: 1, data: { type: 7 } }, 1000);
    a.confirm("roll", 1200);
    const b = new ProtocolLearner();
    b.load();
    expect(b.status().roll).toBe(true);
  });
});

function trackerWith(hand: Partial<Record<string, number>>, income = true) {
  const t = createTracker("Nick");
  applyEvent(t, { type: "place", player: "Nick", color: "#c00", what: "settlement" });
  if (income) {
    applyEvent(t, { type: "roll", player: "Nick", total: 8 });
    applyEvent(t, { type: "got", player: "Nick", resources: { ore: 2, wheat: 1 } });
  }
  const p = t.players.get("Nick")!;
  for (const [r, n] of Object.entries(hand)) (p.hand as Record<string, number>)[r] = n ?? 0;
  return t;
}

function gsWithSettlement(): { state: GameState; youPlayer: 0 } {
  const v = board.vertices.find((x) => x.hexIds.length === 3)!;
  return {
    state: {
      board,
      buildings: [{ vertexId: v.id, player: 0, kind: "settlement" }],
      roads: [],
    },
    youPlayer: 0,
  };
}

describe("autopilot decisions", () => {
  it("rolls first on its turn", () => {
    const t = trackerWith({});
    const fits = rankLiveStrategies(t, "Nick");
    const d = decideNext({
      tracker: t,
      youName: "Nick",
      fit: fits[0],
      gs: gsWithSettlement(),
      advice: null,
      rolledThisTurn: false,
    });
    expect(d?.kind).toBe("roll");
  });

  it("upgrades to a city when affordable, with real coordinates", () => {
    const t = trackerWith({ ore: 3, wheat: 2 });
    const fits = rankLiveStrategies(t, "Nick");
    const gs = gsWithSettlement();
    const d = decideNext({
      tracker: t,
      youName: "Nick",
      fit: fits[0],
      gs,
      advice: null,
      rolledThisTurn: true,
    });
    expect(d?.kind).toBe("build-city");
    const px = colonistCornerToPixel(d!.coord!);
    expect(findVertexAt(board, px.x, px.y)?.id).toBe(gs.state.buildings[0].vertexId);
  });

  it("ends the turn when nothing is affordable", () => {
    const t = trackerWith({});
    const fits = rankLiveStrategies(t, "Nick");
    const d = decideNext({
      tracker: t,
      youName: "Nick",
      fit: fits[0],
      gs: gsWithSettlement(),
      advice: null,
      rolledThisTurn: true,
    });
    expect(d?.kind).toBe("end-turn");
  });

  it("finds no placeable spot when the network is blocked", () => {
    const gs = gsWithSettlement();
    // the only network vertex is the settlement itself — occupied
    expect(bestPlaceableNow(gs.state, 0)).toBeNull();
  });

  it("executor sends learned frames and self-corrects on no confirmation", () => {
    localStorage.clear();
    const learner = new ProtocolLearner();
    learner.recordOutbound({ id: 1, data: { type: 7 } }, 1000);
    learner.confirm("roll", 1200);

    const sent: unknown[] = [];
    const ap = new Autopilot(learner, (f) => sent.push(f));
    ap.setEnabled(true);
    ap.onTurnState(3, 3); // my turn

    const t = trackerWith({});
    const fits = rankLiveStrategies(t, "Nick");
    const ctx = { tracker: t, gs: gsWithSettlement(), advice: null, fit: fits[0], now: 10_000 };
    ap.tick(ctx);
    expect(sent).toHaveLength(1); // rolled

    // no confirmation arrives: after the timeout the template is discarded
    ap.tick({ ...ctx, now: 20_000 });
    expect(learner.status().roll).toBe(false);
    expect(ap.enabled).toBe(true); // stays on, waits to re-learn
  });
});
