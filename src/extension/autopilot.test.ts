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
import { Autopilot, bestPlaceableNow, bestRobberHex, decideNext } from "./autopilot";
import { createTracker, applyEvent, applyServerPlayerState } from "./tracker";
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

  it("buys a dev card without the board captured", () => {
    const t = trackerWith({ ore: 1, sheep: 1, wheat: 1 });
    const fits = rankLiveStrategies(t, "Nick");
    const cityDev = fits.find((f) => f.strategy.id === "city-dev")!;
    const d = decideNext({
      tracker: t,
      youName: "Nick",
      fit: cityDev,
      gs: null, // no board — dev/roll/end-turn must still work
      advice: null,
      rolledThisTurn: true,
    });
    expect(d?.kind).toBe("buy-dev");
  });

  it("falls back to clicking game buttons when no template is learned", () => {
    localStorage.clear();
    const learner = new ProtocolLearner(); // nothing learned
    const clicks: string[] = [];
    const ap = new Autopilot(learner, () => {}, (kind) => {
      clicks.push(kind);
      return "clicked";
    });
    ap.setEnabled(true);
    ap.setTurnFallback(true, false); // DOM says it's my turn, not rolled

    const t = trackerWith({});
    const fits = rankLiveStrategies(t, "Nick");
    ap.tick({ tracker: t, gs: null, advice: null, fit: fits[0], now: 10_000 });
    expect(clicks).toEqual(["roll"]);
  });

  it("syncs the exact own hand from server player-state frames", () => {
    const t = trackerWith({ wood: 1, sheep: 3 }); // log-derived, missing an ore
    applyServerPlayerState(
      t,
      [
        // 1 wood, 3 sheep, 1 ore — colonist card ids
        { username: "Nick", color: 3, resourceCards: [1, 3, 3, 3, 5] },
        { username: "Ava", color: 1, resourceCards: [0, 0, 0, 0, 0, 0, 0] },
      ],
      3,
    );
    const nick = t.players.get("Nick")!;
    expect(nick.hand).toEqual({ wood: 1, brick: 0, sheep: 3, wheat: 0, ore: 1 });
    expect(nick.uncertainty).toBe(0);
    expect(nick.serverCards).toBe(5);
    // opponent cards are masked (ids 0) — total is authoritative, mix unknown
    const ava = t.players.get("Ava")!;
    expect(ava.serverCards).toBe(7);
  });

  it("picks a robber tile that hurts the opponent, not itself", () => {
    // opponent settlement on a 3-hex vertex; my settlement elsewhere
    const oppVertex = board.vertices.find((v) => v.hexIds.length === 3)!;
    const myVertex = board.vertices.find(
      (v) => v.hexIds.length === 3 && !v.hexIds.some((h) => oppVertex.hexIds.includes(h)),
    )!;
    const state: GameState = {
      board,
      buildings: [
        { vertexId: oppVertex.id, player: 1, kind: "settlement" },
        { vertexId: myVertex.id, player: 0, kind: "settlement" },
      ],
      roads: [],
    };
    const target = bestRobberHex(state, 0, null)!;
    expect(target).not.toBeNull();
    // the chosen tile must be one the opponent touches
    const hex = board.hexes.find((h) => h.q === target.hex.x && h.r === target.hex.y)!;
    const oppTouches = oppVertex.hexIds.includes(hex.id);
    const iTouch = myVertex.hexIds.includes(hex.id);
    expect(oppTouches).toBe(true);
    expect(iTouch).toBe(false);
    expect(target.victim).toBe(1);
  });

  it("never re-places the robber on its current tile", () => {
    const oppVertex = board.vertices.find((v) => v.hexIds.length === 3)!;
    const state: GameState = {
      board,
      buildings: [{ vertexId: oppVertex.id, player: 1, kind: "settlement" }],
      roads: [],
    };
    const first = bestRobberHex(state, 0, null)!;
    const again = bestRobberHex(state, 0, first.hex);
    if (again) {
      expect(`${again.hex.x},${again.hex.y}`).not.toBe(`${first.hex.x},${first.hex.y}`);
    }
  });

  it("prioritizes moving the robber over building when pending", () => {
    const oppVertex = board.vertices.find((v) => v.hexIds.length === 3)!;
    const gs = {
      state: {
        board,
        buildings: [
          { vertexId: oppVertex.id, player: 1 as const, kind: "settlement" as const },
        ],
        roads: [],
      },
      youPlayer: 0 as const,
    };
    const t = trackerWith({ ore: 3, wheat: 2 }); // could afford a city
    const fits = rankLiveStrategies(t, "Nick");
    const d = decideNext({
      tracker: t,
      youName: "Nick",
      fit: fits[0],
      gs,
      advice: null,
      rolledThisTurn: true,
      robberPending: true,
      robberHex: null,
    });
    expect(d?.kind).toBe("move-robber");
    expect(d?.coord).toBeDefined();
    expect(d?.coord?.z).toBeUndefined(); // hexFace has no z
  });

  it("learns and rebuilds a move-robber (hexFace) template", () => {
    localStorage.clear();
    const learner = new ProtocolLearner();
    learner.recordOutbound(
      { id: 5, data: { type: 40, payload: { hexFace: { x: 1, y: -1 } } } },
      1000,
    );
    learner.confirm("move-robber", 1500);
    expect(learner.status()["move-robber"]).toBe(true);
    const frame = learner.buildFrame("move-robber", { x: -2, y: 2 }) as {
      data: { payload: { hexFace: { x: number; y: number; z?: number } } };
    };
    expect(frame.data.payload.hexFace).toEqual({ x: -2, y: 2 });
    expect("z" in frame.data.payload.hexFace).toBe(false);
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
