// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { generateBoard } from "../../engine/board";
import { GameState } from "../../engine/types";
import { rankLiveStrategies } from "../copilot";
import { applyEvent, createTracker } from "../tracker";
import { isRushMode } from "./rushMode";
import { RUSH_ACTIONS, RushPilot, decideRush } from "./rushPilot";

const board = generateBoard(42);

function trackerWith(hand: Partial<Record<string, number>>) {
  const t = createTracker("Nick");
  applyEvent(t, { type: "place", player: "Nick", color: "#c00", what: "settlement" });
  const p = t.players.get("Nick")!;
  for (const [r, n] of Object.entries(hand)) (p.hand as Record<string, number>)[r] = n ?? 0;
  return t;
}

function gsWithSettlement(): { state: GameState; youPlayer: 0 } {
  const v = board.vertices.find((x) => x.hexIds.length === 3)!;
  return {
    state: { board, buildings: [{ vertexId: v.id, player: 0, kind: "settlement" }], roads: [] },
    youPlayer: 0,
  };
}

describe("rush mode detection", () => {
  it("a manual preference always wins; auto trusts the game settings", () => {
    expect(isRushMode(0, "on")).toBe(true);
    expect(isRushMode(7, "off")).toBe(false);
    expect(isRushMode(0, "auto")).toBe(false); // 0 = normal turn game
    expect(isRushMode(null, "auto")).toBe(false);
  });
});

describe("rush decisions", () => {
  it("never rolls, ends a turn, trades or buys/plays cards — even when the turn game would", () => {
    // late phase, dev card affordable, hand over the limit: the turn game would
    // buy a dev card / bank-trade / end the turn. Rush must do none of those.
    const t = trackerWith({ ore: 1, sheep: 8, wheat: 1 }); // dev yes, city no, over the limit
    t.players.get("Nick")!.serverVp = 8;
    const fit = rankLiveStrategies(t, "Nick").find((f) => f.strategy.id === "city-dev")!;
    const d = decideRush({
      tracker: t, youName: "Nick", fit, gs: gsWithSettlement(), advice: null,
      robberPending: false, discardPending: false,
    });
    expect(d).toBeNull();
  });

  it("upgrades to a city the moment it is affordable (no turn, no roll)", () => {
    const t = trackerWith({ ore: 3, wheat: 2 });
    const fit = rankLiveStrategies(t, "Nick")[0];
    const d = decideRush({
      tracker: t, youName: "Nick", fit, gs: gsWithSettlement(), advice: null,
      robberPending: false, discardPending: false,
    });
    expect(d?.kind).toBe("build-city");
  });

  it("places the setup settlement from the advice", () => {
    const t = createTracker("Nick");
    const v = board.vertices.find((x) => x.hexIds.length === 3)!;
    const gs = { state: { board, buildings: [], roads: [] } as GameState, youPlayer: 0 as const };
    const advice = {
      phase: "setup" as const, heading: "", roadEdges: [], note: null,
      spots: [{ vertexId: v.id, rank: 1, label: "" }],
    };
    // the tracker needs to know us even before the first log row
    applyEvent(t, { type: "place", player: "Nick", color: "#c00", what: "settlement" });
    const d = decideRush({
      tracker: t, youName: "Nick", fit: null, gs, advice, robberPending: false, discardPending: false,
    });
    expect(d?.kind).toBe("build-settlement");
  });

  it("moves the robber when asked, ahead of building", () => {
    const t = trackerWith({ ore: 3, wheat: 2 });
    const fit = rankLiveStrategies(t, "Nick")[0];
    const gs = gsWithSettlement();
    // an opponent on a productive tile so there's something to block
    const opp = board.vertices.find(
      (x) => x.hexIds.length === 3 && x.id !== gs.state.buildings[0].vertexId &&
        !board.vertices[gs.state.buildings[0].vertexId].adjacent.includes(x.id),
    )!;
    gs.state.buildings.push({ vertexId: opp.id, player: 1, kind: "settlement" });
    const d = decideRush({
      tracker: t, youName: "Nick", fit, gs, advice: null, robberPending: true, discardPending: false,
    });
    expect(d?.kind).toBe("move-robber");
  });

  it("only ever returns Rush actions", () => {
    for (const k of ["roll", "end-turn", "buy-dev", "bank-trade", "play-knight"] as const) {
      expect(RUSH_ACTIONS.has(k)).toBe(false);
    }
  });
});

describe("rush executor", () => {
  it("acts without any turn signal and waits for confirmation before acting again", () => {
    const sent: string[] = [];
    const pilot = new RushPilot((d) => (sent.push(d.kind), true));
    pilot.setEnabled(true);
    const t = trackerWith({ ore: 3, wheat: 2 });
    const fit = rankLiveStrategies(t, "Nick")[0];
    const ctx = { tracker: t, fit, gs: gsWithSettlement(), advice: null };

    pilot.tick({ ...ctx, now: 1000 });
    expect(sent).toEqual(["build-city"]);
    pilot.tick({ ...ctx, now: 2000 }); // still pending — no second send
    expect(sent).toEqual(["build-city"]);

    pilot.onConfirm("build-city");
    pilot.tick({ ...ctx, now: 3000 }); // confirmed: decides afresh (still affordable here)
    expect(sent).toEqual(["build-city", "build-city"]);
  });

  it("retries after an unconfirmed action times out", () => {
    const sent: string[] = [];
    const pilot = new RushPilot((d) => (sent.push(d.kind), true));
    pilot.setEnabled(true);
    const t = trackerWith({ ore: 3, wheat: 2 });
    const fit = rankLiveStrategies(t, "Nick")[0];
    const ctx = { tracker: t, fit, gs: gsWithSettlement(), advice: null };
    pilot.tick({ ...ctx, now: 1000 });
    pilot.tick({ ...ctx, now: 4000 }); // within the timeout
    expect(sent.length).toBe(1);
    pilot.tick({ ...ctx, now: 7000 }); // timed out -> retry
    expect(sent.length).toBe(2);
  });
});
