import { decode } from "./msgpack";

/**
 * Runs in the PAGE world (injected via <script src>), where it can wrap
 * window.WebSocket before colonist.io connects. Decodes msgpack frames and
 * forwards the handful of event types the copilot needs to the content script
 * via postMessage. Read-only: never sends or alters socket traffic.
 */

const INTERESTING = new Set([1, 8, 9, 12, 14, 15, 16, 17, 45]);
const MARKER = "__catan_copilot__";

function forward(buf: ArrayBuffer | Uint8Array): void {
  try {
    const msg = decode(buf) as { data?: { type?: number; payload?: unknown } } | null;
    const d = msg?.data;
    if (d && typeof d.type === "number" && INTERESTING.has(d.type)) {
      window.postMessage({ [MARKER]: true, type: d.type, payload: d.payload ?? null }, "*");
    }
  } catch {
    // not msgpack / not a game frame — ignore
  }
}

function tap(ws: WebSocket): void {
  ws.addEventListener("message", (ev: MessageEvent) => {
    const data = ev.data;
    if (data instanceof ArrayBuffer) forward(data);
    else if (data instanceof Blob) {
      data.arrayBuffer().then(forward).catch(() => undefined);
    }
  });
}

const OrigWebSocket = window.WebSocket;
const Wrapped = new Proxy(OrigWebSocket, {
  construct(target, args: [string, (string | string[])?]) {
    const ws = new target(...args);
    tap(ws);
    return ws;
  },
});
window.WebSocket = Wrapped as typeof WebSocket;
