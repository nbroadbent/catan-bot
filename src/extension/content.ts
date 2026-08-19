import { parseLogRow } from "./logParser";
import {
  TrackerState,
  applyEvent,
  applyServerPlayerState,
  createTracker,
  ensurePlayer,
} from "./tracker";
import { Overlay } from "./overlay";
import { BoardBridge, WS_EVENT } from "./boardBridge";
import { COLONIST_COLORS, advisePlacement } from "./placement";
import { ProtocolLearner } from "./protocolLearner";
import { Autopilot } from "./autopilot";
import { rankLiveStrategies } from "./copilot";
import { loadRecords, recordGameEnd, strategyPriors } from "./learning";

/**
 * Content-script entry point. Attaches to colonist.io's game log (a virtual
 * scroller of [data-index] rows), replays history in order, then follows new
 * messages with a MutationObserver. Purely observational: reads the DOM,
 * renders an overlay, never clicks or sends anything.
 */

let tracker: TrackerState | null = null;
let overlay: Overlay | null = null;
const bridge = new BoardBridge();

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
 * Authoritative total card counts from colonist's player panel (works even
 * without the WebSocket captured). Matches blocks to known player names.
 */
function readDomCardTotals(): void {
  if (!tracker) return;
  const container = document.querySelector("[data-player-information-container]");
  if (!container) return;
  const names = [...tracker.players.keys()];
  container.querySelectorAll<HTMLElement>("[data-player-color]").forEach((block) => {
    const count = parseInt(
      block.querySelector("[data-resource-card]")?.textContent?.trim() ?? "",
      10,
    );
    if (Number.isNaN(count)) return;
    const text = block.textContent ?? "";
    const name = names
      .filter((n) => text.includes(n))
      .sort((a, b) => b.length - a.length)[0];
    if (name) tracker!.players.get(name)!.serverCards = count;
  });
}

/** DOM fallback for "is it my turn": colonist shows a "Your Turn" banner. */
function domSaysYourTurn(): boolean {
  return domHasText(/^your turn$/i);
}

/** Colonist's action banner asks you to move the robber after a 7/knight. */
function domSaysMoveRobber(): boolean {
  return domHasText(/(move|place|drop).{0,10}robber|robber/i, true);
}

/** True if any small text node in the play area matches — scoped to avoid the log. */
function domHasText(pattern: RegExp, partial = false): boolean {
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
      if (partial ? pattern.test(text) : pattern.test(text)) return true;
    }
  } catch {
    // XPath unsupported — skip
  }
  return false;
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
      readDomCardTotals();
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
  bridge.handle(data.type, data.payload);

  // Ground truth for hands: colonist's player-state frames include YOUR exact
  // cards and everyone's totals — they override drift in the log tracking.
  if (data.type === WS_EVENT.PLAYER_STATE && tracker && Array.isArray(data.payload)) {
    applyServerPlayerState(tracker, data.payload as never, bridge.myColor);
  }

  // Turn tracking + action confirmations feed the protocol learner and gate
  // autopilot's next move.
  if (data.type === 9) {
    const color = (data.payload as { currentTurnPlayerColor?: number })?.currentTurnPlayerColor;
    if (typeof color === "number") {
      if (prevTurnColor !== null && prevTurnColor === bridge.myColor && color !== bridge.myColor) {
        learner.confirm("end-turn");
        autopilot.onConfirm("end-turn");
      }
      prevTurnColor = color;
      autopilot.onTurnState(color, bridge.myColor);
    }
  } else if (data.type === WS_EVENT.BUILD_CORNER || data.type === WS_EVENT.BUILD_EDGE) {
    const item = (Array.isArray(data.payload) ? data.payload[0] : data.payload) as {
      owner?: number;
      buildingType?: number;
    };
    if (item && item.owner === bridge.myColor && bridge.myColor !== null) {
      const kind =
        data.type === WS_EVENT.BUILD_EDGE
          ? ("build-road" as const)
          : item.buildingType === 2
            ? ("build-city" as const)
            : ("build-settlement" as const);
      learner.confirm(kind);
      autopilot.onConfirm(kind);
    }
  } else if (data.type === WS_EVENT.MOVE_ROBBER) {
    // The robber moved — if we were waiting to move it, that's our confirmation.
    learner.confirm("move-robber");
    autopilot.onConfirm("move-robber");
  }
  if (tracker) {
    // The play-order + player-state frames identify the signed-in player and
    // the full roster before any log message exists — advice (and 1v1
    // detection) can start before the first placement.
    if (!tracker.youName && bridge.myColor !== null) {
      tracker.youName = bridge.colorToName.get(bridge.myColor) ?? null;
    }
    for (const [color, name] of bridge.colorToName) {
      ensurePlayer(tracker, name, COLONIST_COLORS[color] ?? "#888");
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
  // Without WebSocket turn frames (loaded mid-game), fall back to the DOM
  // "Your Turn" banner; a roll is "done" if the latest roll in the log is ours.
  if (!autopilot.wsTurnSeen) {
    autopilot.setTurnFallback(
      domSaysYourTurn(),
      tracker.lastRoll?.player === tracker.youName,
    );
  }
  // A 7 rolled (by anyone) or a knight means the CURRENT player moves the
  // robber; colonist shows a "move robber" banner only for the active player,
  // so that banner is the reliable "it's mine to move" signal.
  autopilot.setRobberPending(domSaysMoveRobber());
  const gs = bridge.board ? bridge.toGameState() : null;
  const advice = gs ? advisePlacement(gs.state, gs.youPlayer) : null;
  const fits = rankLiveStrategies(tracker, tracker.youName, strategyPriors(loadRecords()));
  autopilot.tick({
    tracker,
    gs,
    advice,
    fit: fits[0] ?? null,
    robberHex: bridge.robberHex,
  });
  scheduleRender();
}, 1500);

watchForGame();
