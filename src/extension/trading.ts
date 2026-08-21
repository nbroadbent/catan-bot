import { RESOURCES, Resource } from "../engine/types";

/** A player-trade offer as seen from our side. */
export interface TradeOffer {
  id: string;
  creator: number;
  /** what THEY give us */
  offered: Partial<Record<Resource, number>>;
  /** what they want FROM us */
  wanted: Partial<Record<Resource, number>>;
}

export type BuildCost = Partial<Record<Resource, number>>;

function shortfall(hand: Record<Resource, number>, cost: BuildCost): number {
  return RESOURCES.reduce((s, r) => s + Math.max(0, (cost[r] ?? 0) - hand[r]), 0);
}

/**
 * Answer a player-trade offer. Accept only when ALL hold:
 *  - we can pay it and it's at least 1:1 in cards (never give more than we get);
 *  - it brings the first build in our plan we can't yet afford strictly
 *    closer (fewer cards short), without breaking anything that build already
 *    had covered;
 *  - nothing we hand over is needed by that build.
 * Otherwise decline — quickly, so the table isn't held up by our timer.
 */
export function decideTradeResponse(
  hand: Record<Resource, number>,
  offer: Pick<TradeOffer, "offered" | "wanted">,
  plan: BuildCost[],
): { accept: boolean; reason: string } {
  const give = RESOURCES.reduce((s, r) => s + (offer.wanted[r] ?? 0), 0);
  const get = RESOURCES.reduce((s, r) => s + (offer.offered[r] ?? 0), 0);
  if (get === 0 || give === 0) return { accept: false, reason: "one-sided offer" };
  if (give > get) return { accept: false, reason: `worse than 1:1 (${give} for ${get})` };
  for (const r of RESOURCES) if ((offer.wanted[r] ?? 0) > hand[r]) return { accept: false, reason: `we don't have ${r}` };
  const after = { ...hand };
  for (const r of RESOURCES) after[r] = hand[r] - (offer.wanted[r] ?? 0) + (offer.offered[r] ?? 0);

  const target = plan.find((cost) => shortfall(hand, cost) > 0);
  if (!target) return { accept: false, reason: "nothing we're saving for" };
  const before = shortfall(hand, target);
  const post = shortfall(after, target);
  if (post >= before) return { accept: false, reason: "doesn't bring the next build closer" };
  for (const r of RESOURCES) {
    if ((offer.wanted[r] ?? 0) > 0 && (target[r] ?? 0) > 0 && after[r] < (target[r] ?? 0)) {
      return { accept: false, reason: `the build needs the ${r} they want` };
    }
  }
  return { accept: true, reason: `${before - post} card${before - post > 1 ? "s" : ""} closer to the next build` };
}
