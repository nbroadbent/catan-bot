(function() {
  "use strict";
  function decode(input) {
    const buf = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let pos = 0;
    function u(bytes) {
      let v = 0;
      for (let i = 0; i < bytes; i++) v = v * 256 + buf[pos++];
      return v;
    }
    function i64() {
      const hi = view.getInt32(pos);
      const lo = view.getUint32(pos + 4);
      pos += 8;
      return hi * 4294967296 + lo;
    }
    function str(len) {
      const slice = buf.subarray(pos, pos + len);
      pos += len;
      return new TextDecoder().decode(slice);
    }
    function bin(len) {
      const slice = buf.subarray(pos, pos + len);
      pos += len;
      return slice;
    }
    function arr(len) {
      const out = [];
      for (let i = 0; i < len; i++) out.push(any());
      return out;
    }
    function map(len) {
      const out = {};
      for (let i = 0; i < len; i++) {
        const key = any();
        out[String(key)] = any();
      }
      return out;
    }
    function ext(len) {
      const type = view.getInt8(pos);
      pos += 1;
      const data = bin(len);
      if (type === -1) {
        if (len === 4) return new Date(new DataView(data.buffer, data.byteOffset, 4).getUint32(0) * 1e3);
        if (len === 8) {
          const dv = new DataView(data.buffer, data.byteOffset, 8);
          const first = dv.getUint32(0);
          const nsec = first >>> 2;
          const sec = (first & 3) * 4294967296 + dv.getUint32(4);
          return new Date(sec * 1e3 + nsec / 1e6);
        }
        if (len === 12) {
          const dv = new DataView(data.buffer, data.byteOffset, 12);
          const nsec = dv.getUint32(0);
          const hi = dv.getInt32(4);
          const lo = dv.getUint32(8);
          return new Date((hi * 4294967296 + lo) * 1e3 + nsec / 1e6);
        }
      }
      return { type, data };
    }
    function any() {
      const b = buf[pos++];
      if (b <= 127) return b;
      if (b >= 224) return b - 256;
      if (b >= 128 && b <= 143) return map(b - 128);
      if (b >= 144 && b <= 159) return arr(b - 144);
      if (b >= 160 && b <= 191) return str(b - 160);
      switch (b) {
        case 192:
          return null;
        case 194:
          return false;
        case 195:
          return true;
        case 196:
          return bin(u(1));
        case 197:
          return bin(u(2));
        case 198:
          return bin(u(4));
        case 199:
          return ext(u(1));
        case 200:
          return ext(u(2));
        case 201:
          return ext(u(4));
        case 202: {
          const v = view.getFloat32(pos);
          pos += 4;
          return v;
        }
        case 203: {
          const v = view.getFloat64(pos);
          pos += 8;
          return v;
        }
        case 204:
          return u(1);
        case 205:
          return u(2);
        case 206:
          return u(4);
        case 207:
          return u(8);
        case 208: {
          const v = view.getInt8(pos);
          pos += 1;
          return v;
        }
        case 209: {
          const v = view.getInt16(pos);
          pos += 2;
          return v;
        }
        case 210: {
          const v = view.getInt32(pos);
          pos += 4;
          return v;
        }
        case 211:
          return i64();
        case 212:
          return ext(1);
        case 213:
          return ext(2);
        case 214:
          return ext(4);
        case 215:
          return ext(8);
        case 216:
          return ext(16);
        case 217:
          return str(u(1));
        case 218:
          return str(u(2));
        case 219:
          return str(u(4));
        case 220:
          return arr(u(2));
        case 221:
          return arr(u(4));
        case 222:
          return map(u(2));
        case 223:
          return map(u(4));
        default:
          throw new Error(`msgpack: unknown byte 0x${b.toString(16)} at ${pos - 1}`);
      }
    }
    return any();
  }
  const INTERESTING = /* @__PURE__ */ new Set([1, 8, 9, 12, 14, 15, 16, 17, 45]);
  const MARKER = "__catan_copilot__";
  function forward(buf) {
    try {
      const msg = decode(buf);
      const d = msg == null ? void 0 : msg.data;
      if (d && typeof d.type === "number" && INTERESTING.has(d.type)) {
        window.postMessage({ [MARKER]: true, type: d.type, payload: d.payload ?? null }, "*");
      }
    } catch {
    }
  }
  function tap(ws) {
    ws.addEventListener("message", (ev) => {
      const data = ev.data;
      if (data instanceof ArrayBuffer) forward(data);
      else if (data instanceof Blob) {
        data.arrayBuffer().then(forward).catch(() => void 0);
      }
    });
  }
  const OrigWebSocket = window.WebSocket;
  const Wrapped = new Proxy(OrigWebSocket, {
    construct(target, args) {
      const ws = new target(...args);
      tap(ws);
      return ws;
    }
  });
  window.WebSocket = Wrapped;
})();
