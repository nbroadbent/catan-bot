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

export type DomActionKind = "roll" | "end-turn" | "buy-dev";

/**
 * Colonist's instruction banner when YOU must move the robber. Anchored at
 * the start so an opponent's banner ("<name> is moving the robber…") and
 * passive mentions of the robber never match.
 */
export const MOVE_ROBBER_BANNER =
  /^(you (must|have to) )?((move|place|drop)( the)? robber|select .{0,20}robber)/i;

const PATTERNS: Record<DomActionKind, RegExp> = {
  roll: /dice|roll/i,
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
  const opts = { bubbles: true, cancelable: true, view: window } as const;
  el.dispatchEvent(new PointerEvent("pointerdown", opts));
  el.dispatchEvent(new MouseEvent("mousedown", opts));
  el.dispatchEvent(new PointerEvent("pointerup", opts));
  el.dispatchEvent(new MouseEvent("mouseup", opts));
  el.click();
}

/**
 * Attempt an action via the page UI. Returns a description of what was
 * clicked, or null if no plausible control was found.
 */
export function tryDomAction(kind: DomActionKind, doc: Document = document): string | null {
  const pattern = PATTERNS[kind];
  const candidates = doc.querySelectorAll<HTMLElement>(
    'button, [role="button"], img',
  );
  for (const el of candidates) {
    if (el.closest("[data-index]")) continue; // never click inside the log
    if (el.closest("#catan-copilot")) continue; // or our own panel
    const label = labelOf(el);
    if (!pattern.test(label)) continue;
    const clickable =
      el.closest<HTMLElement>('button, [role="button"]') ??
      (el.parentElement as HTMLElement | null) ??
      el;
    if (clickable.getBoundingClientRect().width === 0) continue; // hidden
    realClick(clickable);
    return label.slice(0, 60);
  }
  return null;
}
