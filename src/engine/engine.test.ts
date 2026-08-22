import { describe, expect, it } from "vitest";
import { generateBoard, mulberry32, vertexPips } from "./board";
import {
  isVertexBuildable,
  playerProduction,
  resourceAbundance,
  scarcityWeights,
  scoreVertex,
} from "./analysis";
import { rankStrategies } from "./strategy";
import { BalancedDice, simulateStrategy } from "./simulate";
import { analyzeBoard, advisePlayer, initialPlacementAdvice } from "./advisor";
import { GameState, RESOURCES, pips } from "./types";
import { analyzeVictory, PlayerVictoryInput } from "./winnability";

function freshState(seed = 42): GameState {
  return { board: generateBoard(seed), buildings: [], roads: [] };
}

describe("board generation", () => {
  const board = generateBoard(42);

  it("has standard Catan topology: 19 hexes, 54 vertices, 72 edges", () => {
    expect(board.hexes).toHaveLength(19);
    expect(board.vertices).toHaveLength(54);
    expect(board.edges).toHaveLength(72);
  });

  it("uses the standard tile distribution", () => {
    const count = (k: string) => board.hexes.filter((h) => h.kind === k).length;
    expect(count("wood")).toBe(4);
    expect(count("wheat")).toBe(4);
    expect(count("sheep")).toBe(4);
    expect(count("brick")).toBe(3);
    expect(count("ore")).toBe(3);
    expect(count("desert")).toBe(1);
  });

  it("places all 18 tokens, none on the desert", () => {
    const tokens = board.hexes.filter((h) => h.token !== null).map((h) => h.token!);
    expect(tokens).toHaveLength(18);
    expect(tokens.sort((a, b) => a - b)).toEqual(
      [2, 3, 3, 4, 4, 5, 5, 6, 6, 8, 8, 9, 9, 10, 10, 11, 11, 12],
    );
    const desert = board.hexes.find((h) => h.kind === "desert")!;
    expect(desert.token).toBeNull();
  });

  it("never puts 6s and 8s on adjacent hexes", () => {
    for (let seed = 1; seed <= 30; seed++) {
      const b = generateBoard(seed);
      const hot = b.hexes.filter((h) => h.token === 6 || h.token === 8);
      for (const a of hot) {
        for (const c of hot) {
          if (a.id === c.id) continue;
          const dq = a.q - c.q;
          const dr = a.r - c.r;
          const adjacent = [
            [1, 0], [-1, 0], [0, 1], [0, -1], [1, -1], [-1, 1],
          ].some(([q, r]) => dq === q && dr === r);
          expect(adjacent).toBe(false);
        }
      }
    }
  });

  it("is deterministic by seed", () => {
    const a = generateBoard(7);
    const b = generateBoard(7);
    expect(a.hexes.map((h) => `${h.kind}:${h.token}`)).toEqual(
      b.hexes.map((h) => `${h.kind}:${h.token}`),
    );
  });

  it("places 9 ports on coastal vertices", () => {
    const portVertices = board.vertices.filter((v) => v.port !== null);
    // each port spans an edge = 2 vertices
    expect(portVertices.length).toBe(18);
    const twoToOne = new Set(
      portVertices.filter((v) => v.port!.ratio === 2).map((v) => v.port!.kind),
    );
    expect(twoToOne.size).toBe(5); // one 2:1 port per resource
    for (const v of portVertices) expect(v.hexIds.length).toBeLessThan(3);
  });

  it("every vertex touches 1-3 hexes and 2-3 neighbors", () => {
    for (const v of board.vertices) {
      expect(v.hexIds.length).toBeGreaterThanOrEqual(1);
      expect(v.hexIds.length).toBeLessThanOrEqual(3);
      expect(v.adjacent.length).toBeGreaterThanOrEqual(2);
      expect(v.adjacent.length).toBeLessThanOrEqual(3);
    }
  });
});

describe("analysis", () => {
  const state = freshState();

  it("abundance sums to total board pips", () => {
    const abundance = resourceAbundance(state.board);
    const total = RESOURCES.reduce((s, r) => s + abundance[r], 0);
    const boardTotal = state.board.hexes.reduce((s, h) => s + pips(h.token), 0);
    expect(total).toBe(boardTotal);
  });

  it("values a 2:1 port fed by this corner's own production", () => {
    const b = generateBoard(11); // private board — this test mutates a port
    const neutral = Object.fromEntries(RESOURCES.map((r) => [r, 1])) as Record<
      (typeof RESOURCES)[number],
      number
    >;
    const v = b.vertices.find((x) =>
      x.hexIds.some((h) => b.hexes[h].kind !== "desert" && b.hexes[h].token !== null),
    )!;
    const feeding = b.hexes[v.hexIds.find((h) => b.hexes[h].kind !== "desert")!]
      .kind as (typeof RESOURCES)[number];
    const unrelated = RESOURCES.find(
      (r) => !v.hexIds.some((h) => b.hexes[h].kind === r),
    )!;

    v.port = { ratio: 2, kind: feeding };
    const fed = scoreVertex(b, v.id, neutral).score;
    v.port = { ratio: 2, kind: unrelated };
    const dry = scoreVertex(b, v.id, neutral).score;
    v.port = null;
    const none = scoreVertex(b, v.id, neutral).score;

    expect(fed).toBeGreaterThan(dry); // a port you can feed beats one you can't
    expect(dry).toBeGreaterThan(none); // but any 2:1 port still adds value
  });

  it("scarce resources get higher weights", () => {
    const abundance = resourceAbundance(state.board);
    const weights = scarcityWeights(state.board);
    const sorted = [...RESOURCES].sort((a, b) => abundance[a] - abundance[b]);
    expect(weights[sorted[0]]).toBeGreaterThanOrEqual(weights[sorted[4]]);
  });

  it("enforces the distance rule", () => {
    const s = freshState();
    const v = s.board.vertices.find((v) => v.hexIds.length === 3)!;
    expect(isVertexBuildable(s, v.id)).toBe(true);
    s.buildings.push({ vertexId: v.id, player: 0, kind: "settlement" });
    expect(isVertexBuildable(s, v.id)).toBe(false);
    for (const n of v.adjacent) expect(isVertexBuildable(s, n)).toBe(false);
  });

  it("higher-pip vertices score higher under neutral weights", () => {
    const neutral = Object.fromEntries(RESOURCES.map((r) => [r, 1])) as never;
    const scored = state.board.vertices
      .filter((v) => v.hexIds.length === 3 && !v.port)
      .map((v) => ({ pips: vertexPips(state.board, v.id), s: scoreVertex(state.board, v.id, neutral) }));
    const best = scored.reduce((a, b) => (a.s.score >= b.s.score ? a : b));
    const worst = scored.reduce((a, b) => (a.s.score <= b.s.score ? a : b));
    expect(best.pips).toBeGreaterThanOrEqual(worst.pips);
  });

  it("cities produce double", () => {
    const s = freshState();
    const v = s.board.vertices.find((v) => v.hexIds.length === 3)!;
    s.buildings.push({ vertexId: v.id, player: 0, kind: "settlement" });
    const asSettlement = playerProduction(s, 0);
    s.buildings[0].kind = "city";
    const asCity = playerProduction(s, 0);
    for (const r of RESOURCES) expect(asCity[r]).toBeCloseTo(asSettlement[r] * 2);
  });
});

describe("strategy selection", () => {
  it("recommends city-dev for an ore+wheat heavy player", () => {
    const s = freshState();
    // give player 0 every good ore/wheat corner we can find
    const oreWheat = s.board.vertices
      .filter((v) =>
        v.hexIds.every((h) => ["ore", "wheat"].includes(s.board.hexes[h].kind)) &&
        v.hexIds.length >= 2,
      )
      .slice(0, 2);
    for (const v of oreWheat) {
      if (isVertexBuildable(s, v.id)) {
        s.buildings.push({ vertexId: v.id, player: 0, kind: "settlement" });
      }
    }
    if (s.buildings.length > 0) {
      const fits = rankStrategies(s, 0);
      const cityDev = fits.find((f) => f.strategy.id === "city-dev")!;
      const roadExpand = fits.find((f) => f.strategy.id === "road-expand")!;
      expect(cityDev.score).toBeGreaterThan(roadExpand.score);
    }
  });
});

describe("balanced dice", () => {
  it("deals every combo exactly once per 36 rolls", () => {
    const dice = new BalancedDice(mulberry32(9));
    const counts = new Map<number, number>();
    for (let i = 0; i < 36; i++) {
      const r = dice.roll();
      counts.set(r, (counts.get(r) ?? 0) + 1);
    }
    expect(counts.get(7)).toBe(6);
    expect(counts.get(2)).toBe(1);
    expect(counts.get(6)).toBe(5);
    expect(counts.get(8)).toBe(5);
  });
});

describe("simulation & advisor", () => {
  it("a player with buildings accumulates VP in simulation", () => {
    const s = freshState();
    const best = s.board.vertices
      .filter((v) => v.hexIds.length === 3)
      .sort((a, b) => vertexPips(s.board, b.id) - vertexPips(s.board, a.id))[0];
    s.buildings.push({ vertexId: best.id, player: 0, kind: "settlement" });
    const fits = rankStrategies(s, 0);
    const result = simulateStrategy(s, 0, fits[0].strategy, { trials: 10, rounds: 25 });
    const builds = result.meanBuilds;
    expect(
      builds.roads + builds.settlements + builds.cities + builds.devs,
    ).toBeGreaterThan(0);
  });

  it("board report flags scarcest and richest resources", () => {
    const s = freshState();
    const report = analyzeBoard(s);
    const abundance = resourceAbundance(s.board);
    for (const r of RESOURCES) {
      expect(abundance[report.scarcest]).toBeLessThanOrEqual(abundance[r]);
      expect(abundance[report.richest]).toBeGreaterThanOrEqual(abundance[r]);
    }
  });

  it("initial placement advice returns legal, high-pip spots", () => {
    const s = freshState();
    const advice = initialPlacementAdvice(s);
    expect(advice.top.length).toBe(5);
    for (const spot of advice.top) {
      expect(isVertexBuildable(s, spot.vertexId)).toBe(true);
      expect(spot.pips).toBeGreaterThanOrEqual(7); // top-5 on a fresh board is never weak
    }
  });

  it("full advisor runs end-to-end for a mid-game player", () => {
    const s = freshState();
    const spots = initialPlacementAdvice(s).top;
    s.buildings.push({ vertexId: spots[0].vertexId, player: 0, kind: "settlement" });
    s.buildings.push({ vertexId: spots[1].vertexId, player: 1, kind: "settlement" });
    const advice = advisePlayer(s, 0);
    expect(advice.strategies.length).toBe(4);
    expect(advice.simulations.length).toBe(4);
    expect(advice.recommended).toBeDefined();
    expect(advice.trades.length).toBeGreaterThan(0);
  });
});

describe("winnability", () => {
  const emptyHand = () => Object.fromEntries(RESOURCES.map((r) => [r, 0])) as Record<(typeof RESOURCES)[number], number>;
  const base = (over: Partial<PlayerVictoryInput>): PlayerVictoryInput => ({
    name: "P", isYou: false, publicVp: 5,
    settlementsLeft: 3, citiesLeft: 4, roadsLeft: 10,
    settlementsOnBoard: 3, settlementSpotOpen: true,
    knightsPlayed: 0, longestRoadLen: 0,
    hand: emptyHand(), production: { ...emptyHand(), ore: 0.5, wheat: 0.5, sheep: 0.3, wood: 0.3, brick: 0.3 },
    ...over,
  });

  it("probabilities sum to 1 and the closer player leads", () => {
    const plans = analyzeVictory([
      base({ name: "Ahead", publicVp: 9, settlementsOnBoard: 2, hand: { ...emptyHand(), ore: 3, wheat: 2 } }),
      base({ name: "Behind", publicVp: 4 }),
    ], { target: 10, devDeckLeft: 20 });
    const sum = plans.reduce((s, p) => s + p.winProb, 0);
    expect(sum).toBeCloseTo(1, 5);
    expect(plans[0].name).toBe("Ahead"); // one city from winning
    expect(plans[0].winProb).toBeGreaterThan(plans[1].winProb);
  });

  it("picks the cheapest path: settlement on an open spot, city when a new spot needs a road", () => {
    // open spot -> a settlement (4 cards) is cheaper than a city (5)
    const openSpot = analyzeVictory([base({ publicVp: 9, settlementSpotOpen: true })], { target: 10, devDeckLeft: 20 })[0];
    expect(openSpot.steps[0].kind).toBe("settlement");
    // no open spot -> settlement needs a road (6 cards) so a city (5) wins
    const noSpot = analyzeVictory([base({ publicVp: 9, settlementSpotOpen: false, citiesLeft: 2, settlementsOnBoard: 3 })], { target: 10, devDeckLeft: 20 })[0];
    expect(noSpot.steps[0].kind).toBe("city");
  });

  it("reports the road + settlement needed when no cities and no open spot remain", () => {
    const p = analyzeVictory([base({ publicVp: 9, citiesLeft: 0, settlementsOnBoard: 3, settlementSpotOpen: false })], { target: 10, devDeckLeft: 20 })[0];
    expect(p.steps[0].kind).toBe("settlement");
    expect(p.steps[0].note).toMatch(/road \+ settlement/);
    expect(p.summary).toMatch(/no cities left/);
    expect(p.need.wood).toBeGreaterThan(0); // road + settlement both need wood
    expect(p.need.wheat).toBeGreaterThan(0);
  });

  it("marks a player eliminated when nothing left can reach the target", () => {
    const p = analyzeVictory([base({
      publicVp: 8,
      settlementsLeft: 0, citiesLeft: 0, settlementsOnBoard: 0, roadsLeft: 0,
      knightsPlayed: 0, longestRoadLen: 0,
    })], { target: 10, devDeckLeft: 0 })[0]; // no pieces, no dev deck -> can't reach +2
    expect(p.eliminated).toBe(true);
    expect(p.winProb).toBe(0);
    expect(p.turnsToWin).toBe(Infinity);
  });

  it("only offers Largest Army when it can still be taken", () => {
    // opponent holds LA with 3 knights; we have 1 and the deck is nearly empty
    const blocked = analyzeVictory([
      base({ name: "Me", publicVp: 8, knightsPlayed: 1 }),
      base({ name: "Army", publicVp: 8, knightsPlayed: 3 }),
    ], { target: 10, devDeckLeft: 1 })[0 + (0)];
    const me = analyzeVictory([
      base({ name: "Me", publicVp: 8, knightsPlayed: 1, citiesLeft: 0, settlementsLeft: 0, settlementsOnBoard: 0, roadsLeft: 0 }),
      base({ name: "Army", publicVp: 8, knightsPlayed: 3 }),
    ], { target: 10, devDeckLeft: 1 }).find((p) => p.name === "Me")!;
    // needs 3 knights to beat the leader but only 1 dev card left -> LA unreachable
    expect(me.largestArmyReachable).toBe(false);
    void blocked;
  });

  it("hidden VP counts toward the target (our VP cards exact, theirs estimated)", () => {
    // 12 public + 3 hidden = at the target in a 15-point game
    const me = analyzeVictory([base({ name: "Me", isYou: true, publicVp: 12, hiddenVp: 3 }), base({ name: "Opp", publicVp: 12 })], { target: 15, devDeckLeft: 10 });
    expect(me.find((p) => p.name === "Me")!.steps).toHaveLength(0); // already there
    expect(me[0].name).toBe("Me");
    // an opponent's estimated hidden VP shortens their gap and is labelled
    const opp = analyzeVictory([base({ name: "Opp", publicVp: 13, hiddenVp: 1 })], { target: 15, devDeckLeft: 10 })[0];
    expect(opp.planVp).toBe(1);
    expect(opp.summary).toMatch(/\+~1 hidden/);
  });

  it("a player already at the target dominates the probability", () => {
    const plans = analyzeVictory([
      base({ name: "Winner", publicVp: 10 }),
      base({ name: "Other", publicVp: 6 }),
    ], { target: 10, devDeckLeft: 20 });
    expect(plans[0].name).toBe("Winner");
    expect(plans[0].winProb).toBeGreaterThan(0.7);
  });
});
