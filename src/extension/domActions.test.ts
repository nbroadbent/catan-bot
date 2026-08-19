// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from "vitest";
import { tryDomAction, tryDomDiscard } from "./domActions";
import { Autopilot } from "./autopilot";
import { ProtocolLearner } from "./protocolLearner";
import { createTracker, ensurePlayer } from "./tracker";

// jsdom has no PointerEvent; realClick dispatches them.
(globalThis as { PointerEvent?: typeof MouseEvent }).PointerEvent ??= MouseEvent;

// jsdom does no layout, so every rect is 0×0 — pretend elements are visible.
beforeEach(() => {
  document.body.innerHTML = "";
  HTMLElement.prototype.getBoundingClientRect = () =>
    ({ width: 100, height: 40, top: 0, left: 0, right: 100, bottom: 40, x: 0, y: 0 }) as DOMRect;
});

describe("tryDomAction: roll", () => {
  it("never mistakes scroll controls for the roll button", () => {
    document.body.innerHTML = `
      <button class="scroll-to-bottom-button" id="scroll"></button>
      <div class="scrollbar-thumb" role="button" id="thumb"></div>
      <div role="button" id="dice"><img src="/dist/images/dice.svg" alt=""></div>`;
    const clicks: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>("[id]")) {
      el.addEventListener("click", () => clicks.push(el.id));
    }
    const label = tryDomAction("roll", document);
    expect(label).toMatch(/dice/);
    expect(clicks).toEqual(["dice"]);
  });

  it("matches a button labeled only by its text", () => {
    document.body.innerHTML = `<button id="b">Roll</button>`;
    expect(tryDomAction("roll", document)).toMatch(/\bRoll\b/);
  });

  it("prefers a real button over a bare dice image", () => {
    document.body.innerHTML = `
      <img src="/img/dice_result_3.png" id="display">
      <button aria-label="Roll the dice" id="btn"></button>`;
    const clicks: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>("[id]")) {
      el.addEventListener("click", () => clicks.push(el.id));
    }
    tryDomAction("roll", document);
    expect(clicks).toEqual(["btn"]);
  });

  it("clicks colonist's 'Roll Dice' text banner (a styled div, not a button)", () => {
    // The real banner: an icon + the phase text + a countdown, no button role.
    document.body.innerHTML = `
      <div id="banner">
        <div class="player-icon"></div>
        <span id="label">Roll Dice</span>
        <span class="timer">00:06</span>
      </div>`;
    const clicks: string[] = [];
    document.getElementById("banner")!.addEventListener("click", () => clicks.push("banner"));
    const label = tryDomAction("roll", document);
    expect(label).toMatch(/roll dice/i);
    expect(clicks).toEqual(["banner"]); // clicked the span; bubbled to the banner
  });

  it("skips controls a failed earlier attempt already clicked", () => {
    document.body.innerHTML = `
      <div role="button"><img src="/img/dice_red.svg" alt=""></div>
      <div role="button"><img src="/img/dice_roll_button.svg" alt=""></div>`;
    const first = tryDomAction("roll", document)!;
    expect(first).not.toBeNull();
    const second = tryDomAction("roll", document, new Set([first]))!;
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    expect(tryDomAction("roll", document, new Set([first, second]))).toBeNull();
  });
});

describe("autopilot roll retry", () => {
  it("excludes an unconfirmed control on the next attempt instead of re-clicking it", () => {
    localStorage.clear();
    const learner = new ProtocolLearner(); // nothing learned → DOM fallback
    const attempts: Array<string[]> = [];
    let n = 0;
    const ap = new Autopilot(
      learner,
      () => false, // no WS dispatch — force the DOM-click path
      (kind, exclude) => {
        attempts.push([...(exclude ?? [])]);
        return `${kind}-ctrl-${n++}`;
      },
    );
    ap.setEnabled(true);
    ap.noteDomTurn(true); // my turn (banner), not rolled

    const t = createTracker("Nick");
    ensurePlayer(t, "Nick", "#f00");
    const ctx = { tracker: t, gs: null, advice: null, fit: null };

    ap.tick({ ...ctx, now: 10_000 }); // clicks roll-ctrl-0, pending
    ap.tick({ ...ctx, now: 12_000 }); // still pending — no new click
    ap.tick({ ...ctx, now: 19_000 }); // 8s passed, no confirmation: mark it failed
    ap.tick({ ...ctx, now: 20_000 }); // retry must exclude the failed control
    expect(attempts).toEqual([[], ["roll-ctrl-0"]]);
  });
});

describe("tryDomDiscard", () => {
  it("clicks the chosen cards and the confirm control in the discard dialog", () => {
    document.body.innerHTML = `
      <div id="dlg">Discard 3 cards
        <img alt="card wool"/><img alt="card wool"/><img alt="card wool"/>
        <img alt="card lumber"/><img alt="card ore"/>
        <button aria-label="confirm">✓</button>
      </div>`;
    const clicks: string[] = [];
    document.querySelectorAll("img, button").forEach((el) =>
      el.addEventListener("click", () =>
        clicks.push(el.getAttribute("alt") ?? el.getAttribute("aria-label") ?? "?"),
      ),
    );
    const result = tryDomDiscard({ sheep: 2, wood: 1 }, document);
    expect(result).toContain("3 cards");
    expect(result).toContain("confirm");
    expect(clicks).toEqual(["card wool", "card wool", "card lumber", "confirm"]);
  });

  it("does nothing without a discard dialog on screen", () => {
    document.body.innerHTML = `<div><img alt="card wool"/></div>`;
    expect(tryDomDiscard({ sheep: 1 }, document)).toBeNull();
  });
});
