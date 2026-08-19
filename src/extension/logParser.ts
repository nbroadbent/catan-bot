import { Resource } from "../engine/types";
import { GameEvent, ResourceDelta } from "./events";

/**
 * Colonist.io renders its game log with resource icons whose alt text uses
 * base-game names. Map them to our resource ids.
 */
const ALT_TO_RESOURCE: Record<string, Resource> = {
  grain: "wheat",
  wool: "sheep",
  lumber: "wood",
  brick: "brick",
  ore: "ore",
};

const RESOURCE_IMG_SELECTOR = Object.keys(ALT_TO_RESOURCE)
  .flatMap((a) => [`img[alt="${a}"]`, `img[alt="${cap(a)}"]`])
  .join(", ");

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function resourceFromAlt(alt: string | null): Resource | null {
  if (!alt) return null;
  return ALT_TO_RESOURCE[alt.toLowerCase()] ?? null;
}

/** First bold span = acting player (colonist styles names font-weight:600). */
export function getPlayerName(el: Element): string | null {
  const span = el.querySelector(
    'span[style*="font-weight:600"], span[style*="font-weight: 600"]',
  );
  return span?.textContent?.trim() || null;
}

export function getPlayerColor(el: Element): string {
  const span = el.querySelector<HTMLElement>(
    'span[style*="font-weight:600"], span[style*="font-weight: 600"]',
  );
  return span?.style.color || "#888";
}

function getSecondPlayerName(el: Element): string | null {
  const spans = el.querySelectorAll(
    'span[style*="font-weight:600"], span[style*="font-weight: 600"]',
  );
  return spans.length > 1 ? spans[1].textContent?.trim() || null : null;
}

function countResources(root: ParentNode): ResourceDelta {
  const out: ResourceDelta = {};
  root.querySelectorAll(RESOURCE_IMG_SELECTOR).forEach((img) => {
    const res = resourceFromAlt(img.getAttribute("alt"));
    if (res) out[res] = (out[res] ?? 0) + 1;
  });
  return out;
}

/** Split a row's HTML on a text marker and count resource icons in each part. */
function countAroundMarker(
  el: Element,
  marker: string,
): { before: ResourceDelta; after: ResourceDelta } | null {
  const html = el.innerHTML;
  const idx = html.indexOf(marker);
  if (idx === -1) return null;
  const mk = (fragment: string) => {
    const div = el.ownerDocument.createElement("div");
    div.innerHTML = fragment;
    return countResources(div);
  };
  return { before: mk(html.slice(0, idx)), after: mk(html.slice(idx + marker.length)) };
}

function sum(d: ResourceDelta): number {
  return Object.values(d).reduce((s, n) => s + (n ?? 0), 0);
}

function negate(d: ResourceDelta): ResourceDelta {
  const out: ResourceDelta = {};
  for (const [k, v] of Object.entries(d)) out[k as Resource] = -(v ?? 0);
  return out;
}

function merge(a: ResourceDelta, b: ResourceDelta): ResourceDelta {
  const out: ResourceDelta = { ...a };
  for (const [k, v] of Object.entries(b)) {
    out[k as Resource] = (out[k as Resource] ?? 0) + (v ?? 0);
  }
  return out;
}

function hasImg(el: Element, names: string[]): boolean {
  return names.some((n) =>
    el.querySelector(`img[alt="${n}"], img[alt="${cap(n)}"]`),
  );
}

/**
 * Parse one game-log row into a GameEvent. Mirrors the message taxonomy used
 * by open-source colonist card counters (see README), so text keywords and
 * icon alts match the live site.
 */
export function parseLogRow(el: Element): GameEvent {
  const text = el.textContent?.replace(/\s+/g, " ").trim() || "";
  const player = getPlayerName(el);

  if (
    !text ||
    text.includes("has disconnected") ||
    text.includes("has reconnected") ||
    text.includes("will take over") ||
    text.includes("left the game") ||
    text.includes("Learn how to play") ||
    el.querySelector("hr")
  ) {
    return { type: "ignored" };
  }

  if (text.includes("won the game")) {
    return { type: "game-over", winner: player };
  }

  if (text.includes("rolled")) {
    const dice = el.querySelectorAll('img[alt^="dice_"]');
    if (dice.length === 2 && player) {
      const total =
        parseInt(dice[0].getAttribute("alt")!.replace("dice_", ""), 10) +
        parseInt(dice[1].getAttribute("alt")!.replace("dice_", ""), 10);
      return { type: "roll", player, total };
    }
    return { type: "ignored" };
  }

  if (text.includes("blocked by the Robber")) {
    const probImg = el.querySelector('img[alt^="prob_"]');
    const tileImg = el.querySelector('img[alt$=" tile"]');
    const total = probImg
      ? parseInt(probImg.getAttribute("alt")!.replace("prob_", ""), 10)
      : NaN;
    const res = tileImg
      ? resourceFromAlt(tileImg.getAttribute("alt")!.replace(" tile", ""))
      : null;
    if (!Number.isNaN(total) && res) return { type: "blocked-roll", total, resource: res };
    return { type: "ignored" };
  }

  if (text.includes("received starting resources") && player) {
    return { type: "starting-resources", player, resources: countResources(el) };
  }

  if (text.includes("placed a") && player) {
    if (hasImg(el, ["settlement"])) {
      return { type: "place", player, color: getPlayerColor(el), what: "settlement" };
    }
    if (hasImg(el, ["road"])) {
      return { type: "place", player, color: getPlayerColor(el), what: "road" };
    }
    if (hasImg(el, ["city"])) {
      return { type: "place", player, color: getPlayerColor(el), what: "city" };
    }
  }

  if (text.includes("built a") && player) {
    if (hasImg(el, ["settlement"])) return { type: "build", player, what: "settlement" };
    if (hasImg(el, ["city"])) return { type: "build", player, what: "city" };
    if (hasImg(el, ["road"])) return { type: "build", player, what: "road" };
  }

  if (
    text.includes("bought") &&
    el.querySelector(
      'img[alt="development card"], img[alt="Development card"], img[alt="Development Card"]',
    ) &&
    player
  ) {
    return { type: "buy-dev", player };
  }

  if (text.includes("gave bank") && text.includes("took") && player) {
    const parts = countAroundMarker(el, " and took ");
    if (parts) {
      return {
        type: "bank-trade",
        player,
        delta: merge(negate(parts.before), parts.after),
        gave: sum(parts.before),
        took: sum(parts.after),
      };
    }
  }

  if (text.includes("gave") && text.includes("got") && text.includes("from")) {
    const html = el.innerHTML;
    const gotIdx = html.indexOf(" and got ");
    const fromIdx = html.lastIndexOf(" from ");
    if (gotIdx !== -1 && fromIdx > gotIdx && player) {
      const mk = (fragment: string) => {
        const div = el.ownerDocument.createElement("div");
        div.innerHTML = fragment;
        return countResources(div);
      };
      const gave = mk(html.slice(0, gotIdx));
      const got = mk(html.slice(gotIdx + " and got ".length, fromIdx));
      return {
        type: "player-trade",
        player,
        partner: getSecondPlayerName(el),
        delta: merge(negate(gave), got),
      };
    }
  }

  // Monopoly result: "X stole 5" + resource icon (check before generic steals)
  if (/stole \d+/.test(text) && player) {
    const res = countResources(el);
    const kind = (Object.keys(res) as Resource[])[0];
    const m = text.match(/stole (\d+)/);
    if (kind && m) {
      return { type: "monopoly-steal", player, resource: kind, count: parseInt(m[1], 10) };
    }
  }

  if (text.includes("stole") && text.includes("from")) {
    // "You stole ore from Alice" / "Bob stole wheat from you" / "Bob stole from Alice"
    const res = countResources(el);
    const kind = (Object.keys(res) as Resource[])[0] ?? null;
    const isYouThief = /^You stole/i.test(text);
    const isYouVictim = / from you/i.test(text);
    const first = player;
    const second = getSecondPlayerName(el);
    const thief = isYouThief ? null : first; // null = the signed-in user, resolved by tracker
    const victim = isYouVictim ? null : isYouThief ? first : second;
    if (kind) return { type: "steal-known", thief, victim, resource: kind };
    return { type: "steal-unknown", thief, victim };
  }

  if (text.includes("took from bank") && player) {
    return { type: "take-from-bank", player, resources: countResources(el) };
  }

  if (text.includes("discarded") && player) {
    return { type: "discard", player, resources: countResources(el) };
  }

  if (text.includes("used") && player) {
    if (text.includes("Knight")) return { type: "use-knight", player };
    if (text.includes("Year of Plenty")) return { type: "use-dev", player, card: "year-of-plenty" };
    if (text.includes("Road Building")) return { type: "use-dev", player, card: "road-building" };
    if (text.includes("Monopoly")) return { type: "use-dev", player, card: "monopoly" };
  }

  if (text.includes("moved Robber") && player) {
    return { type: "move-robber", player };
  }

  // Plain resource gain from a roll: "X got: [icons]"
  if (text.includes("got") && player) {
    const resources = countResources(el);
    if (sum(resources) > 0) return { type: "got", player, resources };
  }

  return { type: "ignored" };
}
