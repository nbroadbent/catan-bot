/**
 * Learns colonist.io's outbound action-message formats automatically by
 * pairing each frame the PLAYER sends (playing manually) with the confirmed
 * effect that follows (a build event, a roll in the log, a turn change).
 *
 * Once an action kind has a learned template, autopilot can produce that
 * message itself: clone the template, substitute the coordinate slot, bump
 * whatever sequence counters the protocol uses.
 */

export type ActionKind =
  | "build-settlement"
  | "build-road"
  | "build-city"
  | "buy-dev"
  | "roll"
  | "end-turn"
  | "move-robber"
  | "discard"
  | "play-knight"
  | "play-monopoly"
  | "play-road-building"
  | "play-year-of-plenty"
  | "bank-trade";

export const ACTION_KINDS: ActionKind[] = [
  "build-settlement",
  "build-road",
  "build-city",
  "buy-dev",
  "roll",
  "end-turn",
  "move-robber",
  "discard",
  "play-knight",
  "play-monopoly",
  "play-road-building",
  "play-year-of-plenty",
  "bank-trade",
];

/** move-robber addresses a hexFace {x,y} (no z), unlike corners/edges. */
const HEXFACE_ACTIONS = new Set<ActionKind>(["move-robber"]);
/** discard carries an array of card ids (1..5) instead of a coordinate */
const CARDS_ACTIONS = new Set<ActionKind>(["discard"]);
const COORD_ACTIONS = new Set<ActionKind>([
  "build-settlement",
  "build-road",
  "build-city",
  "move-robber",
]);

interface Corner {
  x: number;
  y: number;
  z?: number;
}

interface LearnedTemplate {
  frame: unknown;
  /** JSON path to the {x,y,z} coordinate object, if this action has one */
  coordPath: string[] | null;
  /** JSON path to the card-id array (discard selections), if this action has one */
  cardsPath?: string[] | null;
  learnedAt: number;
}

interface SeqStat {
  last: number;
  seen: number;
  increasing: boolean;
}

const STORAGE_KEY = "catanCopilot:protocol";
const PAIR_WINDOW_MS = 5000;

function isCoordObject(v: unknown, hexFace: boolean): v is Corner {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Corner;
  if (!Number.isInteger(o.x) || !Number.isInteger(o.y)) return false;
  if (hexFace) {
    // a 2-key {x,y} (colonist also nests hexFace inside {hexFace:{x,y}})
    return o.z === undefined && Object.keys(v).length <= 3;
  }
  return Number.isInteger(o.z) && Object.keys(v).length <= 4;
}

/** depth-first search for the first coordinate-shaped object */
function findCoordPath(frame: unknown, hexFace: boolean, path: string[] = []): string[] | null {
  if (isCoordObject(frame, hexFace)) return path;
  if (Array.isArray(frame)) {
    for (let i = 0; i < frame.length; i++) {
      const found = findCoordPath(frame[i], hexFace, [...path, String(i)]);
      if (found) return found;
    }
  } else if (typeof frame === "object" && frame !== null) {
    for (const [k, v] of Object.entries(frame)) {
      const found = findCoordPath(v, hexFace, [...path, k]);
      if (found) return found;
    }
  }
  return null;
}

/** an array of colonist card ids — what a discard selection looks like */
function isCardIdArray(v: unknown): v is number[] {
  return (
    Array.isArray(v) &&
    v.length > 0 &&
    v.every((x) => Number.isInteger(x) && x >= 1 && x <= 5)
  );
}

/** depth-first search for the first card-id array */
function findCardsPath(frame: unknown, path: string[] = []): string[] | null {
  if (isCardIdArray(frame)) return path;
  if (Array.isArray(frame)) {
    for (let i = 0; i < frame.length; i++) {
      const found = findCardsPath(frame[i], [...path, String(i)]);
      if (found) return found;
    }
  } else if (typeof frame === "object" && frame !== null) {
    for (const [k, v] of Object.entries(frame)) {
      const found = findCardsPath(v, [...path, k]);
      if (found) return found;
    }
  }
  return null;
}

function getAtPath(obj: unknown, path: string[]): unknown {
  let cur = obj;
  for (const key of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

export class ProtocolLearner {
  templates: Partial<Record<ActionKind, LearnedTemplate>> = {};
  private outbox: Array<{ t: number; frame: unknown; used: boolean }> = [];
  /** stats for shallow integer fields, to find sequence counters */
  private seqStats = new Map<string, SeqStat>();

  recordOutbound(frame: unknown, t: number = Date.now()): void {
    this.outbox.push({ t, frame, used: false });
    if (this.outbox.length > 200) this.outbox.shift();
    this.trackSeqFields(frame);
  }

  private trackSeqFields(frame: unknown, prefix: string[] = [], depth = 0): void {
    if (depth > 2 || typeof frame !== "object" || frame === null || Array.isArray(frame)) return;
    for (const [k, v] of Object.entries(frame)) {
      if (typeof v === "number" && Number.isInteger(v)) {
        const key = [...prefix, k].join(".");
        const stat = this.seqStats.get(key);
        if (!stat) {
          this.seqStats.set(key, { last: v, seen: 1, increasing: true });
        } else {
          stat.increasing = stat.increasing && v > stat.last;
          stat.last = v;
          stat.seen++;
        }
      } else if (typeof v === "object" && v !== null && !Array.isArray(v)) {
        this.trackSeqFields(v, [...prefix, k], depth + 1);
      }
    }
  }

  /**
   * An action was confirmed (seen in the log / board events). Pair it with
   * the most recent unpaired outbound frame in the window; that frame is the
   * message that caused it. Later confirmations overwrite earlier templates,
   * so quality improves over a session.
   */
  confirm(kind: ActionKind, t: number = Date.now()): void {
    for (let i = this.outbox.length - 1; i >= 0; i--) {
      const o = this.outbox[i];
      if (o.used || o.t > t || t - o.t > PAIR_WINDOW_MS) continue;
      o.used = true;
      const wantsCoord = COORD_ACTIONS.has(kind);
      const coordPath = wantsCoord ? findCoordPath(o.frame, HEXFACE_ACTIONS.has(kind)) : null;
      if (wantsCoord && !coordPath) continue; // wrong frame (e.g. a heartbeat); keep looking
      const wantsCards = CARDS_ACTIONS.has(kind);
      const cardsPath = wantsCards ? findCardsPath(o.frame) : null;
      if (wantsCards && !cardsPath) continue;
      this.templates[kind] = {
        frame: JSON.parse(JSON.stringify(o.frame)),
        coordPath,
        cardsPath,
        learnedAt: t,
      };
      this.save();
      return;
    }
  }

  /** Produce a sendable frame for an action, or null if not learned yet. */
  buildFrame(kind: ActionKind, coord?: Corner, cards?: number[]): unknown | null {
    const tpl = this.templates[kind];
    if (!tpl) return null;
    const frame = JSON.parse(JSON.stringify(tpl.frame));
    if (tpl.cardsPath) {
      if (!cards || cards.length === 0) return null;
      if (tpl.cardsPath.length === 0) return [...cards]; // the frame IS the array
      const leaf = tpl.cardsPath[tpl.cardsPath.length - 1];
      const parent = getAtPath(frame, tpl.cardsPath.slice(0, -1));
      if (!parent || typeof parent !== "object") return null;
      (parent as Record<string, unknown>)[leaf] = [...cards];
    }
    if (tpl.coordPath) {
      if (!coord) return null;
      const target = getAtPath(frame, tpl.coordPath) as Corner | undefined;
      if (!target) return null;
      target.x = coord.x;
      target.y = coord.y;
      // preserve hexFace (2-key) vs corner/edge (3-key) shape of the template
      if ("z" in target && coord.z !== undefined) target.z = coord.z;
    }
    // bump sequence counters the protocol appears to use
    for (const [key, stat] of this.seqStats) {
      if (!stat.increasing || stat.seen < 3) continue;
      const path = key.split(".");
      const parent = path.length === 1 ? frame : getAtPath(frame, path.slice(0, -1));
      const leaf = path[path.length - 1];
      if (parent && typeof parent === "object" && typeof (parent as Record<string, unknown>)[leaf] === "number") {
        (parent as Record<string, number>)[leaf] = stat.last + 1;
        stat.last = stat.last + 1;
      }
    }
    return frame;
  }

  /** Self-correction: a template that produced no confirmed effect is wrong. */
  discard(kind: ActionKind): void {
    delete this.templates[kind];
    this.save();
  }

  status(): Record<ActionKind, boolean> {
    return Object.fromEntries(
      ACTION_KINDS.map((k) => [k, this.templates[k] !== undefined]),
    ) as Record<ActionKind, boolean>;
  }

  learnedCount(): number {
    return ACTION_KINDS.filter((k) => this.templates[k]).length;
  }

  save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.templates));
    } catch {
      // storage unavailable — templates stay session-only
    }
  }

  load(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) this.templates = JSON.parse(raw);
    } catch {
      // ignore corrupt storage
    }
  }
}
