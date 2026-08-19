// Local bridge: the browser extension can't write files, so it POSTs its live
// game state here and this writes it to .context/live-state.json, which the
// Claude Code session watches to coach in real time.
//
//   node scripts/bridge.mjs
//
// Listens on 127.0.0.1 only (never exposed off-machine). Overwrites one file.
import http from "node:http";
import { writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CTX = join(ROOT, ".context");
const STATE = join(CTX, "live-state.json");
const GAMELOG = join(CTX, "game-logs.jsonl");
mkdirSync(CTX, { recursive: true });

const PORT = 8137;

http
  .createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }
    if (req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          if (req.url === "/gamelog") {
            // one finished game per line, accumulated across games
            appendFileSync(GAMELOG, body.replace(/\n/g, " ") + "\n");
          } else {
            writeFileSync(STATE, body); // live state (overwritten)
          }
        } catch {
          /* ignore write errors */
        }
        res.writeHead(200).end("ok");
      });
      return;
    }
    res.writeHead(200).end("catan bridge up");
  })
  .listen(PORT, "127.0.0.1", () => {
    console.log(`bridge on http://127.0.0.1:${PORT} -> ${STATE} + ${GAMELOG}`);
  });
