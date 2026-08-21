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
  window.addEventListener("message", (ev) => {
    const d = ev.data;
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
server.listen(9377, "127.0.0.1", () => {
  console.log("driver ready on http://127.0.0.1:9377");
});
