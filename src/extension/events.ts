import { Resource } from "../engine/types";

/** A partial hand delta, e.g. { wood: 2, ore: -1 } */
export type ResourceDelta = Partial<Record<Resource, number>>;

/**
 * One parsed colonist.io game-log message. The parser turns DOM rows into
 * these; the tracker folds them into game state. Selectors and message text
 * follow colonist's live log format (see README for provenance).
 */
export type GameEvent =
  | { type: "roll"; player: string; total: number }
  | { type: "got"; player: string; resources: ResourceDelta }
  | { type: "starting-resources"; player: string; resources: ResourceDelta }
  | { type: "place"; player: string; color: string; what: "settlement" | "road" | "city" }
  | { type: "build"; player: string; what: "settlement" | "road" | "city" }
  | { type: "buy-dev"; player: string }
  | { type: "bank-trade"; player: string; delta: ResourceDelta; gave: number; took: number }
  | { type: "player-trade"; player: string; partner: string | null; delta: ResourceDelta }
  | { type: "steal-known"; thief: string | null; victim: string | null; resource: Resource }
  | { type: "steal-unknown"; thief: string | null; victim: string | null }
  | { type: "monopoly-steal"; player: string; resource: Resource; count: number }
  | { type: "take-from-bank"; player: string; resources: ResourceDelta }
  | { type: "discard"; player: string; resources: ResourceDelta }
  | { type: "use-knight"; player: string }
  | { type: "use-dev"; player: string; card: "year-of-plenty" | "road-building" | "monopoly" }
  | { type: "move-robber"; player: string }
  | { type: "blocked-roll"; total: number; resource: Resource }
  | { type: "game-over"; winner: string | null }
  | { type: "ignored" };
