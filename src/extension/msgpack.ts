/**
 * Minimal MessagePack DECODER (no encoder) — enough to read colonist.io's
 * WebSocket frames. Covers the full core spec: nil, bool, int/uint (incl. 64),
 * float 32/64, str, bin, array, map, and ext (timestamps -> Date, others ->
 * {type, data}).
 */

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
