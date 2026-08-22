// Decode a captured colonist outbound game frame (base64) into {action,payload,sequence}.
// Envelope: [0x03, 0x01, serverIdLen, ...serverId, ...msgpack]. Usage: node scripts/decode-frame.mjs <b64> [...]
import { decode } from "@msgpack/msgpack";
for (const b64 of process.argv.slice(2)) {
  const bytes = Buffer.from(b64, "base64");
  if (bytes[0] !== 0x03) { console.log(JSON.stringify({ note: "not a game frame", head: [...bytes.subarray(0, 4)] })); continue; }
  const len = bytes[2];
  const body = bytes.subarray(3 + len);
  try { console.log(JSON.stringify(decode(body))); } catch (e) { console.log(JSON.stringify({ error: String(e), len, head: [...bytes.subarray(0, 6)] })); }
}
