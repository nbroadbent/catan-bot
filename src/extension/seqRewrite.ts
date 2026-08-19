/**
 * Colonist numbers every outbound game frame with a `sequence` that its own
 * code counts up by 1, and inbound frames carry no sequence to reconcile
 * against — so the counter is purely client-side and fire-and-forget. That
 * means if autopilot injects a frame, it consumes a number colonist's code
 * doesn't know about, and colonist's NEXT frame reuses it → the server sees a
 * collision and drops the connection ("reconnecting…").
 *
 * The fix: make one counter own ALL outbound sequences. We rewrite the
 * `sequence` value in every game frame (colonist's own included) to our
 * counter, so injected and native frames form a single clean monotonic
 * stream. These helpers do the minimal byte-level edit — only the sequence
 * value changes; the rest of the frame is untouched — so a decode/re-encode
 * bug can't corrupt real frames.
 */

// msgpack bytes for the map key "sequence": 0xa8 (fixstr len 8) + ascii
export const SEQUENCE_KEY = new Uint8Array([
  0xa8, 0x73, 0x65, 0x71, 0x75, 0x65, 0x6e, 0x63, 0x65,
]);

function indexOfKey(bytes: Uint8Array): number {
  outer: for (let i = 0; i + SEQUENCE_KEY.length <= bytes.length; i++) {
    for (let j = 0; j < SEQUENCE_KEY.length; j++) {
      if (bytes[i + j] !== SEQUENCE_KEY[j]) continue outer;
    }
    return i + SEQUENCE_KEY.length; // offset of the value that follows the key
  }
  return -1;
}

/** Width (bytes) and value of the msgpack uint at `i`, or null if not a uint. */
function readUint(bytes: Uint8Array, i: number): { width: number; value: number } | null {
  const b = bytes[i];
  if (b <= 0x7f) return { width: 1, value: b }; // positive fixint
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  switch (b) {
    case 0xcc: return { width: 2, value: bytes[i + 1] };
    case 0xcd: return { width: 3, value: dv.getUint16(i + 1) };
    case 0xce: return { width: 5, value: dv.getUint32(i + 1) };
    case 0xcf: return { width: 9, value: Number(dv.getBigUint64(i + 1)) };
    default: return null;
  }
}

/** The sequence value carried by a full game frame, or null if absent. */
export function readSequence(frame: Uint8Array): number | null {
  const at = indexOfKey(frame);
  if (at === -1) return null;
  return readUint(frame, at)?.value ?? null;
}

/** uint32 encoding — a fixed 5-byte width we always write for the new value. */
function encodeUint32(v: number): Uint8Array {
  const out = new Uint8Array(5);
  out[0] = 0xce;
  new DataView(out.buffer).setUint32(1, v >>> 0);
  return out;
}

/**
 * Return a copy of `frame` with its `sequence` value replaced by `newSeq`
 * (encoded as uint32). Only the sequence value bytes are swapped. Null if the
 * frame carries no sequence key.
 */
export function patchSequence(frame: Uint8Array, newSeq: number): Uint8Array | null {
  const at = indexOfKey(frame);
  if (at === -1) return null;
  const cur = readUint(frame, at);
  if (!cur) return null;
  const replacement = encodeUint32(newSeq);
  const out = new Uint8Array(frame.length - cur.width + replacement.length);
  out.set(frame.subarray(0, at), 0);
  out.set(replacement, at);
  out.set(frame.subarray(at + cur.width), at + replacement.length);
  return out;
}
