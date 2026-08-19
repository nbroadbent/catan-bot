// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from "vitest";
import { GameLog, gameLogsSummary, loadGameLogs, saveGameLog } from "./gameLog";

function makeLog(over: Partial<GameLog> = {}): GameLog {
  return {
    at: "2026-08-20T00:00:00.000Z",
    durationMs: 60000,
    you: "Nick",
    won: true,
    winner: "Nick",
    playerCount: 2,
    settings: { friendlyRobber: true, victoryPointsToWin: 10, discardLimit: 7 },
    recommendedStrategy: "Cities & Development",
    board: { tiles: [{ q: 0, r: 0, kind: "ore", token: 8 }], ports: ["2:1 ore"] },
    finalPlayers: [
      { name: "Nick", isYou: true, vp: 10, cards: 3, pips: 40, devCards: 1, knightsPlayed: 3 },
    ],
    moves: [{ t: 1, player: "Nick", text: "rolled 8", mine: true }],
    ...over,
  };
}

describe("game logs", () => {
  beforeEach(() => localStorage.clear());

  it("persists and reloads finished games", () => {
    saveGameLog(makeLog({ won: true }));
    saveGameLog(makeLog({ won: false, winner: "Ava" }));
    const logs = loadGameLogs();
    expect(logs).toHaveLength(2);
    expect(logs[0].recommendedStrategy).toBe("Cities & Development");
    expect(logs[0].moves[0].text).toBe("rolled 8");
    expect(logs[1].won).toBe(false);
  });

  it("caps the archive so storage never overflows", () => {
    for (let i = 0; i < 60; i++) saveGameLog(makeLog());
    expect(loadGameLogs().length).toBeLessThanOrEqual(40);
  });

  it("summarizes the win/loss record", () => {
    saveGameLog(makeLog({ won: true }));
    saveGameLog(makeLog({ won: true }));
    saveGameLog(makeLog({ won: false }));
    expect(gameLogsSummary(loadGameLogs())).toBe("3 games logged, 2W-1L");
    expect(gameLogsSummary([])).toBeNull();
  });
});
