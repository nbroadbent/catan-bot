import { RESOURCES, Resource, pips } from "../engine/types";
import { GameEvent, ResourceDelta } from "./events";

export interface PlayerState {
  name: string;
  color: string;
  /** best-known hand; may drift by ±uncertainty after unknown steals */
  hand: Record<Resource, number>;
  /** cards whose identity we couldn't determine (unknown steals) */
  uncertainty: number;
  settlements: number;
  cities: number;
  roads: number;
  devCards: number;
  knightsPlayed: number;
  /**
   * Learned production: for each rolled number, the resources this player
   * gained the LAST time it rolled (colonist tells us amounts, not tiles —
   * the latest observation reflects their current buildings).
   */
  incomeByNumber: Map<number, ResourceDelta>;
  /** best observed bank-trade ratio per resource (reveals ports) */
  bankRatio: Partial<Record<Resource, number>>;
  /** authoritative total card count from colonist itself (DOM panel / WS) */
  serverCards: number | null;
  /** authoritative public VP from the game state (buildings + army + road) */
  serverVp: number | null;
}

export interface TrackerState {
  players: Map<string, PlayerState>;
  /** the signed-in user's colonist name, from the page header */
  youName: string | null;
  rolls: number[];
  /** rolls since the last assumed balanced-deck reshuffle */
  rollsThisDeck: number[];
  lastRoll: { player: string; total: number } | null;
  gameOver: string | null | false;
  /** hand size above which a 7 forces a discard (colonist 1v1 default: 9) */
  discardLimit: number;
}

/**
 * Colonist's balanced dice draws from the 36 two-die combinations and (per
 * community observation) reshuffles before the deck fully empties so it never
 * becomes exactly countable. We assume a reshuffle after DECK_CYCLE rolls.
 */
export const DECK_CYCLE = 32;

export function createTracker(youName: string | null): TrackerState {
  return {
    players: new Map(),
    youName,
    rolls: [],
    rollsThisDeck: [],
    lastRoll: null,
    gameOver: false,
    discardLimit: 9,
  };
}

function emptyHand(): Record<Resource, number> {
  return Object.fromEntries(RESOURCES.map((r) => [r, 0])) as Record<Resource, number>;
}

function getPlayer(state: TrackerState, name: string, color = "#888"): PlayerState {
  let p = state.players.get(name);
  if (!p) {
    p = {
      name,
      color,
      hand: emptyHand(),
      uncertainty: 0,
      settlements: 0,
      cities: 0,
      roads: 0,
      devCards: 0,
      knightsPlayed: 0,
      incomeByNumber: new Map(),
      bankRatio: {},
      serverCards: null,
      serverVp: null,
    };
    state.players.set(name, p);
  }
  if (color !== "#888") p.color = color;
  return p;
}

/** Apply a delta; clamping at 0 converts contradictions into uncertainty. */
function applyDelta(p: PlayerState, delta: ResourceDelta): void {
  for (const [res, n] of Object.entries(delta)) {
    const r = res as Resource;
    const next = p.hand[r] + (n ?? 0);
    if (next < 0) {
      p.uncertainty += -next;
      p.hand[r] = 0;
    } else {
      p.hand[r] = next;
    }
  }
}

const COSTS: Record<"road" | "settlement" | "city" | "dev", ResourceDelta> = {
  road: { wood: -1, brick: -1 },
  settlement: { wood: -1, brick: -1, sheep: -1, wheat: -1 },
  city: { ore: -3, wheat: -2 },
  dev: { ore: -1, sheep: -1, wheat: -1 },
};

/** Resolve a possibly-null name ("you") to the signed-in player. */
function resolveYou(state: TrackerState, name: string | null): string | null {
  return name ?? state.youName;
}

export function applyEvent(state: TrackerState, ev: GameEvent): void {
  switch (ev.type) {
    case "ignored":
      break;

    case "game-over":
      state.gameOver = ev.winner;
      break;

    case "roll": {
      getPlayer(state, ev.player);
      state.rolls.push(ev.total);
      // Self-correcting deck: colonist's exact reshuffle rule isn't public.
      // If a total rolls when our count says the deck has none left, a
      // reshuffle must have happened — start a fresh deck at this roll.
      const full = ev.total === 7 ? 6 : pips(ev.total);
      const seen = state.rollsThisDeck.filter((t) => t === ev.total).length;
      if (seen >= full) state.rollsThisDeck = [];
      state.rollsThisDeck.push(ev.total);
      if (state.rollsThisDeck.length >= DECK_CYCLE) state.rollsThisDeck = [];
      state.lastRoll = { player: ev.player, total: ev.total };
      break;
    }

    case "got": {
      const p = getPlayer(state, ev.player);
      applyDelta(p, ev.resources);
      if (state.lastRoll) {
        p.incomeByNumber.set(state.lastRoll.total, { ...ev.resources });
      }
      break;
    }

    case "starting-resources": {
      const p = getPlayer(state, ev.player);
      applyDelta(p, ev.resources);
      break;
    }

    case "place": {
      const p = getPlayer(state, ev.player, ev.color);
      if (ev.what === "settlement") p.settlements++;
      if (ev.what === "city") p.cities++;
      if (ev.what === "road") p.roads++;
      break;
    }

    case "build": {
      const p = getPlayer(state, ev.player);
      applyDelta(p, COSTS[ev.what]);
      if (ev.what === "settlement") p.settlements++;
      if (ev.what === "road") p.roads++;
      if (ev.what === "city") {
        p.cities++;
        p.settlements = Math.max(0, p.settlements - 1);
      }
      break;
    }

    case "buy-dev": {
      const p = getPlayer(state, ev.player);
      applyDelta(p, COSTS.dev);
      p.devCards++;
      break;
    }

    case "bank-trade": {
      const p = getPlayer(state, ev.player);
      // learn port ratios: giving N of one resource for 1 card reveals N:1
      const gaveEntries = Object.entries(ev.delta).filter(([, v]) => (v ?? 0) < 0);
      if (gaveEntries.length === 1 && ev.took === 1) {
        const [res, v] = gaveEntries[0];
        const ratio = -(v ?? 0);
        const r = res as Resource;
        p.bankRatio[r] = Math.min(p.bankRatio[r] ?? 4, ratio);
      }
      applyDelta(p, ev.delta);
      break;
    }

    case "player-trade": {
      const p = getPlayer(state, ev.player);
      applyDelta(p, ev.delta);
      if (ev.partner) {
        const partner = getPlayer(state, ev.partner);
        const inverse: ResourceDelta = {};
        for (const [r, v] of Object.entries(ev.delta)) {
          inverse[r as Resource] = -(v ?? 0);
        }
        applyDelta(partner, inverse);
      }
      break;
    }

    case "steal-known": {
      const thief = resolveYou(state, ev.thief);
      const victim = resolveYou(state, ev.victim);
      if (thief) applyDelta(getPlayer(state, thief), { [ev.resource]: 1 });
      if (victim) applyDelta(getPlayer(state, victim), { [ev.resource]: -1 });
      break;
    }

    case "steal-unknown": {
      const thief = resolveYou(state, ev.thief);
      const victim = resolveYou(state, ev.victim);
      // identity unknown: both hands drift by one card
      if (thief) getPlayer(state, thief).uncertainty++;
      if (victim) {
        const v = getPlayer(state, victim);
        v.uncertainty++;
        // best effort: remove one card from their biggest pile
        const biggest = RESOURCES.reduce((a, b) => (v.hand[a] >= v.hand[b] ? a : b));
        if (v.hand[biggest] > 0) v.hand[biggest]--;
      }
      break;
    }

    case "monopoly-steal": {
      const p = getPlayer(state, ev.player);
      applyDelta(p, { [ev.resource]: ev.count });
      // everyone else loses all of that resource
      for (const other of state.players.values()) {
        if (other.name !== ev.player) other.hand[ev.resource] = 0;
      }
      break;
    }

    case "take-from-bank": {
      applyDelta(getPlayer(state, ev.player), ev.resources);
      break;
    }

    case "discard": {
      const p = getPlayer(state, ev.player);
      const inverse: ResourceDelta = {};
      for (const [r, v] of Object.entries(ev.resources)) {
        inverse[r as Resource] = -(v ?? 0);
      }
      applyDelta(p, inverse);
      break;
    }

    case "use-knight": {
      const p = getPlayer(state, ev.player);
      p.knightsPlayed++;
      p.devCards = Math.max(0, p.devCards - 1);
      break;
    }

    case "use-dev": {
      const p = getPlayer(state, ev.player);
      p.devCards = Math.max(0, p.devCards - 1);
      break;
    }

    case "move-robber":
    case "blocked-roll":
      break;
  }
}

/** Register a player known from WebSocket frames before they appear in the log. */
export function ensurePlayer(state: TrackerState, name: string, color = "#888"): void {
  getPlayer(state, name, color);
}

/** colonist card ids in player/bank states: 1..5 = wood,brick,sheep,wheat,ore */
const CARD_ID_TO_RESOURCE: Record<number, Resource> = {
  1: "wood",
  2: "brick",
  3: "sheep",
  4: "wheat",
  5: "ore",
};

export const RESOURCE_TO_CARD_ID: Record<Resource, number> = {
  wood: 1,
  brick: 2,
  sheep: 3,
  wheat: 4,
  ore: 5,
};

/**
 * Best-effort scan of a settings-ish frame for the game's discard limit —
 * colonist names it along the lines of cardDiscardLimit and the value varies
 * per game mode/settings (9 in 1v1, 7 in base).
 */
export function findDiscardLimit(payload: unknown, depth = 0): number | null {
  if (depth > 6 || payload === null || typeof payload !== "object") return null;
  for (const [k, v] of Object.entries(payload)) {
    if (/discard/i.test(k) && typeof v === "number" && Number.isInteger(v) && v >= 3 && v <= 30) {
      return v;
    }
    if (typeof v === "object" && v !== null) {
      const found = findDiscardLimit(v, depth + 1);
      if (found !== null) return found;
    }
  }
  return null;
}

/**
 * Ground truth from colonist's own player-state frames. YOUR resourceCards
 * are real card ids (you can see your hand), so your tracked hand is replaced
 * exactly; opponents get an authoritative total.
 */
export function applyServerPlayerState(
  state: TrackerState,
  entries: Array<{ username?: string; color?: number; resourceCards?: unknown }>,
  myColor: number | null,
): void {
  if (!Array.isArray(entries)) return;
  for (const entry of entries) {
    if (!entry?.username) continue;
    const p = getPlayer(state, entry.username);
    const cards = entry.resourceCards;
    if (!Array.isArray(cards)) continue;
    p.serverCards = cards.length;
    const isYou = myColor !== null && entry.color === myColor;
    if (isYou && cards.every((c) => typeof c === "number" && CARD_ID_TO_RESOURCE[c])) {
      const exact = Object.fromEntries(RESOURCES.map((r) => [r, 0])) as Record<Resource, number>;
      for (const c of cards as number[]) exact[CARD_ID_TO_RESOURCE[c]]++;
      p.hand = exact;
      p.uncertainty = 0;
    }
  }
}

export function handTotal(p: PlayerState): number {
  return RESOURCES.reduce((s, r) => s + p.hand[r], 0);
}

/**
 * Reconcile an opponent's estimated hand with colonist's authoritative card
 * TOTAL (serverCards). The log-derived estimate can only drift: a missed or
 * mis-parsed spend leaves phantom cards forever ("two sheep" when they hold
 * one). Over the total: trim from the biggest piles — the likeliest home of a
 * phantom card. Under the total: the gap is cards we never saw, surfaced as
 * uncertainty rather than invented. No-op without a server total.
 */
export function reconcileHandWithTotal(p: PlayerState): void {
  if (p.serverCards === null) return;
  let total = handTotal(p);
  while (total > p.serverCards) {
    const biggest = RESOURCES.reduce((a, b) => (p.hand[a] >= p.hand[b] ? a : b));
    if (p.hand[biggest] === 0) break;
    p.hand[biggest]--;
    total--;
  }
  p.uncertainty = Math.max(0, p.serverCards - total);
}

/**
 * Public victory points. Prefer colonist's authoritative count (buildings +
 * Largest Army + Longest Road) when the state has given it; otherwise fall
 * back to our building estimate. Hidden VP dev cards are not public.
 */
export function visibleVp(p: PlayerState): number {
  return p.serverVp ?? p.settlements + p.cities * 2;
}
