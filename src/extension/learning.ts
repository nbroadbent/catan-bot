import { STRATEGIES } from "../engine/strategy";
import { RESOURCES } from "../engine/types";
import { TrackerState } from "./tracker";
import { expectedProduction } from "./copilot";

/**
 * Outcome feedback loop: every finished game records which strategy the
 * player's production most resembled and whether they won. Win/loss records
 * nudge future strategy scores (small, bounded effect).
 */

export interface GameRecord {
  at: number;
  win: boolean;
  strategyId: string;
  players: number;
}

const STORAGE_KEY = "catanCopilot:games";

export function loadRecords(): GameRecord[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
  } catch {
    return [];
  }
}

export function recordGameEnd(state: TrackerState): GameRecord | null {
  if (state.gameOver === false || !state.youName) return null;
  const you = state.players.get(state.youName);
  if (!you) return null;
  const prod = expectedProduction(you);
  let best = STRATEGIES[0];
  let bestScore = -Infinity;
  for (const s of STRATEGIES) {
    const score = RESOURCES.reduce((sum, r) => sum + prod[r] * s.weights[r], 0);
    if (score > bestScore) {
      bestScore = score;
      best = s;
    }
  }
  const rec: GameRecord = {
    at: Date.now(),
    win: state.gameOver === state.youName,
    strategyId: best.id,
    players: state.players.size,
  };
  try {
    const all = loadRecords();
    all.push(rec);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all.slice(-100)));
  } catch {
    // storage unavailable
  }
  return rec;
}

/** Multiplier per strategy id from past results: bounded to ±15%. */
export function strategyPriors(records: GameRecord[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of STRATEGIES) {
    const rel = records.filter((r) => r.strategyId === s.id);
    const wins = rel.filter((r) => r.win).length;
    const losses = rel.length - wins;
    const nudge = (0.08 * (wins - losses)) / Math.max(3, rel.length);
    out[s.id] = Math.min(1.15, Math.max(0.85, 1 + nudge));
  }
  return out;
}

export function recordSummary(records: GameRecord[]): string | null {
  if (records.length === 0) return null;
  const wins = records.filter((r) => r.win).length;
  return `${records.length} game${records.length > 1 ? "s" : ""} recorded, ${wins}W-${records.length - wins}L — results feed back into strategy scores.`;
}
