/**
 * Zero-setup hands: click colonist's own UI buttons for the non-spatial
 * actions, so autopilot can act before any protocol template is learned.
 * Board placements can't be done this way (the board is a canvas with an
 * unknown pan/zoom) — those go through learned WebSocket templates.
 *
 * Selector strategy: colonist's markup shifts between releases, so instead of
 * exact selectors we scan clickable elements for images/labels matching each
 * action, excluding the chat log. Wrong matches are caught by autopilot's
 * confirmation gate.
 */

import { Resource } from "../engine/types";

export type DomActionKind = "roll" | "end-turn" | "buy-dev";

/**
 * Colonist's instruction banner when YOU must move the robber. Anchored at
 * the start so an opponent's banner ("<name> is moving the robber…") and
 * passive mentions of the robber never match.
 */
export const MOVE_ROBBER_BANNER =
  /^(you (must|have to) )?((move|place|drop)( the)? robber|select .{0,20}robber)/i;

/** Colonist's turn banner ("Your Turn", "It's your turn!") — DOM turn fallback. */
export const YOUR_TURN_BANNER = /\byour turn\b/i;

/**
 * Colonist's prompt when YOU must pick cards to discard after a 7. Anchored
 * so "waiting for <name> to discard" never matches; autopilot additionally
 * requires your hand to actually be over the limit before acting.
 */
export const DISCARD_BANNER = /^(select|choose).{0,25}discard|^discard (\d|cards|resources)/i;

const PATTERNS: Record<DomActionKind, RegExp> = {
  // (?<![a-z]) keeps "roll" from matching inside scroll/scrollbar class names.
  roll: /dice|(?<![a-z])roll/i,
  "end-turn": /end[_\s-]?turn|pass[_\s-]?turn|hourglass|fast[_\s-]?forward|skip/i,
  "buy-dev": /development|dev[_\s-]?card|card[_\s-]?back|buy[_\s-]?card/i,
};

function labelOf(el: Element): string {
  const img = el instanceof HTMLImageElement ? el : el.querySelector("img");
  return [
    el.getAttribute("aria-label"),
    el.getAttribute("title"),
    img?.getAttribute("alt"),
    img?.getAttribute("src"),
    el.id,
    el.className && typeof el.className === "string" ? el.className : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function realClick(el: HTMLElement): void {
  const opts = { bubbles: true, cancelable: true } as const;
  el.dispatchEvent(new PointerEvent("pointerdown", opts));
  el.dispatchEvent(new MouseEvent("mousedown", opts));
  el.dispatchEvent(new PointerEvent("pointerup", opts));
  el.dispatchEvent(new MouseEvent("mouseup", opts));
  el.click();
}

/**
 * Attempt an action via the page UI. Returns a label identifying what was
 * clicked, or null if no plausible control was found. Labels in `exclude`
 * (returned by an earlier attempt the game never confirmed) are skipped so a
 * retry reaches the next candidate instead of the same wrong element.
 */
export function tryDomAction(
  kind: DomActionKind,
  doc: Document = document,
  exclude?: ReadonlySet<string>,
): string | null {
  const pattern = PATTERNS[kind];
  // Real buttons first: a labeled control is more likely the true action than
  // a bare matching image (e.g. the dice showing the last roll's result).
  const candidates = [
    ...doc.querySelectorAll<HTMLElement>('button, [role="button"]'),
    ...doc.querySelectorAll<HTMLElement>("img"),
  ];
  for (const el of candidates) {
    if (el.closest("[data-index]")) continue; // never click inside the log
    if (el.closest("#catan-copilot")) continue; // or our own panel
    if (el.matches('button:disabled, [aria-disabled="true"]')) continue;
    const text = (el.textContent ?? "").trim();
    const label = [labelOf(el), text.length <= 30 ? text : ""].filter(Boolean).join(" ");
    if (!pattern.test(label)) continue;
    const id = label.slice(0, 60);
    if (exclude?.has(id)) continue;
    const clickable =
      el.closest<HTMLElement>('button, [role="button"]') ??
      (el.parentElement as HTMLElement | null) ??
      el;
    if (clickable.getBoundingClientRect().width === 0) continue; // hidden
    realClick(clickable);
    return id;
  }
  return null;
}

/** colonist's art names for resources differ from the engine's */
const RESOURCE_LABELS: Record<Resource, RegExp> = {
  wood: /lumber|wood/i,
  brick: /brick/i,
  sheep: /wool|sheep/i,
  wheat: /grain|wheat/i,
  ore: /ore/i,
};

/** The smallest container that mentions discarding and shows card images. */
function findDiscardDialog(doc: Document): HTMLElement | null {
  let best: HTMLElement | null = null;
  for (const el of doc.querySelectorAll<HTMLElement>("div, section, dialog")) {
    if (el.closest("[data-index]") || el.closest("#catan-copilot")) continue;
    const text = el.textContent ?? "";
    if (text.length > 300 || !/discard/i.test(text)) continue;
    if (!el.querySelector("img")) continue;
    if (!best || best.contains(el)) best = el; // prefer the deepest match
  }
  return best;
}

/**
 * Select cards in colonist's discard dialog and press its confirm control:
 * one click per card to give up, matched by resource art name, then the
 * dialog's confirm/discard button. Returns a description of what was clicked
 * or null if no dialog was found (autopilot's confirmation gate catches
 * wrong clicks).
 */
export function tryDomDiscard(
  cards: Partial<Record<Resource, number>>,
  doc: Document = document,
): string | null {
  const dialog = findDiscardDialog(doc);
  if (!dialog) return null;
  const used = new Set<Element>();
  let clicked = 0;
  for (const [res, n] of Object.entries(cards)) {
    const pattern = RESOURCE_LABELS[res as Resource];
    if (!pattern || !n) continue;
    const imgs = [...dialog.querySelectorAll<HTMLElement>("img")].filter(
      (el) => !used.has(el) && pattern.test(labelOf(el)),
    );
    for (let i = 0; i < n && i < imgs.length; i++) {
      used.add(imgs[i]);
      realClick(imgs[i].closest<HTMLElement>('button, [role="button"]') ?? imgs[i]);
      clicked++;
    }
  }
  if (clicked === 0) return null;
  const confirm = [...dialog.querySelectorAll<HTMLElement>('button, [role="button"], img')].find(
    (el) => {
      if (used.has(el)) return false;
      const label = `${labelOf(el)} ${(el.textContent ?? "").trim().slice(0, 30)}`;
      return /confirm|check|submit|\bok\b|✓|discard/i.test(label);
    },
  );
  if (confirm) realClick(confirm.closest<HTMLElement>('button, [role="button"]') ?? confirm);
  return `selected ${clicked} card${clicked === 1 ? "" : "s"}${confirm ? " + confirm" : ""}`;
}
