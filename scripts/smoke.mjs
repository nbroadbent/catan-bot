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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(2500); // let the 2s watcher attach + initial render

let overlay = window.document.getElementById("catan-copilot");
if (!overlay) throw new Error("SMOKE FAIL: overlay not injected after attach");

// Live messages arrive
addRow(`${bold("Nick")} rolled ${img("dice_4")}${img("dice_4")}`);
addRow(`${bold("Nick")} got: ${img("ore")}${img("ore")}`);
addRow(`${bold("Ava", "#223697")} rolled ${img("dice_3")}${img("dice_3")}`);
addRow(`${bold("Ava", "#223697")} got: ${img("brick")}${img("brick")}`);
await sleep(700); // debounce is 400ms

overlay = window.document.getElementById("catan-copilot");
const text = overlay.textContent;
const checks = [
  ["Balanced-dice deck", text.includes("Balanced-dice deck")],
  ["players table", text.includes("Nick") && text.includes("Ava")],
  ["you-detection", text.includes("(you)")],
  ["strategy section", text.includes("Your strategy")],
  ["recommendation", text.includes("RECOMMENDED")],
  ["robber advice", text.includes("Robber")],
  ["deck counting (an 8 and a 6 drawn: 34 left)", text.includes("34 cards left")],
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
