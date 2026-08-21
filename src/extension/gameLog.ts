/**
 * Persistent per-game logs for later strategy analysis. Each finished game is
 * stored as one structured record (board, settings, the recommended strategy,
 * the full move list, and the outcome) so a Claude session can mine many games
 * to learn which strategies/openings/boards win.
 *
 * Stored three ways, most-to-least durable: localStorage archive (survives
 * reloads), a one-click JSON export, and — when the local bridge is running —
 * appended to .context/game-logs.jsonl on disk automatically.
 */
export interface GameLogMove {
  t: number;
  player: string | null;
  text: string;
  mine: boolean;
}

export interface GameLogPlayer {
  name: string;
  isYou: boolean;
  vp: number;
  cards: number;
  pips: number;
  devCards: number;
  knightsPlayed: number;
}

export interface GameLogTile {
  q: number;
  r: number;
  kind: string;
  token: number | null;
}

/** A building on the final board — for post-game placement analysis. */
export interface GameLogBuilding {
  player: string | null;
  kind: "settlement" | "city";
  /** e.g. "8-wheat + 6-ore + 5-sheep (13 pips, 2:1 ore port)" */
  label: string;
  pips: number;
}

export interface GameLog {
  version: string; // bot build that played this game
  at: string; // ISO end time
  durationMs: number | null;
  you: string | null;
  won: boolean;
  winner: string | null;
  playerCount: number;
  settings: {
    friendlyRobber: boolean;
    victoryPointsToWin: number | null;
    discardLimit: number;
  };
  recommendedStrategy: string | null;
  board: { tiles: GameLogTile[]; ports: string[] };
  finalPlayers: GameLogPlayer[];
  /** final board positions (absent in logs from builds before v1.3) */
  buildings?: GameLogBuilding[];
  moves: GameLogMove[];
}

const KEY = "catanCopilot:gamelogs";
const MAX_LOGS = 40;

export function loadGameLogs(): GameLog[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as GameLog[]) : [];
  } catch {
    return [];
  }
}

export function saveGameLog(log: GameLog): void {
  try {
    const all = loadGameLogs();
    all.push(log);
    localStorage.setItem(KEY, JSON.stringify(all.slice(-MAX_LOGS)));
  } catch {
    // storage full/unavailable — the export button + bridge still capture it
  }
}

export function gameLogsSummary(logs: GameLog[]): string | null {
  if (logs.length === 0) return null;
  const wins = logs.filter((l) => l.won).length;
  return `${logs.length} game${logs.length > 1 ? "s" : ""} logged, ${wins}W-${logs.length - wins}L`;
}
