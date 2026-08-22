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
 * Answer a player-trade offer by its effect on OUR plan, not by card count.
 * Score = shortfall reduction across the first two builds we're saving for,
 * where the first build counts double. Accept when:
 *  - we can pay it and it's fair: never give more cards than we get, EXCEPT
 *    a 2-for-1 that completes our next build this turn while we're holding
 *    a large hand (the extra card would have been a discard anyway);
 *  - it brings the plan strictly closer (score > 0);
 *  - nothing we hand over is needed by the first build (or by the second when
 *    we don't have a spare);
 *  - the card we receive isn't one we already hold a surplus of.
 * Otherwise decline — promptly, so the table isn't held up by our timer.
 */
export function decideTradeResponse(
  hand: Record<Resource, number>,
  offer: Pick<TradeOffer, "offered" | "wanted">,
  plan: BuildCost[],
  handLimit = 7,
): { accept: boolean; reason: string } {
  const give = RESOURCES.reduce((s, r) => s + (offer.wanted[r] ?? 0), 0);
  const get = RESOURCES.reduce((s, r) => s + (offer.offered[r] ?? 0), 0);
  if (get === 0 || give === 0) return { accept: false, reason: "one-sided offer" };
  for (const r of RESOURCES) if ((offer.wanted[r] ?? 0) > hand[r]) return { accept: false, reason: `we don't have ${r}` };
  const after = { ...hand };
  for (const r of RESOURCES) after[r] = hand[r] - (offer.wanted[r] ?? 0) + (offer.offered[r] ?? 0);

  const targets = plan.filter((cost) => shortfall(hand, cost) > 0).slice(0, 2);
  if (targets.length === 0) return { accept: false, reason: "nothing we're saving for" };
  const [first, second] = targets;
  const handSize = RESOURCES.reduce((s, r) => s + hand[r], 0);

  // fairness: ≤1:1, or a 2:1 that finishes the first build from a big hand
  const completesFirst = shortfall(after, first) === 0;
  if (give > get && !(give - get === 1 && completesFirst && handSize >= handLimit)) {
    return { accept: false, reason: `worse than 1:1 (${give} for ${get})` };
  }
  // never give what the first build needs; the second only if we keep a spare
  for (const r of RESOURCES) {
    const g = offer.wanted[r] ?? 0;
    if (g === 0) continue;
    if ((first[r] ?? 0) > 0 && after[r] < (first[r] ?? 0)) return { accept: false, reason: `the next build needs the ${r} they want` };
    if (second && (second[r] ?? 0) > 0 && after[r] < (second[r] ?? 0) && hand[r] - g < (first[r] ?? 0) + (second[r] ?? 0)) {
      return { accept: false, reason: `we'd be short of ${r} for the build after` };
    }
  }
  // don't take cards we already have in surplus of both builds
  for (const r of RESOURCES) {
    const got = offer.offered[r] ?? 0;
    if (got > 0 && hand[r] >= (first[r] ?? 0) + (second?.[r] ?? 0) && hand[r] >= 2) {
      return { accept: false, reason: `we already hold enough ${r}` };
    }
  }
  const score = 2 * (shortfall(hand, first) - shortfall(after, first)) + (second ? shortfall(hand, second) - shortfall(after, second) : 0);
  if (score <= 0) return { accept: false, reason: "doesn't bring the plan closer" };
  return { accept: true, reason: completesFirst ? "completes the next build" : `${score > 2 ? "much " : ""}closer to the next builds` };
}

/** A trade we'd like to propose: give `offered`, ask `wanted` (1:1 by default). */
export interface TradeProposal {
  offered: Partial<Record<Resource, number>>;
  wanted: Partial<Record<Resource, number>>;
  reason: string;
}

/**
 * Propose a player trade when it's worth asking. Proposals are free to make
 * and players accept fair ones often, so ask whenever our next build is
 * short by ONE or TWO cards and we hold surplus (2+) of something it doesn't
 * need: offer 1 surplus for 1 needed (one proposal per missing card). Near
 * the discard limit, sweeten to 2-for-1 — those cards were a discard risk.
 * `alreadyAsked` lets the executor rotate through candidates (max 2/turn).
 */
export function proposeTrade(
  hand: Record<Resource, number>,
  plan: BuildCost[],
  weights: Record<Resource, number>,
  opts: { alreadyAsked?: Resource[]; handLimit?: number } = {},
): TradeProposal | null {
  const target = plan.find((cost) => shortfall(hand, cost) > 0);
  if (!target) return null;
  const short = shortfall(hand, target);
  if (short > 2) return null;
  const needs = RESOURCES.filter((r) => (target[r] ?? 0) > hand[r] && !(opts.alreadyAsked ?? []).includes(r));
  const need = needs[0];
  if (!need) return null;
  const surplus = RESOURCES.filter((r) => r !== need && hand[r] - (target[r] ?? 0) >= 2)
    .sort((a, b) => weights[a] - weights[b]); // give away the least-valued first
  if (surplus.length === 0) return null;
  const handSize = RESOURCES.reduce((s, r) => s + hand[r], 0);
  const sweeten = handSize >= (opts.handLimit ?? 7) - 1 && hand[surplus[0]] - (target[surplus[0]] ?? 0) >= 3;
  return {
    offered: { [surplus[0]]: sweeten ? 2 : 1 },
    wanted: { [need]: 1 },
    reason: `${sweeten ? 2 : 1} ${surplus[0]} for the ${need} our next build is short of`,
  };
}
