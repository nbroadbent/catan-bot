// Unattended game loop on top of the driver (scripts/driver.mjs): start a bot
// game, watch it, and when it ends (or stalls / disconnects) start the next.
// Progress lines go to .context/autoplay.log:
//   GAME_START <mode/diff> <url>, GAME_OVER <winner> <elapsed>, STALL, DISCONNECT, ERROR
//   node scripts/autoplay.mjs            (Ctrl-C / kill to stop)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOG = path.join(root, ".context", "autoplay.log");
const DRIVER = "http://127.0.0.1:9377";
const POLL_MS = 20000;
const STALL_MS = 6 * 60 * 1000; // no log/turn progress for 6 min -> give up on the game
const MAX_GAME_MS = 75 * 60 * 1000;

// Rotation: mostly turn-based bot games at increasing difficulty; every 4th
// game is Rush (the Rush pilot is unverified — the log will tell us).
const ROTATION = [
  { mode: "Play vs. Bots", diff: "Easy" },
  { mode: "Play vs. Bots", diff: "Medium" },
  { mode: "Play vs. Bots", diff: "Hard" },
  { mode: "Colonist Rush", diff: "Medium" },
];

const log = (line) => {
  const s = `${new Date().toISOString()} ${line}`;
  fs.appendFileSync(LOG, s + "\n");
  console.log(s);
};

async function run(src, timeoutMs = 60000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(`${DRIVER}/run`, { method: "POST", body: src, signal: ctl.signal });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error ?? "run failed");
    return j.result;
  } finally {
    clearTimeout(t);
  }
}

/** One snapshot of the page: where we are, game progress, end/disconnect signals. */
const PROBE = `
return await page.evaluate(() => {
  const rows = [...document.querySelectorAll("[data-index]")].map(e => e.textContent.replace(/\\s+/g, " ").trim());
  const textOf = (re) => [...document.querySelectorAll("body *")]
    .filter(e => e.children.length <= 1 && !e.closest("[data-index]") && !e.closest("#catan-copilot"))
    .map(e => (e.textContent || "").trim()).filter(t => t && t.length < 80 && re.test(t));
  const st = window.__ccState;
  const panel = document.querySelector("#catan-copilot");
  const note = panel ? ([...panel.querySelectorAll(".cc-note")].map(n => n.textContent.replace(/\\s+/g, " ").trim()).find(t => /Play my turns|Rush mode/.test(t)) ?? "") : "";
  return {
    url: location.href,
    rows: rows.length,
    lastRow: rows[rows.length - 1] ?? "",
    won: rows.find(r => /won the game/i.test(r)) ?? null,
    gameOver: textOf(/^(Game Over|Game End|Well Played!?|Play Again|Back to Lobby|Return to Lobby|Rematch|Map . Replay)$/i),
    disconnected: textOf(/^Disconnected/i).length > 0 || textOf(/^Reconnect$/i).length > 0,
    completedTurns: st?.gameState?.currentState?.completedTurns ?? null,
    modeSetting: st?.gameSettings?.modeSetting ?? null,
    note: note.slice(0, 160),
    // colonist drops you back in the lobby when a game ends (account popup on top)
    lobby: [...document.querySelectorAll(".mm-mode-card-button")].some(b => b.getBoundingClientRect().width > 0),
  };
});`;

const GAMELOGS = path.join(root, ".context", "game-logs.jsonl");
/** Pull the extension's saved game logs out of the page and append new ones to disk. */
async function harvestGameLogs() {
  try {
    const logs = await run(`return await page.evaluate(() => JSON.parse(localStorage.getItem("catanCopilot:gamelogs") ?? "[]"));`);
    const have = new Set(
      fs.existsSync(GAMELOGS)
        ? fs.readFileSync(GAMELOGS, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l).at; } catch { return null; } })
        : [],
    );
    let added = 0;
    for (const g of logs) {
      if (have.has(g.at)) continue;
      fs.appendFileSync(GAMELOGS, JSON.stringify(g) + "\n");
      added++;
      const me = (g.finalPlayers ?? []).find((p) => p.isYou);
      log(`GAME_LOG saved: won=${g.won} winner=${g.winner} me=${me ? `${me.vp}vp/${me.pips}pips` : "?"} players=${g.playerCount} version=${g.version}`);
    }
    return added;
  } catch (e) {
    log(`ERROR harvest: ${String(e).slice(0, 200)}`);
    return 0;
  }
}

async function shot(name) {
  await fetch(`${DRIVER}/shot?name=${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(30000) }).catch(() => {});
}

async function setRushPref(on) {
  await run(`await page.evaluate((v) => localStorage.setItem("catanCopilot:rushMode", v), ${JSON.stringify(on ? "on" : "off")}); return true;`).catch(() => {});
}

async function newGame(plan) {
  const q = new URLSearchParams({ mode: plan.mode, diff: plan.diff });
  const r = await fetch(`${DRIVER}/newgame?${q}`, { signal: AbortSignal.timeout(150000) });
  const j = await r.json();
  if (!j.ok || !j.started) throw new Error(`newgame failed: ${JSON.stringify(j)}`);
  return j.url;
}

async function dismissDisconnect() {
  await run(`
    const b = page.getByText("Reconnect", { exact: true }).first();
    if (await b.isVisible().catch(() => false)) { await b.click().catch(() => {}); return "reconnect"; }
    return "none";`).catch(() => {});
}

// Hot-swap the extension between games: Chromium caches the unpacked bundle,
// so when extension/content.js is newer than the running driver, restart the
// driver (and its browser) before starting the next game.
import { spawn, execSync } from "node:child_process";
const BUNDLE = path.join(root, "extension", "content.js");
let driverStartedAt = Date.now();
async function driverHealthy() {
  try {
    const r = await fetch(`${DRIVER}/status`, { signal: AbortSignal.timeout(8000) });
    return (await r.json()).ok === true;
  } catch {
    return false;
  }
}
async function restartDriverIfStale() {
  const mtime = fs.statSync(BUNDLE).mtimeMs;
  const healthy = await driverHealthy();
  if (healthy && mtime < driverStartedAt) return;
  log(`DRIVER_RESTART ${healthy ? "new extension build" : "driver down"}`);
  try { execSync("pkill -f scripts/driver.mjs"); } catch { /* not running */ }
  await new Promise((r) => setTimeout(r, 2500));
  for (const f of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    try { fs.unlinkSync(path.join(root, ".context", "chrome-profile", f)); } catch { /* absent */ }
  }
  const out = fs.openSync(path.join(root, ".context", "driver.log"), "a");
  spawn(process.execPath, [path.join(root, "scripts", "driver.mjs")], { detached: true, stdio: ["ignore", out, out] }).unref();
  for (let t = 0; t < 30; t++) {
    await new Promise((r) => setTimeout(r, 2000));
    if (await driverHealthy()) { driverStartedAt = Date.now(); return; }
  }
  throw new Error("driver did not come back");
}
// the driver running when autoplay starts predates this process — treat the
// current bundle as loaded unless it changes from here on
driverStartedAt = Date.now();

let i = 0;
for (;;) {
  const plan = ROTATION[i++ % ROTATION.length];
  try {
    await setRushPref(plan.mode === "Colonist Rush");
    let p = await run(PROBE).catch(() => null);
    // If a game is already running (e.g. started by hand), adopt it instead of abandoning it.
    const adopt = p && /#\w+/.test(p.url) && p.rows > 0 && !p.won && p.gameOver.length === 0;
    if (!adopt) await restartDriverIfStale();
    const url = adopt ? p.url : await newGame(plan);
    const start = Date.now();
    log(`GAME_START ${adopt ? "(adopted)" : `${plan.mode}/${plan.diff}`} ${url}`);
    let lastProgress = Date.now();
    let lastSig = "";
    let reconnects = 0;
    for (;;) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      p = await run(PROBE).catch((e) => ({ error: String(e) }));
      if (p.error) { log(`ERROR probe: ${p.error}`); continue; }
      const sig = `${p.rows}|${p.lastRow}|${p.completedTurns}`;
      if (sig !== lastSig) { lastSig = sig; lastProgress = Date.now(); }
      if (p.lobby && p.rows === 0) {
        log(`GAME_OVER back in lobby after ${Math.round((Date.now() - start) / 60000)}m`);
        await harvestGameLogs();
        break;
      }
      if (p.won || p.gameOver.length) {
        log(`GAME_OVER ${p.won ?? p.gameOver.join("/")} after ${Math.round((Date.now() - start) / 60000)}m turns=${p.completedTurns} modeSetting=${p.modeSetting}`);
        await shot(`end-${Date.now()}`);
        await new Promise((r) => setTimeout(r, 15000)); // let the extension save its game log
        await harvestGameLogs();
        // leave the results screen so the next /newgame starts from the lobby
        await run(`const h = page.getByText("Home", { exact: true }).first(); if (await h.isVisible().catch(() => false)) await h.click().catch(() => {}); return true;`).catch(() => {});
        break;
      }
      // Dead page (no log rows, no panel, no state) for 90s in a game URL: the
      // end screen replaced the game view. Screenshot it so we learn its shape.
      if (p.rows === 0 && !p.note && p.completedTurns === null && Date.now() - lastProgress > 90000) {
        log(`GAME_ENDED? page went blank after ${Math.round((Date.now() - start) / 60000)}m — screenshotting`);
        await shot(`blank-${Date.now()}`);
        await harvestGameLogs();
        break;
      }
      if (p.disconnected) {
        reconnects++;
        log(`DISCONNECT (attempt ${reconnects}) note="${p.note}"`);
        await dismissDisconnect();
        if (reconnects >= 3) { log("GIVE_UP reconnecting"); break; }
        continue;
      }
      if (Date.now() - lastProgress > STALL_MS) {
        log(`STALL no progress for ${Math.round(STALL_MS / 60000)}m; turns=${p.completedTurns} note="${p.note}" last="${p.lastRow}"`);
        await shot(`stall-${Date.now()}`);
        await harvestGameLogs();
        break;
      }
      if (Date.now() - start > MAX_GAME_MS) { log("TIMEOUT game exceeded max length"); break; }
    }
  } catch (e) {
    log(`ERROR ${String(e).slice(0, 300)}`);
    await new Promise((r) => setTimeout(r, 30000));
  }
}
