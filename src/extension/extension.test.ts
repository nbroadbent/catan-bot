// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { parseLogRow } from "./logParser";
import { applyEvent, createTracker, visibleVp, TrackerState } from "./tracker";
import {
  deckStatus,
  expectedProduction,
  isOneVsOne,
  nextMoves,
  productionTotal,
  rankLiveStrategies,
  robberAdvice,
  tradeTips,
} from "./copilot";

/** Build a colonist-style log row (structure copied from live-site parsers). */
function row(html: string, index = 0): HTMLElement {
  const el = document.createElement("div");
  el.setAttribute("data-index", String(index));
  el.innerHTML = html;
  return el;
}

const bold = (name: string, color = "#e27174") =>
  `<span style="font-weight:600; color:${color}">${name}</span>`;
const img = (alt: string) => `<img alt="${alt}" src="x.svg">`;

describe("logParser", () => {
  it("parses dice rolls from dice_N image alts", () => {
    const ev = parseLogRow(row(`${bold("Nick")} rolled ${img("dice_3")}${img("dice_5")}`));
    expect(ev).toEqual({ type: "roll", player: "Nick", total: 8 });
  });

  it("parses resource gains with counts", () => {
    const ev = parseLogRow(
      row(`${bold("Nick")} got: ${img("lumber")}${img("lumber")}${img("grain")}`),
    );
    expect(ev).toEqual({ type: "got", player: "Nick", resources: { wood: 2, wheat: 1 } });
  });

  it("parses starting resources", () => {
    const ev = parseLogRow(
      row(`${bold("Ava")} received starting resources: ${img("brick")}${img("wool")}${img("ore")}`),
    );
    expect(ev).toEqual({
      type: "starting-resources",
      player: "Ava",
      resources: { brick: 1, sheep: 1, ore: 1 },
    });
  });

  it("parses placements and builds", () => {
    expect(parseLogRow(row(`${bold("Ava")} placed a ${img("settlement")}`))).toMatchObject({
      type: "place",
      player: "Ava",
      what: "settlement",
    });
    expect(parseLogRow(row(`${bold("Ava")} built a ${img("city")}`))).toEqual({
      type: "build",
      player: "Ava",
      what: "city",
    });
    expect(parseLogRow(row(`${bold("Ava")} built a ${img("road")}`))).toEqual({
      type: "build",
      player: "Ava",
      what: "road",
    });
  });

  it("parses dev card purchases", () => {
    expect(
      parseLogRow(row(`${bold("Nick")} bought a ${img("development card")}`)),
    ).toEqual({ type: "buy-dev", player: "Nick" });
  });

  it("parses bank trades and learns the ratio", () => {
    const ev = parseLogRow(
      row(`${bold("Nick")} gave bank ${img("ore")}${img("ore")}${img("ore")}${img("ore")} and took ${img("grain")}`),
    );
    expect(ev).toMatchObject({
      type: "bank-trade",
      player: "Nick",
      delta: { ore: -4, wheat: 1 },
      gave: 4,
      took: 1,
    });
  });

  it("parses player trades symmetrically", () => {
    const ev = parseLogRow(
      row(`${bold("Nick")} gave ${img("lumber")} and got ${img("ore")}${img("ore")} from ${bold("Ava", "#223697")}`),
    );
    expect(ev).toEqual({
      type: "player-trade",
      player: "Nick",
      partner: "Ava",
      delta: { wood: -1, ore: 2 },
    });
  });

  it("parses known and unknown steals, including 'you' forms", () => {
    expect(
      parseLogRow(row(`${bold("Ava")} stole ${img("grain")} from you`)),
    ).toEqual({ type: "steal-known", thief: "Ava", victim: null, resource: "wheat" });

    expect(parseLogRow(row(`You stole ${img("ore")} from ${bold("Ava")}`))).toEqual({
      type: "steal-known",
      thief: null,
      victim: "Ava",
      resource: "ore",
    });

    expect(
      parseLogRow(row(`${bold("Ava")} stole from ${bold("Marco", "#62b95d")}`)),
    ).toEqual({ type: "steal-unknown", thief: "Ava", victim: "Marco" });
  });

  it("parses monopoly steals before generic steals", () => {
    expect(
      parseLogRow(row(`${bold("Marco")} stole 5 ${img("wool")}`)),
    ).toEqual({ type: "monopoly-steal", player: "Marco", resource: "sheep", count: 5 });
  });

  it("parses discards, knights and game over", () => {
    expect(
      parseLogRow(row(`${bold("Nick")} discarded ${img("brick")}${img("brick")}`)),
    ).toEqual({ type: "discard", player: "Nick", resources: { brick: 2 } });
    expect(parseLogRow(row(`${bold("Nick")} used ${img("knight")} Knight`))).toEqual({
      type: "use-knight",
      player: "Nick",
    });
    expect(parseLogRow(row(`${bold("Ava")} won the game!`))).toEqual({
      type: "game-over",
      winner: "Ava",
    });
  });

  it("ignores noise rows", () => {
    expect(parseLogRow(row(`Somebody has disconnected`)).type).toBe("ignored");
    expect(parseLogRow(row(`Learn how to play in the rulebook`)).type).toBe("ignored");
  });
});

/** Replay a small synthetic game as Nick and return the tracker. */
function replayGame(): TrackerState {
  const t = createTracker("Nick");
  const rows: HTMLElement[] = [
    row(`${bold("Nick")} placed a ${img("settlement")}`, 1),
    row(`${bold("Ava", "#223697")} placed a ${img("settlement")}`, 2),
    row(`${bold("Nick")} received starting resources: ${img("ore")}${img("grain")}${img("grain")}`, 3),
    row(`${bold("Ava", "#223697")} received starting resources: ${img("lumber")}${img("brick")}${img("wool")}`, 4),
    // rolls teaching income tables
    row(`${bold("Nick")} rolled ${img("dice_4")}${img("dice_4")}`, 5),
    row(`${bold("Nick")} got: ${img("ore")}${img("ore")}`, 6),
    row(`${bold("Ava", "#223697")} rolled ${img("dice_2")}${img("dice_4")}`, 7),
    row(`${bold("Nick")} got: ${img("grain")}${img("grain")}`, 8),
    row(`${bold("Ava", "#223697")} got: ${img("lumber")}`, 9),
    row(`${bold("Nick")} rolled ${img("dice_1")}${img("dice_4")}`, 10),
    row(`${bold("Ava", "#223697")} got: ${img("brick")}${img("brick")}`, 11),
    // builds and trades
    row(`${bold("Nick")} bought a ${img("development card")}`, 12),
    row(`${bold("Ava", "#223697")} built a ${img("road")}`, 13),
    row(`${bold("Nick")} gave bank ${img("grain")}${img("grain")}${img("grain")}${img("grain")} and took ${img("wool")}`, 14),
  ];
  for (const r of rows) applyEvent(t, parseLogRow(r));
  return t;
}

describe("tracker", () => {
  it("tracks hands through rolls, builds and trades", () => {
    const t = replayGame();
    const nick = t.players.get("Nick")!;
    const ava = t.players.get("Ava")!;

    // Nick: started ore+2wheat, got 2 ore + 2 wheat, dev card cost ore+sheep+wheat
    // (sheep clamped -> uncertainty), bank-traded 4 wheat (only 3 left -> clamp)
    expect(nick.hand.ore).toBe(2);
    expect(nick.devCards).toBe(1);
    expect(nick.uncertainty).toBeGreaterThan(0);
    expect(ava.hand.wood).toBe(1); // 2 - road cost
    expect(ava.hand.brick).toBe(2); // 1 + 2 - road cost
    expect(ava.roads).toBe(1);
    expect(visibleVp(ava)).toBe(1);
  });

  it("learns per-number income tables", () => {
    const t = replayGame();
    const nick = t.players.get("Nick")!;
    expect(nick.incomeByNumber.get(8)).toEqual({ ore: 2 });
    expect(nick.incomeByNumber.get(6)).toEqual({ wheat: 2 });
    const ava = t.players.get("Ava")!;
    expect(ava.incomeByNumber.get(5)).toEqual({ brick: 2 });
  });

  it("learns port ratios from bank trades", () => {
    const t = createTracker("Nick");
    applyEvent(t, parseLogRow(row(`${bold("Nick")} got: ${img("wool")}${img("wool")}`, 1)));
    applyEvent(
      t,
      parseLogRow(row(`${bold("Nick")} gave bank ${img("wool")}${img("wool")} and took ${img("ore")}`, 2)),
    );
    expect(t.players.get("Nick")!.bankRatio.sheep).toBe(2);
  });

  it("resolves 'you' in steals to the signed-in player", () => {
    const t = createTracker("Nick");
    applyEvent(t, parseLogRow(row(`${bold("Nick")} got: ${img("grain")}`, 1)));
    applyEvent(t, parseLogRow(row(`${bold("Ava")} stole ${img("grain")} from you`, 2)));
    expect(t.players.get("Nick")!.hand.wheat).toBe(0);
    expect(t.players.get("Ava")!.hand.wheat).toBe(1);
  });
});

describe("copilot", () => {
  it("counts the balanced-dice deck down", () => {
    const t = createTracker("Nick");
    for (const total of [8, 8, 8, 8, 8]) {
      applyEvent(t, { type: "roll", player: "Nick", total });
    }
    const deck = deckStatus(t);
    expect(deck.remaining.get(8)).toBe(0);
    expect(deck.cold).toContain(8);
    expect(deck.prob.get(8)).toBe(0);
    // 7 becomes relatively over-due as the deck thins
    expect(deck.totalRemaining).toBe(31);
  });

  it("computes expected production from learned income", () => {
    const t = replayGame();
    const nick = t.players.get("Nick")!;
    const prod = expectedProduction(nick);
    // 8 pays 2 ore (5/36), 6 pays 2 wheat (5/36)
    expect(prod.ore).toBeCloseTo((5 / 36) * 2);
    expect(prod.wheat).toBeCloseTo((5 / 36) * 2);
    expect(productionTotal(prod)).toBeGreaterThan(0.5 / 36);
  });

  it("recommends city-dev for an ore+wheat income profile", () => {
    const t = replayGame();
    const fits = rankLiveStrategies(t, "Nick");
    expect(fits.length).toBe(4);
    const ids = fits.map((f) => f.strategy.id);
    expect(ids.indexOf("city-dev")).toBeLessThan(ids.indexOf("road-expand"));
    expect(fits[0].simVp).toBeGreaterThanOrEqual(0);
  });

  it("advises robbing the biggest threat with a concrete block", () => {
    const t = replayGame();
    const advice = robberAdvice(t)!;
    expect(advice.target).toBe("Ava");
    expect(advice.reason).toContain("Ava");
  });

  it("produces actionable trade tips", () => {
    const t = replayGame();
    const fits = rankLiveStrategies(t, "Nick");
    const tips = tradeTips(t, "Nick", fits[0]);
    expect(tips.length).toBeGreaterThan(0);
  });

  it("handles a player with no history gracefully", () => {
    const t = createTracker(null);
    expect(rankLiveStrategies(t, "Ghost")).toEqual([]);
    expect(robberAdvice(t)).toBeNull();
    expect(deckStatus(t).totalRemaining).toBe(36);
  });

  it("self-corrects the deck when an exhausted number rolls (reshuffle)", () => {
    const t = createTracker("Nick");
    // draw all five 8s, then an impossible sixth 8 -> deck must have reshuffled
    for (let i = 0; i < 5; i++) applyEvent(t, { type: "roll", player: "Nick", total: 8 });
    expect(deckStatus(t).remaining.get(8)).toBe(0);
    applyEvent(t, { type: "roll", player: "Nick", total: 8 });
    const deck = deckStatus(t);
    expect(deck.remaining.get(8)).toBe(4); // fresh deck minus this roll
    expect(deck.rollsIntoDeck).toBe(1);
  });

  it("detects 1v1 and suppresses player-trade advice", () => {
    const t = replayGame(); // two players
    expect(isOneVsOne(t)).toBe(true);
    const fits = rankLiveStrategies(t, "Nick");
    const tips = tradeTips(t, "Nick", fits[0]);
    for (const tip of tips) {
      expect(tip.text).not.toContain("other players");
      expect(tip.text).not.toMatch(/offer \w+ or/);
    }
  });

  it("notes friendly robber for sub-3-VP targets and blocks by need", () => {
    const t = replayGame(); // Ava has 1 visible VP
    const advice = robberAdvice(t)!;
    expect(advice.reason).toContain("friendly robber");
    expect(advice.reason).toContain("Block their 5"); // Ava's only income number
  });

  it("plans concrete next moves from the hand", () => {
    const t = createTracker("Nick");
    applyEvent(t, parseLogRow(row(`${bold("Nick")} placed a ${img("settlement")}`, 1)));
    // give Nick a city in hand: 3 ore + 2 wheat, plus ore/wheat income history
    applyEvent(t, parseLogRow(row(`${bold("Nick")} rolled ${img("dice_4")}${img("dice_4")}`, 2)));
    applyEvent(
      t,
      parseLogRow(row(`${bold("Nick")} got: ${img("ore")}${img("ore")}${img("ore")}${img("grain")}${img("grain")}`, 3)),
    );
    const fits = rankLiveStrategies(t, "Nick");
    const moves = nextMoves(t, "Nick", fits[0], null);
    expect(moves.some((m) => m.primary && /city/i.test(m.text))).toBe(true);
  });

  it("redirects to roads when a settlement is affordable but unplaceable", () => {
    const t = createTracker("Nick");
    applyEvent(t, parseLogRow(row(`${bold("Nick")} placed a ${img("settlement")}`, 1)));
    applyEvent(t, parseLogRow(row(`${bold("Nick")} rolled ${img("dice_2")}${img("dice_4")}`, 2)));
    applyEvent(
      t,
      parseLogRow(row(`${bold("Nick")} got: ${img("lumber")}${img("brick")}${img("wool")}${img("grain")}`, 3)),
    );
    const fits = rankLiveStrategies(t, "Nick");
    const moves = nextMoves(t, "Nick", fits[0], {
      canPlaceSettlement: false,
      bestSpotLabel: "8-wood + 6-brick (9 pips)",
      hasRoadSuggestion: true,
      cityUpgradeLabel: null,
    });
    expect(moves.some((m) => /nowhere legal/.test(m.text))).toBe(true);
  });

  it("plans discards for an oversized hand", () => {
    const t = createTracker("Nick");
    applyEvent(t, parseLogRow(row(`${bold("Nick")} placed a ${img("settlement")}`, 1)));
    applyEvent(t, parseLogRow(row(`${bold("Nick")} rolled ${img("dice_4")}${img("dice_4")}`, 2)));
    applyEvent(
      t,
      parseLogRow(
        row(
          `${bold("Nick")} got: ${img("wool")}${img("wool")}${img("wool")}${img("wool")}${img("wool")}${img("ore")}${img("ore")}${img("ore")}${img("grain")}${img("grain")}`,
          3,
        ),
      ),
    );
    const fits = rankLiveStrategies(t, "Nick");
    const moves = nextMoves(t, "Nick", fits[0], null);
    const discard = moves.find((m) => /discard/i.test(m.text));
    expect(discard).toBeDefined();
    expect(discard!.text).toContain("sheep"); // surplus beyond the next build
  });
});

describe("overlay", () => {
  it("renders all copilot sections into the page", async () => {
    const { Overlay } = await import("./overlay");
    const overlay = new Overlay(document);
    overlay.render(replayGame());

    const root = document.getElementById("catan-copilot")!;
    expect(root).toBeTruthy();
    const text = root.textContent!;
    expect(text).toContain("Balanced-dice deck");
    expect(text).toContain("Players");
    expect(text).toContain("Your strategy");
    expect(text).toContain("RECOMMENDED");
    expect(text).toContain("Robber");
    expect(text).toContain("Nick");
    expect(text).toContain("Ava");
    root.remove();
  });

  it("escapes hostile player names", async () => {
    const { Overlay } = await import("./overlay");
    const overlay = new Overlay(document);
    const t = createTracker("Nick");
    applyEvent(t, {
      type: "got",
      player: '<img src=x onerror="alert(1)">',
      resources: { wood: 1 },
    });
    overlay.render(t);
    const root = document.getElementById("catan-copilot")!;
    expect(root.querySelector('img[src="x"]')).toBeNull();
    root.remove();
  });

  it("renders a move history newest-first, marking our moves", async () => {
    const { Overlay } = await import("./overlay");
    let downloaded = false;
    const overlay = new Overlay(document, {
      getHistory: () => [
        { t: 1, player: "Ava", text: "rolled 8", mine: false },
        { t: 2, player: "Nick", text: "built a settlement", mine: true },
      ],
      onDownloadHistory: () => {
        downloaded = true;
      },
    });
    overlay.render(replayGame());
    const root = document.getElementById("catan-copilot")!;
    const box = root.querySelector(".cc-hist")!;
    expect(box).toBeTruthy();
    const rows = [...box.querySelectorAll(".row")];
    expect(rows).toHaveLength(2);
    // newest first
    expect(rows[0].textContent).toContain("built a settlement");
    expect(rows[1].textContent).toContain("rolled 8");
    // our move is marked
    expect(rows[0].classList.contains("mine")).toBe(true);
    // the save button downloads
    (root.querySelector('[data-act="download-history"]') as HTMLButtonElement).click();
    expect(downloaded).toBe(true);
    root.remove();
  });
});
