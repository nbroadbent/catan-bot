// End-to-end smoke test: load the BUILT extension bundle into a jsdom page
// that mimics colonist.io's log structure, stream messages in, and check the
// overlay appears and updates. Run with: node scripts/smoke.mjs
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const bundle = readFileSync(new URL("../extension/content.js", import.meta.url), "utf8");

const dom = new JSDOM(
  `<!doctype html><html><head></head><body>
    <div class="web-header-username">Nick</div>
    <div id="scroller"></div>
  </body></html>`,
  { runScripts: "outside-only", pretendToBeVisual: true, url: "https://colonist.io/" },
);
const { window } = dom;

const bold = (name, color = "#e27174") =>
  `<span style="font-weight:600; color:${color}">${name}</span>`;
const img = (alt) => `<img alt="${alt}" src="x.svg">`;

let nextIndex = 0;
function addRow(html) {
  const el = window.document.createElement("div");
  el.setAttribute("data-index", String(nextIndex++));
  el.innerHTML = html;
  window.document.getElementById("scroller").appendChild(el);
}

// Pre-existing history (extension must sweep it on attach)
addRow(`${bold("Nick")} placed a ${img("settlement")}`);
addRow(`${bold("Ava", "#223697")} placed a ${img("settlement")}`);
addRow(`${bold("Nick")} received starting resources: ${img("ore")}${img("grain")}${img("grain")}`);

window.eval(bundle); // start the content script

// Feed colonist's REAL protocol (type 4 init + type 91 diff) from a captured
// game slice — the same frames inject.js forwards after msgpack-decoding.
const slice = JSON.parse(
  readFileSync(new URL("../src/extension/__fixtures__/capture-slice.json", import.meta.url), "utf8"),
);
const wsPost = (type, payload) =>
  window.postMessage({ __catan_copilot__: true, type, payload }, "*");
// header username must match the captured player so the overlay marks "(you)"
window.document.querySelector(".web-header-username").textContent = "LadyboyNick";
wsPost(slice.init.type, slice.init.payload); // full board + roster + my color
wsPost(slice.buildDiff.type, slice.buildDiff.payload); // a settlement on the board

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(2500); // let the 2s watcher attach + initial render

let overlay = window.document.getElementById("catan-copilot");
if (!overlay) throw new Error("SMOKE FAIL: overlay not injected after attach");

// Live log rows arrive (income-per-number learning still comes from the log)
addRow(`${bold("LadyboyNick")} rolled ${img("dice_4")}${img("dice_4")}`);
addRow(`${bold("LadyboyNick")} got: ${img("ore")}${img("ore")}`);
addRow(`${bold("Sera", "#223697")} rolled ${img("dice_3")}${img("dice_3")}`);
addRow(`${bold("Sera", "#223697")} got: ${img("brick")}${img("brick")}`);
await sleep(700); // debounce is 400ms

overlay = window.document.getElementById("catan-copilot");
const text = overlay.textContent;
const checks = [
  ["board captured from real protocol", overlay.querySelectorAll("svg polygon").length === 19],
  ["players from roster", text.includes("LadyboyNick") && text.includes("Sera")],
  ["you-detection", text.includes("(you)")],
  ["strategy section", text.includes("Your strategy")],
  ["recommendation", text.includes("RECOMMENDED")],
  ["balanced-dice deck", text.includes("Balanced-dice deck")],
  ["deck counting (an 8 and a 6 drawn: 34 left)", text.includes("34 cards left")],
  ["placement heading", text.includes("here") || text.includes("Expand") || text.includes("Best open spots")],
  ["spot descriptions", /pips/.test(text)],
];

let failed = false;
for (const [name, ok] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) failed = true;
}
if (failed) {
  console.log("\n--- overlay text ---\n" + text.slice(0, 1500));
  process.exit(1);
}
console.log("\nSMOKE OK — overlay attaches, sweeps history, follows live rows.");
process.exit(0);
