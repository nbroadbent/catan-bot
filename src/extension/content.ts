import { parseLogRow } from "./logParser";
import { TrackerState, applyEvent, createTracker, ensurePlayer } from "./tracker";
import { Overlay } from "./overlay";
import { StateBridge, STATE_EVENT } from "./stateBridge";
import { COLONIST_COLORS, advisePlacement } from "./placement";
import { ProtocolLearner } from "./protocolLearner";
import { DISCARD_BANNER, MOVE_ROBBER_BANNER, YOUR_TURN_BANNER, rollPromptVisible } from "./domActions";
import { Autopilot } from "./autopilot";
import { rankLiveStrategies } from "./copilot";
import { loadRecords, recordGameEnd, strategyPriors } from "./learning";
import { RESOURCES, Resource } from "../engine/types";

/**
 * Content-script entry point. Reads colonist.io's real WebSocket game state
 * (init type 4 + diffs type 91, via StateBridge) for board, turn, and hands,
 * and the DOM game log for income-per-number learning. Renders an overlay and
 * — when autopilot is on — clicks colonist's own controls. Never sends forged
 * socket frames for actions (the outbound path carries only pings).
 */

let tracker: TrackerState | null = null;
let overlay: Overlay | null = null;
const bridge = new StateBridge();

const learner = new ProtocolLearner();
learner.load();
const autopilot = new Autopilot(learner, (frame) =>
  window.postMessage({ __catan_copilot_send__: true, frame }, "*"),
);
let prevTurnColor: number | null = null;
let gameRecorded = false;

/**
 * Protocol capture for autopilot: every decoded frame (both directions) from
 * the current page session, downloadable from the overlay. One manually
 * played game with this running yields the outbound action formats.
 */
const capture: Array<{ t: number; dir: "in" | "out"; frame: unknown }> = [];
const CAPTURE_LIMIT = 5000;

function downloadCapture(): void {
  const blob = new Blob([JSON.stringify(capture, null, 1)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `catan-copilot-capture-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}
let observer: MutationObserver | null = null;
let lastProcessedIndex = -1;
let renderTimer: number | undefined;

function getYouName(): string | null {
  const el = document.getElementsByClassName("web-header-username")[0];
  return el?.textContent?.trim() || null;
}

/**
 * Sync the tracker to colonist's ground-truth player states: our EXACT hand,
 * everyone's card totals, bank/port ratios, and the discard limit. Log-based
 * card tracking still runs for income-per-number learning, but these values
 * override any drift.
 */
function syncTrackerFromState(): void {
  if (!tracker) return;
  const myColor = bridge.myColor;
  if (myColor !== null && !tracker.youName) {
    tracker.youName = bridge.colorToName.get(myColor) ?? tracker.youName;
  }
  for (const [color, name] of bridge.colorToName) {
    ensurePlayer(tracker, name, COLONIST_COLORS[color] ?? "#888");
    const p = tracker.players.get(name)!;
    const hand = bridge.handOf(color);
    p.serverCards = hand.total;
    if (color === myColor) {
      // our own cards are fully known — replace the estimate outright
      for (const r of RESOURCES) p.hand[r] = hand.known[r] ?? 0;
      p.uncertainty = 0;
    }
    for (const [r, ratio] of Object.entries(bridge.bankRatios(color))) {
      p.bankRatio[r as Resource] = Math.min(p.bankRatio[r as Resource] ?? 4, ratio);
    }
  }
  if (myColor !== null) {
    const limit = bridge.discardLimit(myColor);
    if (limit !== null) tracker.discardLimit = limit;
  }
}

/**
 * "Is it my turn?" — true if colonist shows the "Your Turn" banner OR a
 * clickable roll control (the roll prompt only appears on your own turn).
 * Two independent signals so a wording change in one doesn't blind autopilot.
 */
function domSaysYourTurn(): boolean {
  return domHasText(YOUR_TURN_BANNER) || rollPromptVisible();
}

/** Colonist's action banner asks you to move the robber after a 7/knight. */
function domSaysMoveRobber(): boolean {
  return domHasText(MOVE_ROBBER_BANNER);
}

/** Colonist's dialog asks you to select cards to discard after a 7. */
function domSaysDiscard(): boolean {
  return domHasText(DISCARD_BANNER);
}

/** True if any small text node in the play area matches — scoped to avoid the log. */
function domHasText(pattern: RegExp): boolean {
  try {
    const nodes = document.evaluate(
      `//*[not(ancestor::*[@data-index]) and not(ancestor::*[@id="catan-copilot"])]`,
      document.body,
      null,
      XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
      null,
    );
    for (let i = 0; i < nodes.snapshotLength; i++) {
      const el = nodes.snapshotItem(i) as HTMLElement;
      // only leaf-ish elements, to avoid matching huge container text
      if (el.children.length > 2) continue;
      const text = (el.textContent ?? "").trim();
      if (text.length > 40) continue;
      if (pattern.test(text)) return true;
    }
  } catch {
    // XPath unsupported — skip
  }
  return false;
}

/**
 * Knight ("robber") dev cards visible in YOUR hand. Your hand is the bottom
 * bar; the log, our panel and the opponents' info panel (played-knight
 * badges, Largest Army art) are excluded, as are invisible images.
 */
function countKnightsInHand(): number {
  let n = 0;
  document.querySelectorAll<HTMLImageElement>("img").forEach((img) => {
    if (
      img.closest("[data-index]") ||
      img.closest("#catan-copilot") ||
      img.closest("[data-player-information-container]")
    ) {
      return;
    }
    const label = `${img.getAttribute("alt") ?? ""} ${img.getAttribute("src") ?? ""}`;
    if (!/knight/i.test(label) || /largest/i.test(label)) return;
    const r = img.getBoundingClientRect();
    if (r.width === 0 || r.top < window.innerHeight * 0.55) return;
    n++;
  });
  return n;
}

function findChatScroller(): HTMLElement | null {
  const row = document.querySelector("[data-index]");
  return row ? (row.parentElement as HTMLElement) : null;
}

function scheduleRender(): void {
  if (renderTimer !== undefined) return;
  renderTimer = window.setTimeout(() => {
    renderTimer = undefined;
    if (tracker && overlay) {
      if (!tracker.youName) tracker.youName = getYouName();
      if (!tracker.youName && bridge.myColor !== null) {
        tracker.youName = bridge.colorToName.get(bridge.myColor) ?? null;
      }
      overlay.render(tracker, bridge);
    }
  }, 400);
}

// inject.js runs as a MAIN-world content script at document_start (see
// manifest), so it wraps window.WebSocket synchronously before colonist's own
// scripts load — no injection race. It forwards decoded frames here.
window.addEventListener("message", (ev: MessageEvent) => {
  const data = ev.data as {
    __catan_copilot__?: boolean;
    type?: number;
    payload?: unknown;
    dir?: "in" | "out";
    frame?: unknown;
  };
  // source is the page window in Firefox; jsdom (tests) delivers null
  if (ev.source !== window && ev.source !== null) return;
  if (!data?.__catan_copilot__) return;

  if (data.dir && data.frame !== undefined) {
    if (capture.length < CAPTURE_LIMIT) {
      capture.push({ t: Date.now(), dir: data.dir, frame: data.frame });
    }
    if (data.dir === "out") {
      learner.recordOutbound(data.frame);
      scheduleRender(); // keep the capture counter fresh
    }
    return;
  }

  if (typeof data.type !== "number") return;

  // The real colonist protocol: init (type 4) + state diffs (type 91). Feed
  // them to the state bridge, then mirror ground truth into the tracker and
  // the autopilot turn signals.
  if (data.type === STATE_EVENT.INIT || data.type === STATE_EVENT.DIFF) {
    const prev = prevTurnColor;
    if (bridge.apply(data.type, data.payload) && tracker) {
      syncTrackerFromState();
      const turn = bridge.currentTurnColor;
      const myColor = bridge.myColor;
      if (turn !== null && myColor !== null) {
        // end-of-my-turn boundary
        if (prev === myColor && turn !== myColor) autopilot.onConfirm("end-turn");
        prevTurnColor = turn;
        autopilot.onTurnState(turn, myColor);
        // ground-truth roll state: on my turn, diceThrown === rolled
        if (bridge.isMyTurn && bridge.diceThrown) autopilot.onYouRolled();
      }
    }
  }
  scheduleRender();
});

function processRow(el: Element): void {
  if (!tracker) return;
  const idxAttr = el.getAttribute("data-index");
  if (idxAttr === null) return;
  const idx = parseInt(idxAttr, 10);
  // The virtual scroller re-renders overlapping windows; <= skips replays.
  if (Number.isNaN(idx) || idx <= lastProcessedIndex) return;
  lastProcessedIndex = idx;
  const ev = parseLogRow(el);
  applyEvent(tracker, ev);

  // Log-confirmed actions close the learner/autopilot loop for actions that
  // have no dedicated WebSocket event we track.
  const you = tracker.youName;
  if (you) {
    if (ev.type === "roll" && ev.player === you) {
      learner.confirm("roll");
      autopilot.onYouRolled();
    } else if (ev.type === "buy-dev" && ev.player === you) {
      learner.confirm("buy-dev");
      autopilot.onConfirm("buy-dev");
    } else if (ev.type === "move-robber" && ev.player === you) {
      // Fallback confirmation via the log (player-attributed), in case the
      // banner cleared before the MOVE_ROBBER frame was seen.
      learner.confirm("move-robber");
      autopilot.onConfirm("move-robber");
    } else if (ev.type === "discard" && ev.player === you) {
      learner.confirm("discard");
      autopilot.onConfirm("discard");
    } else if (ev.type === "use-knight" && ev.player === you) {
      learner.confirm("play-knight");
      autopilot.onConfirm("play-knight");
    } else if (ev.type === "use-dev" && ev.player === you) {
      // YoP/Monopoly/Road Building played manually — one dev per turn.
      autopilot.markDevPlayed();
    }
  }
  if (ev.type === "game-over" && !gameRecorded) {
    gameRecorded = true;
    recordGameEnd(tracker);
  }
  scheduleRender();
}

function sweepExistingRows(scroller: HTMLElement): void {
  const rows = [...scroller.querySelectorAll("[data-index]")].sort(
    (a, b) =>
      parseInt(a.getAttribute("data-index")!, 10) -
      parseInt(b.getAttribute("data-index")!, 10),
  );
  rows.forEach(processRow);
}

let observedScroller: HTMLElement | null = null;

function attach(scroller: HTMLElement): void {
  tracker = createTracker(getYouName());
  lastProcessedIndex = -1;
  observedScroller = scroller;
  gameRecorded = false;
  if (!overlay) {
    overlay = new Overlay(document, {
      captureCount: () => capture.length,
      onDownloadCapture: downloadCapture,
      getAutopilotView: () => autopilot.view(),
      onToggleAutopilot: (on) => {
        autopilot.setEnabled(on);
        scheduleRender();
      },
      needsRefresh: () => capture.length === 0,
    });
  }

  sweepExistingRows(scroller);

  observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      m.addedNodes.forEach((node) => {
        if (node instanceof Element) {
          if (node.hasAttribute("data-index")) processRow(node);
          else node.querySelectorAll?.("[data-index]").forEach(processRow);
        }
      });
    }
  });
  observer.observe(scroller, { childList: true, subtree: true });
  scheduleRender();
}

function detach(): void {
  observer?.disconnect();
  observer = null;
  observedScroller = null;
  tracker = null;
  lastProcessedIndex = -1;
}

function watchForGame(): void {
  window.setInterval(() => {
    const scroller = findChatScroller();
    if (!observer && scroller) {
      attach(scroller);
    } else if (observer && !scroller) {
      // game ended / navigated away: wait for the next game
      detach();
    } else if (observer && scroller && scroller !== observedScroller) {
      // the log was rebuilt (new game in the same tab): start over
      detach();
      attach(scroller);
    }
  }, 2000);
}

// Autopilot loop: only does work while enabled; every action must be
// confirmed by the game before the next one is attempted.
window.setInterval(() => {
  if (!autopilot.enabled || !tracker || !tracker.youName) return;
  // Ground-truth turn signal from colonist's own state (currentTurnPlayerColor
  // vs our playerColor) — re-fed every tick so it's correct even if a diff
  // arrived before the roster. This is authoritative; the DOM banner below is
  // a backup for the rare case the socket wasn't captured.
  if (bridge.currentTurnColor !== null && bridge.myColor !== null) {
    autopilot.onTurnState(bridge.currentTurnColor, bridge.myColor);
    if (bridge.isMyTurn && bridge.diceThrown) autopilot.onYouRolled();
  }
  autopilot.noteDomTurn(domSaysYourTurn());
  // A 7 rolled (by anyone) or a knight means the CURRENT player moves the
  // robber; colonist shows a "move robber" banner only for the active player,
  // so that banner is the reliable "it's mine to move" signal.
  autopilot.setRobberPending(domSaysMoveRobber());
  // A 7 over the discard limit: the dialog is the signal; autopilot also
  // checks the hand is actually oversized before selecting cards.
  autopilot.setDiscardPending(domSaysDiscard());
  const gs = bridge.board ? bridge.toGameState() : null;
  const advice = gs ? advisePlacement(gs.state, gs.youPlayer) : null;
  const fits = rankLiveStrategies(tracker, tracker.youName, strategyPriors(loadRecords()));
  autopilot.tick({
    tracker,
    gs,
    advice,
    fit: fits[0] ?? null,
    robberHex: bridge.robberHex,
    knightsInHand: countKnightsInHand(),
  });
  scheduleRender();
}, 1500);

watchForGame();
