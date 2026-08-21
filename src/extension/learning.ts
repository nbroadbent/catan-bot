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

export interface RecordStats {
  games: number;
  wins: number;
  losses: number;
  /** 0..1 */
  winRate: number;
  /** newest last, up to the last 10 results */
  recent: boolean[];
  /** current streak: positive = wins in a row, negative = losses in a row */
  streak: number;
  byStrategy: Array<{ strategyId: string; name: string; games: number; wins: number; winRate: number }>;
  byPlayers: Array<{ players: number; games: number; wins: number; winRate: number }>;
}

/** Win/loss statistics for the record card. Null when nothing is recorded. */
export function recordStats(records: GameRecord[]): RecordStats | null {
  if (records.length === 0) return null;
  const sorted = [...records].sort((a, b) => a.at - b.at);
  const wins = sorted.filter((r) => r.win).length;
  const recent = sorted.slice(-10).map((r) => r.win);
  let streak = 0;
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (sorted[i].win !== sorted[sorted.length - 1].win) break;
    streak++;
  }
  if (!sorted[sorted.length - 1].win) streak = -streak;
  const group = <K extends string | number>(key: (r: GameRecord) => K) => {
    const m = new Map<K, { games: number; wins: number }>();
    for (const r of sorted) {
      const g = m.get(key(r)) ?? { games: 0, wins: 0 };
      g.games++;
      if (r.win) g.wins++;
      m.set(key(r), g);
    }
    return m;
  };
  const byStrategy = [...group((r) => r.strategyId)]
    .map(([strategyId, g]) => ({
      strategyId,
      name: STRATEGIES.find((s) => s.id === strategyId)?.name ?? strategyId,
      ...g,
      winRate: g.wins / g.games,
    }))
    .sort((a, b) => b.games - a.games);
  const byPlayers = [...group((r) => r.players)]
    .map(([players, g]) => ({ players, ...g, winRate: g.wins / g.games }))
    .sort((a, b) => a.players - b.players);
  return {
    games: sorted.length,
    wins,
    losses: sorted.length - wins,
    winRate: wins / sorted.length,
    recent,
    streak,
    byStrategy,
    byPlayers,
  };
}

export function recordSummary(records: GameRecord[]): string | null {
  if (records.length === 0) return null;
  const wins = records.filter((r) => r.win).length;
  return `${records.length} game${records.length > 1 ? "s" : ""} recorded, ${wins}W-${records.length - wins}L — results feed back into strategy scores.`;
}
