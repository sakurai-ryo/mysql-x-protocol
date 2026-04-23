import { createHash } from "node:crypto";

const NUL = 0x00;
const STAR = 0x2a;
const enc = new TextEncoder();

export function buildMysql41Response(
  nonce: Uint8Array,
  username: string,
  password: string,
  database: string,
): Uint8Array {
  const schema = enc.encode(database);
  const user = enc.encode(username);

  const scramble = password.length > 0 ? hexScramble(password, nonce) : undefined;
  const hex = scramble ? enc.encode(scramble) : undefined;

  const total = schema.length + 1 + user.length + 1 + (hex ? 1 + hex.length : 0);
  const out = new Uint8Array(total);
  let off = 0;
  out.set(schema, off);
  off += schema.length;
  out[off++] = NUL;
  out.set(user, off);
  off += user.length;
  out[off++] = NUL;
  if (hex) {
    out[off++] = STAR;
    out.set(hex, off);
  }
  return out;
}

function hexScramble(password: string, nonce: Uint8Array): string {
  const sha1Pw = sha1(enc.encode(password));
  const sha1Sha1Pw = sha1(sha1Pw);
  const sha1Nonce = sha1(concat(nonce, sha1Sha1Pw));
  const xor = new Uint8Array(sha1Pw.length);
  for (let i = 0; i < sha1Pw.length; i++) {
    xor[i] = sha1Pw[i]! ^ sha1Nonce[i]!;
  }
  let hex = "";
  for (const byte of xor) {
    hex += byte.toString(16).padStart(2, "0").toUpperCase();
  }
  return hex;
}

function sha1(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha1").update(data).digest());
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
