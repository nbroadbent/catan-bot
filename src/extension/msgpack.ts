/**
 * Minimal MessagePack codec for colonist.io's WebSocket frames.
 * decode() covers the full core spec: nil, bool, int/uint (incl. 64),
 * float 32/64, str, bin, array, map, and ext (timestamps -> Date, others ->
 * {type, data}). encode() covers the JSON-ish subset needed to SEND frames:
 * null, boolean, number, string, array, plain object, Uint8Array.
 */

export function encode(value: unknown): Uint8Array {
  const chunks: number[] = [];
  const push = (...bytes: number[]) => chunks.push(...bytes);

  function pushU(v: number, bytes: number): void {
    for (let i = bytes - 1; i >= 0; i--) push((v >>> (i * 8)) & 0xff);
  }

  function any(v: unknown): void {
    if (v === null || v === undefined) {
      push(0xc0);
    } else if (typeof v === "boolean") {
      push(v ? 0xc3 : 0xc2);
    } else if (typeof v === "number") {
      if (Number.isInteger(v) && Math.abs(v) <= 0x7fffffff) {
        if (v >= 0 && v <= 127) push(v);
        else if (v < 0 && v >= -32) push(0x100 + v);
        else if (v >= 0 && v <= 0xff) push(0xcc, v);
        else if (v >= 0 && v <= 0xffff) { push(0xcd); pushU(v, 2); }
        else if (v >= 0) { push(0xce); pushU(v >>> 0, 4); }
        else if (v >= -128) { push(0xd0, v & 0xff); }
        else if (v >= -32768) { push(0xd1); pushU(v & 0xffff, 2); }
        else { push(0xd2); pushU(v >>> 0, 4); }
      } else {
        push(0xcb);
        const dv = new DataView(new ArrayBuffer(8));
        dv.setFloat64(0, v);
        for (let i = 0; i < 8; i++) push(dv.getUint8(i));
      }
    } else if (typeof v === "string") {
      const utf8 = new TextEncoder().encode(v);
      if (utf8.length <= 31) push(0xa0 + utf8.length);
      else if (utf8.length <= 0xff) push(0xd9, utf8.length);
      else { push(0xda); pushU(utf8.length, 2); }
      for (const b of utf8) push(b);
    } else if (v instanceof Uint8Array) {
      if (v.length <= 0xff) push(0xc4, v.length);
      else { push(0xc5); pushU(v.length, 2); }
      for (const b of v) push(b);
    } else if (Array.isArray(v)) {
      if (v.length <= 15) push(0x90 + v.length);
      else { push(0xdc); pushU(v.length, 2); }
      for (const item of v) any(item);
    } else if (typeof v === "object") {
      const entries = Object.entries(v as Record<string, unknown>).filter(
        ([, val]) => val !== undefined,
      );
      if (entries.length <= 15) push(0x80 + entries.length);
      else { push(0xde); pushU(entries.length, 2); }
      for (const [k, val] of entries) {
        any(k);
        any(val);
      }
    } else {
      throw new Error(`msgpack encode: unsupported type ${typeof v}`);
    }
  }

  any(value);
  return new Uint8Array(chunks);
}

export function decode(input: Uint8Array | ArrayBuffer): unknown {
  const buf = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let pos = 0;

  function u(bytes: number): number {
    let v = 0;
    for (let i = 0; i < bytes; i++) v = v * 256 + buf[pos++];
    return v;
  }

  function i64(): number {
    // JS numbers lose precision past 2^53; colonist ids fit comfortably
    const hi = view.getInt32(pos);
    const lo = view.getUint32(pos + 4);
    pos += 8;
    return hi * 4294967296 + lo;
  }

  function str(len: number): string {
    const slice = buf.subarray(pos, pos + len);
    pos += len;
    return new TextDecoder().decode(slice);
  }

  function bin(len: number): Uint8Array {
    const slice = buf.subarray(pos, pos + len);
    pos += len;
    return slice;
  }

  function arr(len: number): unknown[] {
    const out: unknown[] = [];
    for (let i = 0; i < len; i++) out.push(any());
    return out;
  }

  function map(len: number): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (let i = 0; i < len; i++) {
      const key = any();
      out[String(key)] = any();
    }
    return out;
  }

  function ext(len: number): unknown {
    const type = view.getInt8(pos);
    pos += 1;
    const data = bin(len);
    if (type === -1) {
      // timestamp ext
      if (len === 4) return new Date(new DataView(data.buffer, data.byteOffset, 4).getUint32(0) * 1000);
      if (len === 8) {
        const dv = new DataView(data.buffer, data.byteOffset, 8);
        const first = dv.getUint32(0);
        const nsec = first >>> 2;
        const sec = (first & 3) * 4294967296 + dv.getUint32(4);
        return new Date(sec * 1000 + nsec / 1e6);
      }
      if (len === 12) {
        const dv = new DataView(data.buffer, data.byteOffset, 12);
        const nsec = dv.getUint32(0);
        const hi = dv.getInt32(4);
        const lo = dv.getUint32(8);
        return new Date((hi * 4294967296 + lo) * 1000 + nsec / 1e6);
      }
    }
    return { type, data };
  }

  function any(): unknown {
    const b = buf[pos++];
    if (b <= 0x7f) return b; // positive fixint
    if (b >= 0xe0) return b - 256; // negative fixint
    if (b >= 0x80 && b <= 0x8f) return map(b - 0x80); // fixmap
    if (b >= 0x90 && b <= 0x9f) return arr(b - 0x90); // fixarray
    if (b >= 0xa0 && b <= 0xbf) return str(b - 0xa0); // fixstr
    switch (b) {
      case 0xc0: return null;
      case 0xc2: return false;
      case 0xc3: return true;
      case 0xc4: return bin(u(1));
      case 0xc5: return bin(u(2));
      case 0xc6: return bin(u(4));
      case 0xc7: return ext(u(1));
      case 0xc8: return ext(u(2));
      case 0xc9: return ext(u(4));
      case 0xca: { const v = view.getFloat32(pos); pos += 4; return v; }
      case 0xcb: { const v = view.getFloat64(pos); pos += 8; return v; }
      case 0xcc: return u(1);
      case 0xcd: return u(2);
      case 0xce: return u(4);
      case 0xcf: return u(8);
      case 0xd0: { const v = view.getInt8(pos); pos += 1; return v; }
      case 0xd1: { const v = view.getInt16(pos); pos += 2; return v; }
      case 0xd2: { const v = view.getInt32(pos); pos += 4; return v; }
      case 0xd3: return i64();
      case 0xd4: return ext(1);
      case 0xd5: return ext(2);
      case 0xd6: return ext(4);
      case 0xd7: return ext(8);
      case 0xd8: return ext(16);
      case 0xd9: return str(u(1));
      case 0xda: return str(u(2));
      case 0xdb: return str(u(4));
      case 0xdc: return arr(u(2));
      case 0xdd: return arr(u(4));
      case 0xde: return map(u(2));
      case 0xdf: return map(u(4));
      default:
        throw new Error(`msgpack: unknown byte 0x${b.toString(16)} at ${pos - 1}`);
    }
  }

  return any();
}
