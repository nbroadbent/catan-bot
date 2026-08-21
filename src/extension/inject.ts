import { decode, encode } from "./msgpack";
import { patchSequence, readSequence } from "./seqRewrite";

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

const INTERESTING_IN = new Set([1, 4, 91]);
const MARKER = "__catan_copilot__";
const SEND_MARKER = "__catan_copilot_send__";

let gameSocket: WebSocket | null = null;
// Outbound game frames ride `[0x03, 0x01, len, ...serverId, ...msgpack]` and
// carry a per-client `sequence`. serverId addresses the channel.
let serverId: string | null = null;
const GAME_FRAME = 0x03;

// Single-owner sequence numbering. While `rewriting` is off (autopilot hasn't
// acted), colonist's own frames pass through UNTOUCHED — manual play is never
// altered. The first injected action turns rewriting on, seeding the counter
// from the last native sequence; from then on EVERY game frame (native or
// injected) is renumbered through `seqCounter`, so no collisions occur.
let rewriting = false;
let seqCounter = 0;
let lastNativeSeq = 1;

/** Reset per connection (a new socket / reconnect restarts colonist's counter). */
function resetSequencing(): void {
  rewriting = false;
  seqCounter = 0;
  lastNativeSeq = 1;
  serverId = null;
}

function post(msg: Record<string, unknown>): void {
  window.postMessage({ [MARKER]: true, ...msg }, "*");
}

function handleInbound(buf: ArrayBuffer | Uint8Array, ws: WebSocket | null = null): void {
  try {
    const msg = decode(buf) as { data?: { type?: number; payload?: unknown } } | null;
    const d = msg?.data;
    if (d && typeof d.type === "number") {
      // The socket that DELIVERS game frames is the game socket — learn it
      // from inbound traffic too. Waiting for an outbound game frame meant a
      // fresh game where the page hadn't acted yet (setup placement!) had no
      // known socket/channel, and every autopilot send was dropped silently.
      if (ws) gameSocket = ws;
      if (d.type === 1 && !serverId) {
        const id = (d.payload as { serverId?: unknown } | null)?.serverId;
        if (typeof id === "string" && id) serverId = id;
      }
      if (INTERESTING_IN.has(d.type)) {
        post({ type: d.type, payload: d.payload ?? null });
      }
      post({ dir: "in", frame: msg });
    }
  } catch {
    // not msgpack / not a game frame — ignore
  }
}

function toBytes(data: unknown): Uint8Array | null {
  if (typeof data === "string") return new TextEncoder().encode(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return null;
}

function b64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

/**
 * Colonist's outbound game actions ride a socket.io/engine.io envelope, so a
 * plain msgpack decode of the whole frame yields only the leading packet-type
 * byte (2 ping / 3 pong / 4 message) and drops the payload. To reverse the
 * real action format we forward the RAW bytes (base64) plus best-effort
 * decodes from a few offsets; a capture with this reveals the placement frame.
 */
function handleOutbound(data: unknown): void {
  const bytes = toBytes(data);
  if (!bytes || bytes.length === 0) return;
  // engine.io PING/PONG are tiny ("2"/"3"); skip the noise.
  if (bytes.length <= 2) return;

  const decodes: Record<string, unknown> = {};
  for (const off of [0, 1, 2]) {
    try {
      decodes[String(off)] = decode(bytes.subarray(off));
    } catch {
      /* not msgpack at this offset */
    }
  }
  post({ dir: "out", frame: decode(bytes.subarray(0, 1)), raw: b64(bytes), decodes });
}

/** Build a colonist game frame envelope around a msgpack action body. */
function buildGameFrame(body: unknown): Uint8Array {
  const channel = new TextEncoder().encode(serverId ?? "");
  const payload = encode(body);
  const out = new Uint8Array(3 + channel.length + payload.length);
  out[0] = GAME_FRAME;
  out[1] = 0x01;
  out[2] = channel.length;
  out.set(channel, 3);
  out.set(payload, 3 + channel.length);
  return out;
}

function tap(ws: WebSocket): void {
  ws.addEventListener("message", (ev: MessageEvent) => {
    const data = ev.data;
    if (data instanceof ArrayBuffer) handleInbound(data, ws);
    else if (data instanceof Blob) {
      data.arrayBuffer().then((b) => handleInbound(b, ws)).catch(() => undefined);
    }
  });
}

const OrigWebSocket = window.WebSocket;

// Prototype patch catches OUTBOUND traffic on every socket. For game frames we
// (a) identify the game socket and channel, (b) track the native sequence
// while rewriting is off, and (c) once rewriting is on, RENUMBER the frame's
// sequence through our counter before it hits the wire.
const origSend = OrigWebSocket.prototype.send;
OrigWebSocket.prototype.send = function (this: WebSocket, data: never) {
  let out: unknown = data;
  const bytes = toBytes(data);
  if (bytes && bytes.length > 2 && bytes[0] === GAME_FRAME) {
    gameSocket = this; // the socket that carries game frames
    const len = bytes[2];
    if (!serverId) serverId = new TextDecoder().decode(bytes.subarray(3, 3 + len));
    const cur = readSequence(bytes);
    if (cur !== null) {
      if (rewriting) {
        const patched = patchSequence(bytes, ++seqCounter);
        if (patched) out = patched;
      } else if (cur > lastNativeSeq) {
        lastNativeSeq = cur;
      }
    }
  }
  handleOutbound(data); // capture the ORIGINAL (unmodified) frame
  return origSend.call(this, out as never);
};

const Wrapped = new Proxy(OrigWebSocket, {
  construct(target, args: [string, (string | string[])?]) {
    resetSequencing(); // a fresh connection restarts colonist's counter
    const ws = new target(...args);
    tap(ws);
    return ws;
  },
});
window.WebSocket = Wrapped as typeof WebSocket;

// Autopilot send channel: the content script posts a list of {action,payload}
// game actions. The first send turns on sequence rewriting (seeded from the
// last native sequence); every action — and every native frame after — is
// numbered through our counter, so injected frames never collide.
window.addEventListener("message", (ev: MessageEvent) => {
  const data = ev.data as Record<string, unknown> | null;
  if (!data || data[SEND_MARKER] !== true) return;
  if (!gameSocket || gameSocket.readyState !== WebSocket.OPEN) return;
  if (!serverId) return; // can't address the channel yet
  const actions = data.actions as Array<{ action: number; payload: unknown }> | undefined;
  if (!Array.isArray(actions)) return;
  if (!rewriting) {
    rewriting = true;
    seqCounter = lastNativeSeq;
  }
  try {
    for (const a of actions) {
      const frame = buildGameFrame({ action: a.action, payload: a.payload, sequence: ++seqCounter });
      origSend.call(gameSocket, frame);
    }
  } catch {
    // encoding/send failure — autopilot simply doesn't act
  }
});
