import { describe, expect, it } from "vitest";
import { readSequence, patchSequence } from "./seqRewrite";
import { encode, decode } from "./msgpack";

/** A colonist game frame: [0x03,0x01,len,...serverId,...msgpack{action,payload,sequence}] */
function frame(body: Record<string, unknown>, serverId = "06CB20"): Uint8Array {
  const ch = new TextEncoder().encode(serverId);
  const payload = encode(body);
  const out = new Uint8Array(3 + ch.length + payload.length);
  out[0] = 0x03;
  out[1] = 0x01;
  out[2] = ch.length;
  out.set(ch, 3);
  out.set(payload, 3 + ch.length);
  return out;
}

function bodyOf(f: Uint8Array): Record<string, unknown> {
  const len = f[2];
  return decode(f.subarray(3 + len)) as Record<string, unknown>;
}

describe("sequence rewriting", () => {
  it("reads the sequence from a real-shaped frame", () => {
    const f = frame({ action: 15, payload: 52, sequence: 117 });
    expect(readSequence(f)).toBe(117);
  });

  it("reads sequences encoded at any width (fixint / uint8 / uint16)", () => {
    for (const seq of [5, 117, 200, 300, 65535, 70000]) {
      expect(readSequence(frame({ action: 2, payload: true, sequence: seq }))).toBe(seq);
    }
  });

  it("patches only the sequence, leaving action and payload intact", () => {
    const f = frame({ action: 15, payload: 52, sequence: 117 });
    const patched = patchSequence(f, 999)!;
    expect(patched).not.toBeNull();
    const body = bodyOf(patched);
    expect(body.sequence).toBe(999);
    expect(body.action).toBe(15);
    expect(body.payload).toBe(52);
    // envelope preserved
    expect(patched[0]).toBe(0x03);
    expect(patched[1]).toBe(0x01);
  });

  it("patches frames with array payloads (discard) without corrupting them", () => {
    const f = frame({ action: 7, payload: [3, 5, 1, 3], sequence: 13 });
    const patched = patchSequence(f, 42)!;
    const body = bodyOf(patched);
    expect(body.sequence).toBe(42);
    expect(body.action).toBe(7);
    expect(body.payload).toEqual([3, 5, 1, 3]);
  });

  it("grows the width safely when the new sequence is larger", () => {
    // original fixint (1 byte) -> uint32 (5 bytes): frame must grow by 4
    const f = frame({ action: 2, payload: true, sequence: 5 });
    const patched = patchSequence(f, 100000)!;
    expect(patched.length).toBe(f.length + 4);
    expect(bodyOf(patched).sequence).toBe(100000);
  });

  it("returns null when there is no sequence key", () => {
    const f = frame({ action: 2, payload: true }); // no sequence
    expect(readSequence(f)).toBeNull();
    expect(patchSequence(f, 10)).toBeNull();
  });

  it("renumbers a stream monotonically (simulating the injection offset)", () => {
    // native frames 100,101; inject 2; native 102 must become 104 (not collide)
    let counter = 101; // last native seen
    const inject1 = frame({ action: 15, payload: 52, sequence: 0 });
    const inject2 = frame({ action: 6, payload: true, sequence: 0 });
    const p1 = patchSequence(inject1, ++counter)!; // 102
    const p2 = patchSequence(inject2, ++counter)!; // 103
    const native = frame({ action: 2, payload: true, sequence: 102 }); // client reused 102
    const pn = patchSequence(native, ++counter)!; // 104 — no collision
    expect(bodyOf(p1).sequence).toBe(102);
    expect(bodyOf(p2).sequence).toBe(103);
    expect(bodyOf(pn).sequence).toBe(104);
  });
});
