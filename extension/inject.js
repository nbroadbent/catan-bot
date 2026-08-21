(function() {
  "use strict";
  function encode(value) {
    const chunks = [];
    const push = (...bytes) => chunks.push(...bytes);
    function pushU(v, bytes) {
      for (let i = bytes - 1; i >= 0; i--) push(v >>> i * 8 & 255);
    }
    function any(v) {
      if (v === null || v === void 0) {
        push(192);
      } else if (typeof v === "boolean") {
        push(v ? 195 : 194);
      } else if (typeof v === "number") {
        if (Number.isInteger(v) && Math.abs(v) <= 2147483647) {
          if (v >= 0 && v <= 127) push(v);
          else if (v < 0 && v >= -32) push(256 + v);
          else if (v >= 0 && v <= 255) push(204, v);
          else if (v >= 0 && v <= 65535) {
            push(205);
            pushU(v, 2);
          } else if (v >= 0) {
            push(206);
            pushU(v >>> 0, 4);
          } else if (v >= -128) {
            push(208, v & 255);
          } else if (v >= -32768) {
            push(209);
            pushU(v & 65535, 2);
          } else {
            push(210);
            pushU(v >>> 0, 4);
          }
        } else {
          push(203);
          const dv = new DataView(new ArrayBuffer(8));
          dv.setFloat64(0, v);
          for (let i = 0; i < 8; i++) push(dv.getUint8(i));
        }
      } else if (typeof v === "string") {
        const utf8 = new TextEncoder().encode(v);
        if (utf8.length <= 31) push(160 + utf8.length);
        else if (utf8.length <= 255) push(217, utf8.length);
        else {
          push(218);
          pushU(utf8.length, 2);
        }
        for (const b of utf8) push(b);
      } else if (v instanceof Uint8Array) {
        if (v.length <= 255) push(196, v.length);
        else {
          push(197);
          pushU(v.length, 2);
        }
        for (const b of v) push(b);
      } else if (Array.isArray(v)) {
        if (v.length <= 15) push(144 + v.length);
        else {
          push(220);
          pushU(v.length, 2);
        }
        for (const item of v) any(item);
      } else if (typeof v === "object") {
        const entries = Object.entries(v).filter(
          ([, val]) => val !== void 0
        );
        if (entries.length <= 15) push(128 + entries.length);
        else {
          push(222);
          pushU(entries.length, 2);
        }
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
  const SEQUENCE_KEY = new Uint8Array([
    168,
    115,
    101,
    113,
    117,
    101,
    110,
    99,
    101
  ]);
  function indexOfKey(bytes) {
    outer: for (let i = 0; i + SEQUENCE_KEY.length <= bytes.length; i++) {
      for (let j = 0; j < SEQUENCE_KEY.length; j++) {
        if (bytes[i + j] !== SEQUENCE_KEY[j]) continue outer;
      }
      return i + SEQUENCE_KEY.length;
    }
    return -1;
  }
  function readUint(bytes, i) {
    const b = bytes[i];
    if (b <= 127) return { width: 1, value: b };
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    switch (b) {
      case 204:
        return { width: 2, value: bytes[i + 1] };
      case 205:
        return { width: 3, value: dv.getUint16(i + 1) };
      case 206:
        return { width: 5, value: dv.getUint32(i + 1) };
      case 207:
        return { width: 9, value: Number(dv.getBigUint64(i + 1)) };
      default:
        return null;
    }
  }
  function readSequence(frame) {
    var _a;
    const at = indexOfKey(frame);
    if (at === -1) return null;
    return ((_a = readUint(frame, at)) == null ? void 0 : _a.value) ?? null;
  }
  function encodeUint32(v) {
    const out = new Uint8Array(5);
    out[0] = 206;
    new DataView(out.buffer).setUint32(1, v >>> 0);
    return out;
  }
  function patchSequence(frame, newSeq) {
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
  const INTERESTING_IN = /* @__PURE__ */ new Set([1, 4, 91]);
  const MARKER = "__catan_copilot__";
  const SEND_MARKER = "__catan_copilot_send__";
  let gameSocket = null;
  let serverId = null;
  const GAME_FRAME = 3;
  let rewriting = false;
  let seqCounter = 0;
  let lastNativeSeq = 1;
  function resetSequencing() {
    rewriting = false;
    seqCounter = 0;
    lastNativeSeq = 1;
    serverId = null;
  }
  function post(msg) {
    window.postMessage({ [MARKER]: true, ...msg }, "*");
  }
  function handleInbound(buf, ws = null) {
    var _a;
    try {
      const msg = decode(buf);
      const d = msg == null ? void 0 : msg.data;
      if (d && typeof d.type === "number") {
        if (ws) gameSocket = ws;
        if (d.type === 1 && !serverId) {
          const id = (_a = d.payload) == null ? void 0 : _a.serverId;
          if (typeof id === "string" && id) serverId = id;
        }
        if (INTERESTING_IN.has(d.type)) {
          post({ type: d.type, payload: d.payload ?? null });
        }
        post({ dir: "in", frame: msg });
      }
    } catch {
    }
  }
  function toBytes(data) {
    if (typeof data === "string") return new TextEncoder().encode(data);
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) {
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    return null;
  }
  function b64(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }
  function handleOutbound(data) {
    const bytes = toBytes(data);
    if (!bytes || bytes.length === 0) return;
    if (bytes.length <= 2) return;
    const decodes = {};
    for (const off of [0, 1, 2]) {
      try {
        decodes[String(off)] = decode(bytes.subarray(off));
      } catch {
      }
    }
    post({ dir: "out", frame: decode(bytes.subarray(0, 1)), raw: b64(bytes), decodes });
  }
  function buildGameFrame(body) {
    const channel = new TextEncoder().encode(serverId ?? "");
    const payload = encode(body);
    const out = new Uint8Array(3 + channel.length + payload.length);
    out[0] = GAME_FRAME;
    out[1] = 1;
    out[2] = channel.length;
    out.set(channel, 3);
    out.set(payload, 3 + channel.length);
    return out;
  }
  function tap(ws) {
    ws.addEventListener("message", (ev) => {
      const data = ev.data;
      if (data instanceof ArrayBuffer) handleInbound(data, ws);
      else if (data instanceof Blob) {
        data.arrayBuffer().then((b) => handleInbound(b, ws)).catch(() => void 0);
      }
    });
  }
  const OrigWebSocket = window.WebSocket;
  const origSend = OrigWebSocket.prototype.send;
  OrigWebSocket.prototype.send = function(data) {
    let out = data;
    const bytes = toBytes(data);
    if (bytes && bytes.length > 2 && bytes[0] === GAME_FRAME) {
      gameSocket = this;
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
    handleOutbound(data);
    return origSend.call(this, out);
  };
  const Wrapped = new Proxy(OrigWebSocket, {
    construct(target, args) {
      resetSequencing();
      const ws = new target(...args);
      tap(ws);
      return ws;
    }
  });
  window.WebSocket = Wrapped;
  window.addEventListener("message", (ev) => {
    const data = ev.data;
    if (!data || data[SEND_MARKER] !== true) return;
    if (!gameSocket || gameSocket.readyState !== WebSocket.OPEN) return;
    if (!serverId) return;
    const actions = data.actions;
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
    }
  });
})();
