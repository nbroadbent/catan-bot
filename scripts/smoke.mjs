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

// Simulate the page-world tap forwarding colonist board state (as the real
// inject.js would after decoding msgpack frames).
const KIND_TO_TILE_TYPE = { desert: 0, wood: 1, brick: 2, sheep: 3, wheat: 4, ore: 5 };
// a fixed standard layout: 19 hexes, radius-2 hexagon, spiral-ish tokens
const coords = [];
for (let q = -2; q <= 2; q++)
  for (let r = -2; r <= 2; r++) if (Math.abs(q + r) <= 2) coords.push({ x: q, y: r });
const kinds = ["ore","brick","ore","sheep","ore","wood","wheat","sheep","wood","wood","brick","wheat","desert","wheat","sheep","wood","brick","sheep","wheat"];
const tokens = [3, 8, 10, 6, 4, 5, 9, 2, 9, 11, 6, 3, null, 10, 12, 5, 8, 4, 11];
const wsPost = (type, payload) =>
  window.postMessage({ __catan_copilot__: true, type, payload }, "*");
wsPost(14, {
  tileState: {
    tiles: coords.map((c, i) => ({
      hexFace: c,
      tileType: KIND_TO_TILE_TYPE[kinds[i]],
      _diceNumber: tokens[i] ?? 0,
    })),
  },
  portState: { portEdges: [{ hexEdge: { x: 0, y: -2, z: 0 }, portType: 6 }] },
});
wsPost(8, { myColor: 2 });
wsPost(12, [{ username: "Nick", color: 2 }, { username: "Ava", color: 1 }]);

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
  ["placement heading", text.includes("settlement here") || text.includes("Best open spots")],
  ["minimap svg with badges", overlay.querySelectorAll("svg polygon").length === 19],
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
