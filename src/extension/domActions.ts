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

/**
 * Colonist's bottom-center action banner, which only appears on YOUR turn.
 * The text names the current phase: "Roll Dice" during the roll step, "Your
 * Turn" / "Build or Trade" during the main step. Any of them means it's our
 * turn — the single most reliable turn signal, independent of the WebSocket
 * turn-state color ids (which don't always match our detected color).
 */
export const YOUR_TURN_BANNER = /\b(your turn|roll dice|build or trade|trade or build)\b/i;

/** The roll step specifically — "Roll Dice" — so we roll rather than build. */
export const ROLL_BANNER = /\broll dice\b/i;

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

/**
 * Is colonist's roll control on screen and clickable? A visible roll/dice
 * BUTTON (not the post-roll result dice, which are plain <img> on the board)
 * means it's your turn and you still owe a roll — a turn signal independent of
 * the "Your Turn" banner text.
 */
export function rollPromptVisible(doc: Document = document): boolean {
  const controls = doc.querySelectorAll<HTMLElement>('button, [role="button"]');
  for (const el of controls) {
    if (el.closest("[data-index]") || el.closest("#catan-copilot")) continue;
    if (!PATTERNS.roll.test(labelOf(el))) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) return true;
  }
  return false;
}

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
  const attempt = (el: HTMLElement, allowText: boolean): string | null => {
    if (el.closest("[data-index]")) return null; // never click inside the log
    if (el.closest("#catan-copilot")) return null; // or our own panel
    if (el.matches('button:disabled, [aria-disabled="true"]')) return null;
    const text = (el.textContent ?? "").trim();
    const label = [labelOf(el), allowText && text.length <= 30 ? text : ""]
      .filter(Boolean)
      .join(" ");
    if (!pattern.test(label)) return null;
    const id = label.slice(0, 60);
    if (exclude?.has(id)) return null;
    const clickable =
      el.closest<HTMLElement>('button, [role="button"]') ??
      (el.parentElement as HTMLElement | null) ??
      el;
    const rect = clickable.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null; // hidden
    realClick(clickable);
    return id;
  };

  // 1) Labeled controls / images first: a labeled control is more likely the
  // true action than a bare matching image (e.g. the last roll's result dice).
  for (const el of [
    ...doc.querySelectorAll<HTMLElement>('button, [role="button"]'),
    ...doc.querySelectorAll<HTMLElement>("img"),
  ]) {
    const id = attempt(el, true);
    if (id) return id;
  }

  // 2) Text-matched banners: colonist's "Roll Dice" / action prompt is a
  // styled <div>, not a <button>. Scan leaf-ish elements whose own short text
  // matches, and click (events bubble to the real handler on an ancestor).
  for (const el of doc.querySelectorAll<HTMLElement>("div, span, a")) {
    if (el.children.length > 2) continue; // leaf-ish only, not a big container
    const text = (el.textContent ?? "").trim();
    if (text.length === 0 || text.length > 20) continue; // a short prompt
    const id = attempt(el, true);
    if (id) return id;
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
