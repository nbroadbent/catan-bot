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
    gameOver: textOf(/^(Game Over|Play Again|Back to Lobby|Return to Lobby|Rematch)$/i),
    disconnected: textOf(/^Disconnected/i).length > 0 || textOf(/^Reconnect$/i).length > 0,
    completedTurns: st?.gameState?.currentState?.completedTurns ?? null,
    modeSetting: st?.gameSettings?.modeSetting ?? null,
    note: note.slice(0, 160),
  };
});`;

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

let i = 0;
for (;;) {
  const plan = ROTATION[i++ % ROTATION.length];
  try {
    await setRushPref(plan.mode === "Colonist Rush");
    let p = await run(PROBE).catch(() => null);
    // If a game is already running (e.g. started by hand), adopt it instead of abandoning it.
    const adopt = p && /#\w+/.test(p.url) && p.rows > 0 && !p.won && p.gameOver.length === 0;
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
      if (p.won || p.gameOver.length) {
        log(`GAME_OVER ${p.won ?? p.gameOver.join("/")} after ${Math.round((Date.now() - start) / 60000)}m turns=${p.completedTurns} modeSetting=${p.modeSetting}`);
        await new Promise((r) => setTimeout(r, 15000)); // let the extension save its game log
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
        break;
      }
      if (Date.now() - start > MAX_GAME_MS) { log("TIMEOUT game exceeded max length"); break; }
    }
  } catch (e) {
    log(`ERROR ${String(e).slice(0, 300)}`);
    await new Promise((r) => setTimeout(r, 30000));
  }
}
