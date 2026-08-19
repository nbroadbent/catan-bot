import { decode, encode } from "./msgpack";

/**
 * Runs in the PAGE world as a MAIN-world content script at document_start, so
 * window.WebSocket is wrapped synchronously before any colonist.io script
 * loads. Three jobs:
 *
 *  1. Forward decoded INBOUND game frames to the content script (board state,
 *     builds, play order, …).
 *  2. Forward decoded OUTBOUND frames too ("protocol capture") — this is how
 *     the action message format for autopilot gets reverse-engineered from a
 *     manually played game.
 *  3. Accept send requests from the content script and write them to the live
 *     game socket (autopilot's hands — unused until action templates exist).
 */

const INTERESTING_IN = new Set([1, 8, 9, 12, 14, 15, 16, 17, 45]);
const MARKER = "__catan_copilot__";
const SEND_MARKER = "__catan_copilot_send__";

let gameSocket: WebSocket | null = null;

function post(msg: Record<string, unknown>): void {
  window.postMessage({ [MARKER]: true, ...msg }, "*");
}

function handleInbound(buf: ArrayBuffer | Uint8Array): void {
  try {
    const msg = decode(buf) as { data?: { type?: number; payload?: unknown } } | null;
    const d = msg?.data;
    if (d && typeof d.type === "number") {
      if (INTERESTING_IN.has(d.type)) {
        post({ type: d.type, payload: d.payload ?? null });
      }
      post({ dir: "in", frame: msg });
    }
  } catch {
    // not msgpack / not a game frame — ignore
  }
}

function handleOutbound(data: unknown): void {
  try {
    let buf: ArrayBuffer | Uint8Array | null = null;
    if (data instanceof ArrayBuffer) buf = data;
    else if (ArrayBuffer.isView(data)) {
      buf = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    if (!buf) return;
    post({ dir: "out", frame: decode(buf) });
  } catch {
    // ignore undecodable frames
  }
}

function tap(ws: WebSocket, url: string): void {
  if (/colonist/i.test(url) || /socket/i.test(url)) gameSocket = ws;
  ws.addEventListener("message", (ev: MessageEvent) => {
    const data = ev.data;
    if (data instanceof ArrayBuffer) handleInbound(data);
    else if (data instanceof Blob) {
      data.arrayBuffer().then(handleInbound).catch(() => undefined);
    }
  });
}

const OrigWebSocket = window.WebSocket;

// Prototype patch catches OUTBOUND traffic on every socket — even ones
// created before this script ran (method lookup is dynamic).
const origSend = OrigWebSocket.prototype.send;
OrigWebSocket.prototype.send = function (data: never) {
  handleOutbound(data);
  return origSend.call(this, data);
};

const Wrapped = new Proxy(OrigWebSocket, {
  construct(target, args: [string, (string | string[])?]) {
    const ws = new target(...args);
    tap(ws, String(args[0] ?? ""));
    return ws;
  },
});
window.WebSocket = Wrapped as typeof WebSocket;

// Autopilot send channel: the content script posts a frame object; we encode
// and write it to the live game socket.
window.addEventListener("message", (ev: MessageEvent) => {
  const data = ev.data as Record<string, unknown> | null;
  if (!data || data[SEND_MARKER] !== true) return;
  if (!gameSocket || gameSocket.readyState !== WebSocket.OPEN) return;
  try {
    origSend.call(gameSocket, encode(data.frame));
  } catch {
    // encoding/send failure — autopilot simply doesn't act
  }
});
