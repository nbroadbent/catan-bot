import { parseLogRow } from "./logParser";
import { GameEvent, ResourceDelta } from "./events";
import { TrackerState, applyEvent, createTracker, ensurePlayer } from "./tracker";
import { Overlay } from "./overlay";
import { StateBridge, STATE_EVENT } from "./stateBridge";
import { COLONIST_COLORS, advisePlacement, describeVertex } from "./placement";
import { ProtocolLearner } from "./protocolLearner";
import { DISCARD_BANNER, MOVE_ROBBER_BANNER, YOUR_TURN_BANNER, rollPromptVisible } from "./domActions";
import { Autopilot, AutopilotDecision, cardsToIds } from "./autopilot";
import { deckStatus, expectedProduction, productionTotal, rankLiveStrategies } from "./copilot";
import { handTotal, visibleVp } from "./tracker";
import { loadRecords, recordGameEnd, strategyPriors } from "./learning";
import { GameLog, loadGameLogs, saveGameLog } from "./gameLog";
import { VERSION } from "./version";
import { RESOURCES, Resource } from "../engine/types";
import { vertexPips } from "../engine/board";
import {
  bankTradeActions,
  buildCityActions,
  buildRoadActions,
  buildSettlementActions,
  buyDevAction,
  discardActions,
  endTurnAction,
  knightActions,
  monopolyActions,
  roadActions,
  roadBuildingActions,
  robberActions,
  rollAction,
  settlementActions,
  yearOfPlentyActions,
} from "./colonistActions";
import { RESOURCE_TO_CARD_ID } from "./tracker";

const SEND_MARKER = "__catan_copilot_send__";

/**
 * Translate an autopilot decision into real colonist WebSocket action frames
 * and post them to inject.js (which wraps them in the envelope with the next
 * sequence number). Returns true if dispatched. Board placements resolve the
 * corner/edge/tile INDEX from ground-truth state.
 */
function dispatchDecision(d: AutopilotDecision): boolean {
  if (!bridge.serverId) return false;
  const send = (actions: Array<{ action: number; payload: unknown }>): boolean => {
    if (actions.length === 0) return false;
    window.postMessage({ [SEND_MARKER]: true, actions }, "*");
    return true;
  };
  switch (d.kind) {
    case "roll":
      return send(rollAction());
    case "end-turn":
      return send(endTurnAction());
    case "buy-dev":
      return send(buyDevAction());
    case "build-settlement": {
      const idx = d.coord ? bridge.cornerIndexForCoord(d.coord) : null;
      if (idx === null) return false;
      // Setup (forced-placement) phase: just place. Main game (turnState 2):
      // send the build-settlement intent (action 14) first, then place.
      return send(bridge.turnState === 2 ? buildSettlementActions(idx) : settlementActions(idx));
    }
    case "build-road": {
      const idx = d.coord ? bridge.edgeIndexForCoord(d.coord) : null;
      if (idx === null) return false;
      // Free placements (setup, Road Building) skip the paid build intent.
      return send(bridge.turnState === 2 && !d.free ? buildRoadActions(idx) : roadActions(idx));
    }
    case "build-city": {
      const idx = d.coord ? bridge.cornerIndexForCoord(d.coord) : null;
      return idx !== null ? send(buildCityActions(idx)) : false;
    }
    case "move-robber": {
      if (!d.coord) return false;
      const tile = bridge.tileIndexForHex(d.coord.x, d.coord.y);
      if (tile === null) return false;
      const victim = bridge.opponentsOnTile(tile)[0] ?? null;
      return send(robberActions(tile, victim));
    }
    case "discard": {
      const ids = cardsToIds(d.cards ?? {});
      return ids.length > 0 ? send(discardActions(ids)) : false;
    }
    case "bank-trade": {
      if (!d.trade || bridge.myColor === null) return false;
      const giveId = RESOURCE_TO_CARD_ID[d.trade.give];
      const getId = RESOURCE_TO_CARD_ID[d.trade.get];
      return send(bankTradeActions(bridge.myColor, giveId, d.trade.giveCount, getId));
    }
    case "play-monopoly": {
      if (!d.resource) return false;
      return send(monopolyActions(RESOURCE_TO_CARD_ID[d.resource]));
    }
    case "play-knight":
      return send(knightActions());
    case "play-road-building":
      return send(roadBuildingActions());
    case "play-year-of-plenty": {
      if (!d.resources || d.resources.length !== 2) return false;
      return send(
        yearOfPlentyActions([
          RESOURCE_TO_CARD_ID[d.resources[0]],
          RESOURCE_TO_CARD_ID[d.resources[1]],
        ]),
      );
    }
    default:
      return false;
  }
}

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
const autopilot = new Autopilot(learner, dispatchDecision);

// "Play my turns" is on by default and remembers the last choice, so a new
// game starts already playing for you.
const AUTOPILOT_PREF = "catanCopilot:autopilotOn";
function loadAutopilotPref(): boolean {
  try {
    const v = localStorage.getItem(AUTOPILOT_PREF);
    return v === null ? true : v === "1";
  } catch {
    return true;
  }
}
autopilot.setEnabled(loadAutopilotPref());
let prevTurnColor: number | null = null;
let prevMyBuildings = 0;
let prevMyCities = 0;
let prevMyRoads = 0;
let gameRecorded = false;

/**
 * Protocol capture for autopilot: every decoded frame (both directions) from
 * the current page session, downloadable from the overlay. One manually
 * played game with this running yields the outbound action formats.
 */
const capture: Array<{
  t: number;
  dir: "in" | "out";
  frame: unknown;
  raw?: string;
  decodes?: Record<string, unknown>;
}> = [];
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

/** Human-readable move history shown in the overlay (newest last). */
export interface MoveEntry {
  t: number;
  player: string | null;
  text: string;
  mine: boolean;
}
const moveHistory: MoveEntry[] = [];
const HISTORY_LIMIT = 400;

function fmtRes(res: ResourceDelta): string {
  return RESOURCES.filter((r) => (res[r] ?? 0) > 0)
    .map((r) => `${res[r]} ${r}`)
    .join(" + ");
}

function fmtDelta(d: ResourceDelta): string {
  const gave = RESOURCES.filter((r) => (d[r] ?? 0) < 0).map((r) => `${-(d[r] ?? 0)} ${r}`);
  const got = RESOURCES.filter((r) => (d[r] ?? 0) > 0).map((r) => `${d[r]} ${r}`);
  return [gave.length ? `gave ${gave.join(" + ")}` : "", got.length ? `got ${got.join(" + ")}` : ""]
    .filter(Boolean)
    .join(", ");
}

/** Turn a parsed game event into a one-line history entry, or null to skip. */
function describeMove(ev: GameEvent, you: string | null): { player: string | null; text: string } | null {
  const meName = you ?? "you";
  switch (ev.type) {
    case "roll":
      return { player: ev.player, text: `rolled ${ev.total}` };
    case "place":
      return { player: ev.player, text: `placed a ${ev.what}` };
    case "build":
      return { player: ev.player, text: `built a ${ev.what}` };
    case "buy-dev":
      return { player: ev.player, text: "bought a development card" };
    case "bank-trade":
      return { player: ev.player, text: `bank-traded — ${fmtDelta(ev.delta)}` };
    case "player-trade":
      return {
        player: ev.player,
        text: `traded${ev.partner ? ` with ${ev.partner}` : ""} — ${fmtDelta(ev.delta)}`,
      };
    case "steal-known":
      return { player: ev.thief ?? meName, text: `stole from ${ev.victim ?? meName}` };
    case "steal-unknown":
      return { player: ev.thief ?? meName, text: `stole from ${ev.victim ?? meName}` };
    case "monopoly-steal":
      return { player: ev.player, text: `monopoly — took ${ev.count} ${ev.resource}` };
    case "discard":
      return { player: ev.player, text: `discarded ${fmtRes(ev.resources)}` };
    case "use-knight":
      return { player: ev.player, text: "played a knight" };
    case "use-dev":
      return { player: ev.player, text: `played ${ev.card.replace(/-/g, " ")}` };
    case "move-robber":
      return { player: ev.player, text: "moved the robber" };
    case "game-over":
      return { player: ev.winner, text: "won the game 🏆" };
    default:
      return null; // got / starting-resources / blocked-roll / ignored: not a move
  }
}

function recordMove(ev: GameEvent): void {
  const m = describeMove(ev, tracker?.youName ?? null);
  if (!m) return;
  moveHistory.push({
    t: Date.now(),
    player: m.player,
    text: m.text,
    mine: m.player !== null && m.player === tracker?.youName,
  });
  if (moveHistory.length > HISTORY_LIMIT) moveHistory.shift();
}

/** Export the full archive of logged games (all stored) as JSON. */
function downloadGameLogs(): void {
  const logs = loadGameLogs();
  const blob = new Blob([JSON.stringify(logs, null, 1)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `catan-copilot-gamelogs-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/** Export the move history as a plain-text transcript. */
function downloadHistory(): void {
  const lines = moveHistory.map((e) => {
    const clock = new Date(e.t).toLocaleTimeString();
    return `${clock}  ${e.player ?? "?"}${e.mine ? " (you)" : ""}: ${e.text}`;
  });
  const blob = new Blob([lines.join("\n")], { type: "text/plain" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `catan-copilot-history-${Date.now()}.txt`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function getYouName(): string | null {
  const el = document.getElementsByClassName("web-header-username")[0];
  return el?.textContent?.trim() || null;
}

/**
 * Stream a compact live game-state summary to the local bridge server
 * (scripts/bridge.mjs), which writes it to disk for a Claude Code session to
 * read and coach in real time. Best-effort and throttled; failures are
 * ignored so the extension works fine with no bridge running.
 */
const BRIDGE_URL = "http://127.0.0.1:8137/state";
let lastBridgePost = 0;

function buildLiveSummary(): unknown {
  if (!tracker) return null;
  const you = tracker.youName;
  const deck = deckStatus(tracker);
  const players = [...tracker.players.values()].map((p) => ({
    name: p.name,
    isYou: p.name === you,
    vp: visibleVp(p),
    cards: p.serverCards ?? handTotal(p),
    pips: Math.round(productionTotal(expectedProduction(p)) * 36),
    devCards: p.devCards,
    knightsPlayed: p.knightsPlayed,
    hand: p.name === you ? p.hand : undefined, // only our own cards are known
  }));
  const fits = you ? rankLiveStrategies(tracker, you, strategyPriors(loadRecords())) : [];
  const gs = bridge.board ? bridge.toGameState() : null;
  const advice = gs ? advisePlacement(gs.state, gs.youPlayer) : null;
  return {
    at: new Date().toISOString(),
    you,
    turn: {
      isMyTurn: bridge.isMyTurn,
      needsRoll: bridge.needsRoll,
      phase: bridge.turnState,
      currentPlayerColor: bridge.currentTurnColor,
    },
    players,
    deck: {
      cardsLeft: 36 - deck.rollsIntoDeck,
      due: deck.due,
      cold: deck.cold,
      prob: Object.fromEntries([...deck.prob.entries()].map(([n, p]) => [n, +(p * 100).toFixed(0)])),
    },
    recommendedStrategy: fits[0]
      ? { name: fits[0].strategy.name, rationale: fits[0].rationale, simVp: +fits[0].simVp.toFixed(1) }
      : null,
    whereToBuild: advice
      ? { heading: advice.heading, spots: advice.spots.map((s) => s.label) }
      : null,
    autopilot: autopilot.view(),
    recentMoves: moveHistory.slice(-25).map((m) => ({ player: m.player, text: m.text, mine: m.mine })),
  };
}

function postLiveState(): void {
  const now = Date.now();
  if (now - lastBridgePost < 1500) return;
  lastBridgePost = now;
  try {
    const summary = buildLiveSummary();
    if (!summary) return;
    fetch(BRIDGE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(summary),
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    // no bridge / blocked — the extension works fine without it
  }
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
    p.serverVp = bridge.publicVp(color);
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
      postLiveState();
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
    const raw = (data as { raw?: string }).raw;
    const decodes = (data as { decodes?: Record<string, unknown> }).decodes;
    if (capture.length < CAPTURE_LIMIT) {
      capture.push({ t: Date.now(), dir: data.dir, frame: data.frame, raw, decodes });
    }
    if (data.dir === "out") {
      // Record the richest decode (an object payload past the envelope byte),
      // in case a future colonist build sends learnable action frames.
      const best = decodes
        ? Object.values(decodes).find((v) => v && typeof v === "object")
        : undefined;
      learner.recordOutbound(best ?? data.frame);
      scheduleRender(); // keep the capture counter fresh
    }
    return;
  }

  if (typeof data.type !== "number") return;

  // The real colonist protocol: game meta (type 1, carries serverId), init
  // (type 4), state diffs (type 91). Feed the state bridge, then mirror ground
  // truth into the tracker and the autopilot turn/confirm signals.
  if (
    data.type === STATE_EVENT.GAME_META ||
    data.type === STATE_EVENT.INIT ||
    data.type === STATE_EVENT.DIFF
  ) {
    const prev = prevTurnColor;
    bridge.apply(data.type, data.payload);
    if (tracker && (data.type === STATE_EVENT.INIT || data.type === STATE_EVENT.DIFF)) {
      syncTrackerFromState();
      const turn = bridge.currentTurnColor;
      const myColor = bridge.myColor;
      if (turn !== null && myColor !== null) {
        if (prev === myColor && turn !== myColor) autopilot.onConfirm("end-turn");
        prevTurnColor = turn;
        autopilot.onTurnState(turn, myColor);
        if (bridge.isMyTurn && bridge.diceThrown) autopilot.onYouRolled();
      }
      // Confirm our builds from ground truth. A new corner confirms a
      // settlement; a new road confirms a road; a settlement turning into a
      // city (count unchanged) confirms a city.
      if (myColor !== null) {
        const mineBuildings = bridge.buildings.filter((b) => b.colorId === myColor);
        const mine = mineBuildings.length;
        const myCities = mineBuildings.filter((b) => b.kind === "city").length;
        const myRoads = bridge.roads.filter((r) => r.colorId === myColor).length;
        if (mine > prevMyBuildings) autopilot.onConfirm("build-settlement");
        if (myCities > prevMyCities) autopilot.onConfirm("build-city");
        if (myRoads > prevMyRoads) autopilot.onConfirm("build-road");
        prevMyBuildings = mine;
        prevMyCities = myCities;
        prevMyRoads = myRoads;
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
  recordMove(ev);

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
    } else if (ev.type === "bank-trade" && ev.player === you) {
      autopilot.onConfirm("bank-trade");
    } else if (ev.type === "use-knight" && ev.player === you) {
      learner.confirm("play-knight");
      autopilot.onConfirm("play-knight");
    } else if (ev.type === "use-dev" && ev.player === you) {
      // YoP/Monopoly/Road Building — one dev per turn.
      if (ev.card === "monopoly") autopilot.onConfirm("play-monopoly");
      if (ev.card === "road-building") autopilot.onConfirm("play-road-building");
      if (ev.card === "year-of-plenty") autopilot.onConfirm("play-year-of-plenty");
      autopilot.markDevPlayed();
    }
  }
  if (ev.type === "game-over" && !gameRecorded) {
    gameRecorded = true;
    recordGameEnd(tracker);
    saveFullGameLog();
  }
  scheduleRender();
}

let gameStartTime = 0;

/** Assemble and persist a full structured log of the finished game. */
function saveFullGameLog(): void {
  if (!tracker) return;
  const you = tracker.youName;
  const winnerEntry = [...tracker.players.values()].find((p) => visibleVp(p) >= 10);
  const winner =
    typeof tracker.gameOver === "string" ? tracker.gameOver : (winnerEntry?.name ?? null);
  const fits = you ? rankLiveStrategies(tracker, you, strategyPriors(loadRecords())) : [];
  const log: GameLog = {
    version: VERSION,
    at: new Date().toISOString(),
    durationMs: gameStartTime ? Date.now() - gameStartTime : null,
    you,
    won: winner !== null && winner === you,
    winner,
    playerCount: tracker.players.size,
    settings: {
      friendlyRobber: bridge.friendlyRobber,
      victoryPointsToWin: null,
      discardLimit: tracker.discardLimit,
    },
    recommendedStrategy: fits[0]?.strategy.name ?? null,
    board: bridge.board
      ? {
          tiles: bridge.board.hexes.map((h) => ({ q: h.q, r: h.r, kind: h.kind, token: h.token })),
          ports: bridge.board.vertices
            .filter((v) => v.port)
            .map((v) => (v.port!.ratio === 2 ? `2:1 ${v.port!.kind}` : "3:1"))
            .filter((p, i, a) => a.indexOf(p) === i),
        }
      : { tiles: [], ports: [] },
    finalPlayers: [...tracker.players.values()].map((p) => ({
      name: p.name,
      isYou: p.name === you,
      vp: visibleVp(p),
      cards: p.serverCards ?? handTotal(p),
      pips: Math.round(productionTotal(expectedProduction(p)) * 36),
      devCards: p.devCards,
      knightsPlayed: p.knightsPlayed,
    })),
    // Final board positions: lets a post-game analysis see WHERE we settled
    // (pips, ports) — the move log alone can't explain a production deficit.
    buildings: (() => {
      const gs = bridge.board ? bridge.toGameState() : null;
      if (!gs) return undefined;
      return bridge.buildings.map((b) => ({
        player: bridge.colorToName.get(b.colorId) ?? null,
        kind: b.kind,
        label: describeVertex(gs.state, b.vertexId),
        pips: vertexPips(gs.state.board, b.vertexId),
      }));
    })(),
    moves: moveHistory.slice(),
  };
  saveGameLog(log);
  // Also append to the on-disk corpus if the local bridge is running.
  try {
    fetch("http://127.0.0.1:8137/gamelog", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(log),
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    /* no bridge — the localStorage archive + export still have it */
  }
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
  prevTurnColor = null;
  prevMyBuildings = 0;
  prevMyCities = 0;
  prevMyRoads = 0;
  moveHistory.length = 0;
  gameStartTime = Date.now();
  if (!overlay) {
    overlay = new Overlay(document, {
      captureCount: () => capture.length,
      onDownloadCapture: downloadCapture,
      getAutopilotView: () => autopilot.view(),
      onToggleAutopilot: (on) => {
        autopilot.setEnabled(on);
        try {
          localStorage.setItem(AUTOPILOT_PREF, on ? "1" : "0");
        } catch {
          /* storage unavailable */
        }
        scheduleRender();
      },
      needsRefresh: () => capture.length === 0,
      getHistory: () => moveHistory,
      onDownloadHistory: downloadHistory,
      gameLogCount: () => loadGameLogs().length,
      onDownloadGameLogs: downloadGameLogs,
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
  // Friendly robber: a player can be robbed only with >= 3 public VP. Map the
  // engine PlayerId back to its colonist color to read that player's VP.
  const colorOrder = bridge.colorOrder();
  const canRob = (player: number): boolean => {
    if (!bridge.friendlyRobber) return true;
    const color = colorOrder[player];
    return color === undefined || bridge.publicVp(color) >= 3;
  };
  autopilot.tick({
    tracker,
    gs,
    advice,
    fit: fits[0] ?? null,
    robberHex: bridge.robberHex,
    canRob,
    knightsInHand: countKnightsInHand(),
    bankDevCards: bridge.bankDevCards,
    piecesLeft: bridge.myColor !== null ? bridge.piecesLeft(bridge.myColor) : undefined,
    myDevCardIds: bridge.myDevCardIds(),
  });
  scheduleRender();
}, 1500);

watchForGame();
