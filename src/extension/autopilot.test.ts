// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from "vitest";
import {
  colonistCornerToPixel,
  colonistEdgeToPixels,
  findVertexAt,
  generateBoard,
} from "../engine/board";
import { pixelToColonistCorner, pixelsToColonistEdge } from "./coords";
import { DISCARD_BANNER, MOVE_ROBBER_BANNER } from "./domActions";
import { ProtocolLearner } from "./protocolLearner";
import { Autopilot, bestPlaceableNow, bestRobberHex, decideNext, planBankTrade } from "./autopilot";
import { createTracker, applyEvent, applyServerPlayerState, findDiscardLimit } from "./tracker";
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

describe("robber banner detection", () => {
  it("matches instructions addressed to you", () => {
    for (const s of [
      "Move the robber",
      "move robber",
      "You must move the Robber",
      "Place the robber",
      "Select a tile for the robber",
    ]) {
      expect(MOVE_ROBBER_BANNER.test(s), s).toBe(true);
    }
  });

  it("ignores opponents' banners and passive robber mentions", () => {
    for (const s of [
      "yoyoprashant is moving the robber",
      "Waiting for LadyboyNick to move the robber",
      "Robber",
      "Friendly Robber",
      "moved Robber",
    ]) {
      expect(MOVE_ROBBER_BANNER.test(s), s).toBe(false);
    }
  });
});

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
    const ap = new Autopilot(learner, () => false, (kind) => {
      clicks.push(kind);
      return "clicked";
    });
    ap.setEnabled(true);
    ap.noteDomTurn(true); // DOM banner says it's my turn; not rolled yet

    const t = trackerWith({});
    const fits = rankLiveStrategies(t, "Nick");
    ap.tick({ tracker: t, gs: null, advice: null, fit: fits[0], now: 10_000 });
    expect(clicks).toEqual(["roll"]);
  });

  it("opens the turn gate from the DOM banner even when WS color never matches", () => {
    localStorage.clear();
    const learner = new ProtocolLearner();
    const clicks: string[] = [];
    const ap = new Autopilot(learner, () => false, (kind) => {
      clicks.push(kind);
      return "clicked";
    });
    ap.setEnabled(true);
    // WebSocket turn frames arrive but the color never equals ours (mismatch
    // or myColor null) — the WS signal stays false...
    ap.onTurnState(2, 5);
    ap.onTurnState(3, 5);
    // ...yet the "Your Turn" banner is up, so autopilot must still act.
    ap.noteDomTurn(true);
    const t = trackerWith({});
    const fits = rankLiveStrategies(t, "Nick");
    ap.tick({ tracker: t, gs: null, advice: null, fit: fits[0], now: 10_000 });
    expect(clicks).toEqual(["roll"]);
  });

  it("rolls once our color resolves late, even mid-turn (no banner)", () => {
    localStorage.clear();
    const learner = new ProtocolLearner();
    const clicks: string[] = [];
    const ap = new Autopilot(learner, () => false, (kind) => {
      clicks.push(kind);
      return "clicked";
    });
    ap.setEnabled(true);
    const t = trackerWith({});
    const fits = rankLiveStrategies(t, "Nick");
    const ctx = { tracker: t, gs: null, advice: null, fit: fits[0] };

    // Turn frame says it's color 3's turn, but our color hasn't resolved yet.
    ap.onTurnState(3, null);
    ap.noteDomTurn(false);
    ap.tick({ ...ctx, now: 10_000 });
    expect(clicks).toEqual([]); // can't tell it's us — wait

    // Roster resolves our color to 3 (re-evaluated with the same turn color).
    ap.onTurnState(3, 3);
    ap.tick({ ...ctx, now: 11_000 });
    expect(clicks).toEqual(["roll"]); // now it rolls, without a banner
  });

  it("does not act when neither turn signal fires", () => {
    localStorage.clear();
    const learner = new ProtocolLearner();
    const clicks: string[] = [];
    const ap = new Autopilot(learner, () => false, (kind) => {
      clicks.push(kind);
      return "clicked";
    });
    ap.setEnabled(true);
    ap.onTurnState(2, 5); // WS: not mine
    ap.noteDomTurn(false); // DOM: no banner
    const t = trackerWith({});
    const fits = rankLiveStrategies(t, "Nick");
    ap.tick({ tracker: t, gs: null, advice: null, fit: fits[0], now: 10_000 });
    expect(clicks).toEqual([]);
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

  it("plays a knight when the robber squats on your tile", () => {
    const t = trackerWith({});
    const fits = rankLiveStrategies(t, "Nick");
    const gs = gsWithSettlement();
    const myHex = board.hexes[board.vertices[gs.state.buildings[0].vertexId].hexIds[0]];
    const d = decideNext({
      tracker: t,
      youName: "Nick",
      fit: fits[0],
      gs,
      advice: null,
      rolledThisTurn: true,
      robberHex: { x: myHex.q, y: myHex.r },
      knightAvailable: true,
    });
    expect(d?.kind).toBe("play-knight");
    expect(d?.describe).toContain("robber is on your tile");
  });

  it("plays a knight for Largest Army on the city-dev plan, not otherwise", () => {
    const t = trackerWith({});
    const fits = rankLiveStrategies(t, "Nick");
    const cityDev = fits.find((f) => f.strategy.id === "city-dev")!;
    const roadExpand = fits.find((f) => f.strategy.id === "road-expand")!;
    const base = {
      tracker: t,
      youName: "Nick",
      gs: gsWithSettlement(),
      advice: null,
      rolledThisTurn: true,
      robberHex: null,
      knightAvailable: true,
    };
    expect(decideNext({ ...base, fit: cityDev })?.kind).toBe("play-knight");
    expect(decideNext({ ...base, fit: roadExpand })?.kind).not.toBe("play-knight");
  });

  it("executor plays a learned knight once per turn and not the turn it's bought", () => {
    localStorage.clear();
    const learner = new ProtocolLearner();
    learner.recordOutbound({ id: 9, data: { type: 60, payload: { cardType: 7 } } }, 1000);
    learner.confirm("play-knight", 1200);

    const sent: Array<{ kind: string }> = [];
    const ap = new Autopilot(learner, (d) => {
      sent.push(d as { kind: string });
      return true;
    });
    const knights = () => sent.filter((d) => d.kind === "play-knight").length;
    ap.setEnabled(true);
    ap.onTurnState(3, 3); // my turn
    ap.onYouRolled();

    const t = trackerWith({});
    const cityDev = rankLiveStrategies(t, "Nick").find((f) => f.strategy.id === "city-dev")!;
    const ctx = {
      tracker: t,
      gs: gsWithSettlement(),
      advice: null,
      fit: cityDev,
      knightsInHand: 2,
      now: 10_000,
    };
    ap.tick(ctx);
    expect(knights()).toBe(1); // knight played

    ap.onConfirm("play-knight"); // game confirmed: one dev per turn is spent
    ap.tick({ ...ctx, now: 12_000 });
    expect(knights()).toBe(1); // no second knight this turn

    // next turn, but the only knight in hand was bought this turn
    ap.onTurnState(1, 3);
    ap.onTurnState(3, 3);
    ap.onYouRolled();
    ap.onConfirm("buy-dev");
    ap.tick({ ...ctx, knightsInHand: 1, now: 20_000 });
    expect(knights()).toBe(1); // still just the one knight
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

  it("moves the robber via the learned template when it's yours to move", () => {
    localStorage.clear();
    const learner = new ProtocolLearner();
    learner.recordOutbound(
      { id: 5, data: { type: 40, payload: { hexFace: { x: 1, y: -1 } } } },
      1000,
    );
    learner.confirm("move-robber", 1500);

    const sent: unknown[] = [];
    const ap = new Autopilot(learner, (d) => { sent.push(d); return true; });
    ap.setEnabled(true);
    ap.onTurnState(3, 3); // my turn (WS)
    ap.setRobberPending(true);

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
    const t = trackerWith({});
    const fits = rankLiveStrategies(t, "Nick");
    ap.tick({ tracker: t, gs, advice: null, fit: fits[0], robberHex: null, now: 10_000 });
    expect(sent).toHaveLength(1);
    const decision = sent[0] as { kind: string; coord: { x: number; y: number } };
    expect(decision.kind).toBe("move-robber");
    // the chosen tile is one the opponent's settlement touches
    const hex = board.hexes.find((h) => h.q === decision.coord.x && h.r === decision.coord.y)!;
    expect(oppVertex.hexIds).toContain(hex.id);
    ap.onConfirm("move-robber");
    expect(ap.robberPending).toBe(false);
  });

  it("never moves the robber out of turn (stray banner match)", () => {
    localStorage.clear();
    const learner = new ProtocolLearner();
    learner.recordOutbound(
      { id: 5, data: { type: 40, payload: { hexFace: { x: 1, y: -1 } } } },
      1000,
    );
    learner.confirm("move-robber", 1500);

    const sent: unknown[] = [];
    const ap = new Autopilot(learner, (d) => { sent.push(d); return true; });
    ap.setEnabled(true);
    ap.onTurnState(1, 3); // WS says it's the OPPONENT's turn
    ap.setRobberPending(true); // banner matched anyway (e.g. false positive)

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
    const t = trackerWith({});
    const fits = rankLiveStrategies(t, "Nick");
    ap.tick({ tracker: t, gs, advice: null, fit: fits[0], robberHex: null, now: 10_000 });
    expect(sent).toHaveLength(0); // out of turn — nothing sent, template kept
    expect(learner.status()["move-robber"]).toBe(true);
  });

  it("executor sends learned frames and self-corrects on no confirmation", () => {
    localStorage.clear();
    const learner = new ProtocolLearner();
    learner.recordOutbound({ id: 1, data: { type: 7 } }, 1000);
    learner.confirm("roll", 1200);

    const sent: unknown[] = [];
    const ap = new Autopilot(learner, (d) => { sent.push(d); return true; });
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

describe("forced discards", () => {
  beforeEach(() => localStorage.clear());

  it("discard banner matches prompts addressed to you only", () => {
    for (const s of [
      "Select cards to discard",
      "Choose resources to discard",
      "Discard 5 cards",
      "Discard resources",
    ]) {
      expect(DISCARD_BANNER.test(s), s).toBe(true);
    }
    for (const s of [
      "Waiting for Ava to discard",
      "Nick discarded",
      "Discard limit: 9",
      "discard",
    ]) {
      expect(DISCARD_BANNER.test(s), s).toBe(false);
    }
  });

  it("finds a custom discard limit in a settings frame", () => {
    expect(findDiscardLimit({ data: { gameSettings: { cardDiscardLimit: 7 } } })).toBe(7);
    expect(findDiscardLimit({ data: { victoryPointsToWin: 15 } })).toBeNull();
  });

  it("learns a discard template and substitutes the chosen card ids", () => {
    const learner = new ProtocolLearner();
    learner.recordOutbound({ id: 3, data: { type: 60, payload: { selectedCards: [1, 1, 2] } } }, 1000);
    learner.confirm("discard", 1500);
    expect(learner.status().discard).toBe(true);
    const frame = learner.buildFrame("discard", undefined, [3, 3, 5]) as {
      data: { payload: { selectedCards: number[] } };
    };
    expect(frame.data.payload.selectedCards).toEqual([3, 3, 5]);
  });

  it("chooses the worst cards, half the hand, keeping the next build", () => {
    const t = trackerWith({ sheep: 5, ore: 3, wheat: 2 }); // 10 cards > limit 9
    const fits = rankLiveStrategies(t, "Nick");
    const d = decideNext({
      tracker: t,
      youName: "Nick",
      fit: fits[0],
      gs: null,
      advice: null,
      rolledThisTurn: true,
      discardPending: true,
    });
    expect(d?.kind).toBe("discard");
    const total = Object.values(d!.cards!).reduce((s, n) => s + (n ?? 0), 0);
    expect(total).toBe(5); // floor(10 / 2)
    // sheep is the surplus for every strategy's next build here
    expect(d!.cards!.sheep ?? 0).toBeGreaterThanOrEqual(3);
  });

  it("does not discard when the hand is within the limit", () => {
    const t = trackerWith({ sheep: 3, ore: 3, wheat: 2 }); // 8 cards ≤ 9
    const fits = rankLiveStrategies(t, "Nick");
    const d = decideNext({
      tracker: t,
      youName: "Nick",
      fit: fits[0],
      gs: null,
      advice: null,
      rolledThisTurn: true,
      discardPending: true,
    });
    expect(d?.kind).not.toBe("discard");
  });

  it("dispatches a discard decision even off-turn (a 7 while over the limit)", () => {
    const learner = new ProtocolLearner();
    const sent: Array<{ kind: string; cards?: Record<string, number> }> = [];
    const ap = new Autopilot(learner, (d) => {
      sent.push(d as { kind: string; cards?: Record<string, number> });
      return true;
    });
    ap.setEnabled(true);
    ap.onTurnState(1, 3); // the OPPONENT's turn — their 7 still makes us discard
    ap.setDiscardPending(true);

    const t = trackerWith({ sheep: 6, ore: 2, wheat: 2 }); // 10 cards
    const fits = rankLiveStrategies(t, "Nick");
    ap.tick({ tracker: t, gs: null, advice: null, fit: fits[0], now: 10_000 });
    expect(sent).toHaveLength(1);
    expect(sent[0].kind).toBe("discard");
    const total = Object.values(sent[0].cards ?? {}).reduce((s, n) => s + n, 0);
    expect(total).toBe(5); // half of 10, rounded down
    ap.onConfirm("discard");
    expect(ap.discardPending).toBe(false);
  });

  it("spends an over-limit hand down rather than ending the turn", () => {
    const t = trackerWith({ wood: 4, brick: 3, ore: 1, sheep: 1, wheat: 1 }); // 10 cards
    const fits = rankLiveStrategies(t, "Nick");
    const roadExpand = fits.find((f) => f.strategy.id === "road-expand")!;
    const d = decideNext({
      tracker: t,
      youName: "Nick",
      fit: roadExpand,
      gs: null, // no board: road/settlement can't be placed, dev still can
      advice: null,
      rolledThisTurn: true,
    });
    expect(d?.kind).toBe("buy-dev"); // dev isn't in road-expand's build order
    expect(d?.describe).toContain("dumping cards");
  });

  it("bank-trades a lopsided over-limit hand toward the next build", () => {
    // road-expand wants wood+brick; a pile of sheep can't build anything and
    // there's no dev/city to dump into -> it should trade sheep away, not idle.
    const t = trackerWith({ sheep: 10 }, false); // 10 sheep only, nothing buildable
    const fits = rankLiveStrategies(t, "Nick");
    const roadExpand = fits.find((f) => f.strategy.id === "road-expand")!;
    const d = decideNext({
      tracker: t,
      youName: "Nick",
      fit: roadExpand,
      gs: null,
      advice: null,
      rolledThisTurn: true,
    });
    expect(d?.kind).toBe("bank-trade");
    expect(d?.trade?.give).toBe("sheep");
    // road-expand's first build (road) needs wood or brick
    expect(["wood", "brick"]).toContain(d?.trade?.get);
    expect(d?.trade?.giveCount).toBe(4); // default 4:1 with no port
  });

  it("trades toward a build proactively, under the limit (4 wood -> wheat for a city)", () => {
    // 3 ore + 1 wheat + 4 wood = 8 cards (under the 9 limit). A city needs
    // 3 ore + 2 wheat: one 4:1 wood->wheat trade completes it, so it should
    // trade now rather than sit on the wood.
    const t = trackerWith({ ore: 3, wheat: 1, wood: 4 }, false);
    const fits = rankLiveStrategies(t, "Nick");
    const cityDev = fits.find((f) => f.strategy.id === "city-dev")!;
    const d = decideNext({
      tracker: t,
      youName: "Nick",
      fit: cityDev,
      gs: null,
      advice: null,
      rolledThisTurn: true,
    });
    expect(d?.kind).toBe("bank-trade");
    expect(d?.trade).toEqual({ give: "wood", get: "wheat", giveCount: 4 });
    expect(d?.describe).toContain("toward a city");
  });

  it("does not trade toward a build it cannot complete even with trades", () => {
    // 3 wood only: a city (3 ore + 2 wheat) needs 5 cards; 3 wood mints 0 at
    // 4:1, so it's unreachable -> no trade, just end the turn.
    const t = trackerWith({ wood: 3 }, false);
    const fits = rankLiveStrategies(t, "Nick");
    const cityDev = fits.find((f) => f.strategy.id === "city-dev")!;
    const d = decideNext({
      tracker: t,
      youName: "Nick",
      fit: cityDev,
      gs: null,
      advice: null,
      rolledThisTurn: true,
    });
    expect(d?.kind).toBe("end-turn");
  });

  it("planBankTrade returns null when nothing tradeable helps", () => {
    // exactly one sheep: no surplus at any ratio -> no trade
    const t = trackerWith({ sheep: 1 }, false);
    const fits = rankLiveStrategies(t, "Nick");
    const you = t.players.get("Nick")!;
    expect(planBankTrade(you.hand, you.bankRatio, fits[0])).toBeNull();
  });

  it("still ends the turn normally when under the limit", () => {
    const t = trackerWith({ ore: 1, sheep: 1, wheat: 1 }); // 3 cards, dev affordable
    const fits = rankLiveStrategies(t, "Nick");
    const roadExpand = fits.find((f) => f.strategy.id === "road-expand")!;
    const d = decideNext({
      tracker: t,
      youName: "Nick",
      fit: roadExpand,
      gs: null,
      advice: null,
      rolledThisTurn: true,
    });
    expect(d?.kind).toBe("end-turn"); // no pressure — follow the strategy
  });
});
