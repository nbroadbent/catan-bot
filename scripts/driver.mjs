// Long-running browser driver for playing colonist.io with the extension.
// Launches persistent Chromium with the unpacked extension and exposes a
// localhost HTTP control API:
//   POST /run   body = JS source, run as async fn with {page, context} in scope
//   GET  /shot?name=foo  -> screenshot to .context/shots/foo.png
//   GET  /status         -> url + overlay note + recent console errors
import { chromium } from "playwright";
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extDir = path.join(root, "extension");
const profileDir = path.join(root, ".context", "chrome-profile");
const shotDir = path.join(root, ".context", "shots");
fs.mkdirSync(shotDir, { recursive: true });

const consoleErrors = [];
const context = await chromium.launchPersistentContext(profileDir, {
  channel: "chromium",
  headless: !process.env.HEADFUL,
  viewport: { width: 1600, height: 1000 },
  ignoreDefaultArgs: ["--enable-automation"],
  args: [
    `--disable-extensions-except=${extDir}`,
    `--load-extension=${extDir}`,
    "--disable-blink-features=AutomationControlled",
    // Keep the game socket's heartbeat alive: headless throttles timers on
    // occluded/backgrounded tabs, which lapses colonist's ping and drops us.
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
  ],
});
// Strip the navigator.webdriver flag that Cloudflare keys on, and keep the
// page reporting itself as visible/focused so colonist's socket heartbeat
// timers aren't throttled (headless drops the game socket otherwise).
await context.addInitScript(() => {
  Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  Object.defineProperty(document, "visibilityState", { get: () => "visible" });
  Object.defineProperty(document, "hidden", { get: () => false });
  // Mirror the extension's decoded game frames (posted by inject.js into the
  // page world) into window.__ccState so the driver can compute exact board
  // geometry from ground truth instead of guessing pixels.
  const merge = (dst, src) => {
    for (const [k, v] of Object.entries(src)) {
      if (v && typeof v === "object" && !Array.isArray(v) && dst[k] && typeof dst[k] === "object") {
        merge(dst[k], v);
      } else {
        dst[k] = v;
      }
    }
  };
  // Full protocol capture (both directions, as the extension decodes them),
  // retrievable via /run: window.__ccCapture. Lets unattended bot games
  // yield the frames for actions we haven't reverse-engineered yet.
  window.__ccCapture = [];
  window.addEventListener("message", (ev) => {
    const d = ev.data;
    if (d && d.__catan_copilot__ === true && d.dir && d.frame !== undefined) {
      if (window.__ccCapture.length < 6000) window.__ccCapture.push({ t: Date.now(), dir: d.dir, frame: d.frame, decodes: d.decodes });
      return;
    }
    if (!d || d.__catan_copilot__ !== true || typeof d.type !== "number") return;
    if (d.type === 4 && d.payload) {
      window.__ccState = JSON.parse(JSON.stringify(d.payload));
    } else if (d.type === 91 && d.payload?.diff && window.__ccState) {
      merge(window.__ccState, JSON.parse(JSON.stringify(d.payload.diff)));
    }
  });
});
const page = context.pages()[0] ?? (await context.newPage());
// Emulate a focused page: without this, headless treats the tab as
// backgrounded, throttles its timers, and colonist's socket heartbeat lapses
// (the server then drops you every ~60-90s mid-game).
try {
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
} catch {
  // older CDP — best effort
}
page.on("console", (msg) => {
  if (msg.type() === "error") {
    consoleErrors.push(msg.text().slice(0, 300));
    if (consoleErrors.length > 50) consoleErrors.shift();
  }
});
page.on("pageerror", (err) => {
  consoleErrors.push(`pageerror: ${String(err).slice(0, 300)}`);
  if (consoleErrors.length > 50) consoleErrors.shift();
});

// If the browser dies (or is killed), exit so a stale server never answers
// /newgame with "browser has been closed".
context.on("close", () => {
  console.log("browser closed — exiting driver");
  process.exit(1);
});

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  res.setHeader("content-type", "application/json");
  try {
    if (req.method === "POST" && url.pathname === "/run") {
      const src = await readBody(req);
      const fn = new Function(
        "page",
        "context",
        `return (async () => { ${src} })()`,
      );
      const result = await fn(page, context);
      res.end(JSON.stringify({ ok: true, result: result ?? null }, null, 1));
    } else if (url.pathname === "/shot") {
      const name = url.searchParams.get("name") ?? "shot";
      const file = path.join(shotDir, `${name}.png`);
      await page.screenshot({ path: file, animations: "disabled", timeout: 15000 });
      res.end(JSON.stringify({ ok: true, file }));
    } else if (url.pathname === "/newgame") {
      // Lobby (2026-08 UI): Play tab -> "Play vs. Bots" card (+ difficulty)
      // -> orange "Start Game" button. Dismiss the guest/account popups first.
      const diff = url.searchParams.get("diff") ?? "Easy";
      const mode = url.searchParams.get("mode") ?? "Play vs. Bots"; // or "Colonist Rush"
      const players = url.searchParams.get("players") ?? "4"; // "2" = 1v1 (1 bot)

      // Ranked 1v1 matchmaking: Play -> Ranked tab -> "1v1" card -> Start Game,
      // then wait for a match (the URL gains a game hash when one is found).
      if (mode === "Ranked 1v1") {
        // If a search is already running (thin queue at off-hours), DON'T
        // restart it — restarting resets accumulated queue time. Just poll.
        const alreadySearching = await page
          .evaluate(() => /Searching For Ranked/i.test(document.body.textContent || ""))
          .catch(() => false);
        // The hash present when queueing starts is the OLD game (colonist keeps
        // the finished game's page up and lets you queue from its results
        // screen). A match is only real when the hash CHANGES from this.
        const startHash = await page.evaluate(() => (location.hash || "").slice(1)).catch(() => "");
        if (!alreadySearching) {
        await page.goto("https://colonist.io/", { waitUntil: "domcontentloaded", timeout: 60000 });
        await page.waitForTimeout(4000);
        for (const t of ["Continue as Guest", "Maybe later", "Not now", "Close"]) {
          const b = page.getByText(t, { exact: true }).first();
          if (await b.isVisible().catch(() => false)) await b.click({ timeout: 3000 }).catch(() => {});
        }
        await page.getByText("Play", { exact: true }).first().click({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(900);
        await page.getByText("Ranked", { exact: true }).first().click({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(1200);
        // the 1v1 card (its title text sits in the card header)
        await page.getByText("1v1", { exact: true }).first().click({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(600);
        const start = page.locator(".mm-details-container .mm-mode-card-button, #mm-details-play-button, .mm-mode-card-button:visible").filter({ hasText: "Start Game" }).first();
        if (await start.isVisible().catch(() => false)) await start.click({ timeout: 3000 }).catch(() => {});
        else await page.mouse.click(700, 751);
        }
        // matchmaking: poll up to 4 minutes per call (Node's fetch client drops
        // a request whose headers take > 5 min); the loop re-calls while the
        // search is still running, without restarting it
        let loaded = false;
        // first call after a game spends time navigating; keep the total under 5 min
        const budget = alreadySearching ? 120 : 100;
        for (let t = 0; t < budget && !loaded; t++) {
          await page.waitForTimeout(2000);
          // a match navigates the page mid-poll and destroys this evaluate's
          // context — that's success in progress, not an error: retry next tick
          loaded = await page.evaluate((startHash) => {
            const h = (location.hash || "").slice(1);
            if (!h || h === startHash) return false; // same (finished) game, not a new match
            const rows = [...document.querySelectorAll("[data-index]")];
            if (rows.some((r) => /won the game/i.test(r.textContent || ""))) return false; // stale results page
            return rows.length > 0 || !!document.querySelector("#catan-copilot .cc-wname");
          }, startHash).catch(() => false);
          // if the search silently dropped back to the lobby, re-queue once
          if (!loaded && t > 5 && t % 30 === 0) {
            const still = await page.evaluate(() => /Searching For Ranked/i.test(document.body.textContent || "")).catch(() => true);
            const inGame = await page.evaluate(() => /#\w+/.test(location.href)).catch(() => true);
            if (!still && !inGame) { const s = page.getByText("Start Game", { exact: true }).first(); if (await s.isVisible().catch(() => false)) await s.click({ timeout: 3000 }).catch(() => {}); }
          }
        }
        res.end(JSON.stringify({ ok: true, started: loaded, url: page.url(), searching: !loaded }));
        return;
      }

      // 1v1 (2 players) has no lobby card — it needs a PRIVATE Create Room with
      // one bot, so no real player can join. Verified layout (2026-08).
      if (players === "2") {
        await page.goto("https://colonist.io/", { waitUntil: "domcontentloaded", timeout: 60000 });
        await page.waitForTimeout(4000);
        for (const t of ["Continue as Guest", "Maybe later", "Not now", "Close"]) {
          const b = page.getByText(t, { exact: true }).first();
          if (await b.isVisible().catch(() => false)) await b.click().catch(() => {});
        }
        await page.getByText("Rooms", { exact: true }).first().click().catch(() => {});
        await page.waitForTimeout(900);
        await page.getByText("Create Room", { exact: true }).first().click().catch(() => {});
        await page.waitForTimeout(1600);
        // make it PRIVATE first so it is never listed in Open Rooms
        await page.getByText("Private Game", { exact: true }).first().click().catch(() => {});
        await page.waitForTimeout(500);
        // Set Max Players to exactly 2: read the value and step with the "<"
        // (951,853) / ">" (1068,853) chevrons until it reads 2 (guard the loop).
        const maxPlayers = async () => page.evaluate(() => {
          const lbl = [...document.querySelectorAll("*")].find((e) => /Max Players/.test(e.textContent || "") && e.children.length <= 4);
          const m = (lbl?.closest("div")?.textContent || "").match(/(\d+)\s*\/\s*\d+/);
          return m ? parseInt(m[1], 10) : null;
        });
        for (let k = 0; k < 8; k++) {
          const v = await maxPlayers();
          if (v === 2 || v === null) break;
          await page.mouse.click(v > 2 ? 951 : 1068, 853);
          await page.waitForTimeout(350);
        }
        // add exactly one bot: click the green "Add Bot" button (ancestor of the
        // label), coords as fallback.
        const addBot = page.locator("button, [class*=button], [class*=Button]").filter({ hasText: "Add Bot" }).first();
        if (await addBot.isVisible().catch(() => false)) await addBot.click().catch(() => {});
        else await page.mouse.click(332, 282);
        await page.waitForTimeout(1300);
        // roster must be exactly 2 (us + one bot) before starting
        const roster = await page.evaluate(() => (document.body.textContent.match(/Players \((\d)\/(\d)\)/) || []).slice(1));
        if (roster[0] !== "2") {
          res.end(JSON.stringify({ ok: true, started: false, url: page.url(), reason: `roster ${roster.join("/")}` }));
          return;
        }
        // Start Game, then POLL until the game actually loads (extension panel +
        // real game state). Retry the button a few times — a single click on
        // the canvas-heavy transition is unreliable.
        let loaded = false;
        for (let attempt = 0; attempt < 3 && !loaded; attempt++) {
          const start = page.getByText("Start Game", { exact: true }).first();
          if (await start.isVisible().catch(() => false)) await start.click().catch(() => {});
          else await page.mouse.click(864, 919);
          for (let t = 0; t < 12 && !loaded; t++) {
            await page.waitForTimeout(1500);
            loaded = await page.evaluate(() =>
              document.querySelectorAll("[data-index]").length > 0 ||
              !!document.querySelector("#catan-copilot .cc-wname"),
            );
          }
        }
        res.end(JSON.stringify({ ok: true, started: loaded, url: page.url() }));
        return;
      }
      await page.goto("https://colonist.io/", { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(4000);
      for (const t of ["Continue as Guest", "Maybe later", "Not now", "Close"]) {
        const b = page.getByText(t, { exact: true }).first();
        if (await b.isVisible().catch(() => false)) await b.click().catch(() => {});
      }
      const playNav = page.getByText("Play", { exact: true }).first();
      if (await playNav.isVisible().catch(() => false)) await playNav.click().catch(() => {});
      await page.waitForTimeout(1200);
      const bots = page.getByText("Bots", { exact: true }).first();
      if (await bots.isVisible().catch(() => false)) await bots.click().catch(() => {});
      await page.waitForTimeout(600);
      const card = page.locator("div", { hasText: new RegExp(`^\\s*${mode}`) }).filter({ has: page.getByText(diff, { exact: true }) }).last();
      const title = page.getByText(mode, { exact: true }).first();
      if (await title.isVisible().catch(() => false)) await title.click().catch(() => {});
      await page.waitForTimeout(500);
      // player-count toggle on the detail page: "1v1" (2 players) or "4 Player"
      const toggle = players === "2" ? "1v1" : "4 Player";
      const tg = page.getByText(toggle, { exact: true }).first();
      if (await tg.isVisible().catch(() => false)) await tg.click().catch(() => {});
      await page.waitForTimeout(400);
      // difficulty chip inside the selected card (falls back to any visible chip)
      const chip = card.getByText(diff, { exact: true }).first();
      if (await chip.isVisible().catch(() => false)) await chip.click().catch(() => {});
      await page.waitForTimeout(400);
      let started = false;
      for (let i = 0; i < 15 && !started; i++) {
        // the lobby keeps hidden duplicates of this button — take the visible one
        const start = page.locator(".mm-details-container .mm-mode-card-button, #mm-details-play-button, .mm-mode-card-button:visible").filter({ hasText: "Start Game" }).first();
        if (await start.isVisible().catch(() => false)) {
          await start.click().catch(() => {});
          started = true;
        } else await page.waitForTimeout(1000);
      }
      await page.waitForTimeout(12000);
      res.end(JSON.stringify({ ok: true, started, url: page.url() }));
    } else if (url.pathname === "/status") {
      const note = await page
        .evaluate(() => {
          const panel = document.querySelector("#catan-copilot");
          const notes = panel
            ? [...panel.querySelectorAll(".cc-note")].map((n) => n.textContent)
            : [];
          return { panel: !!panel, notes };
        })
        .catch((e) => ({ evalError: String(e).slice(0, 200) }));
      res.end(
        JSON.stringify(
          { ok: true, url: page.url(), overlay: note, consoleErrors: consoleErrors.slice(-10) },
          null,
          1,
        ),
      );
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ ok: false, error: "unknown endpoint" }));
    }
  } catch (err) {
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false, error: String(err).slice(0, 1000) }));
  }
});
// Long-running control requests (ranked matchmaking polls for up to ~8 min);
// Node's default 5-minute requestTimeout would destroy them ("fetch failed").
server.requestTimeout = 0;
server.headersTimeout = 0;
server.keepAliveTimeout = 0;
server.listen(9377, "127.0.0.1", () => {
  console.log("driver ready on http://127.0.0.1:9377");
});
