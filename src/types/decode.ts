import type { ColumnMetaData } from "../../generated/mysqlx_resultset_pb.ts";
import {
  ColumnMetaData_FieldType,
  ContentType_BYTES,
} from "../../generated/mysqlx_resultset_pb.ts";

const dec = new TextDecoder("utf-8", { fatal: false });
const BINARY_COLLATION = 63n;

export function decodeField(meta: ColumnMetaData, bytes: Uint8Array): unknown {
  if (bytes.length === 0) return null;
  switch (meta.type) {
    case ColumnMetaData_FieldType.SINT:
      return bigintToJs(zigzag(readVarint(bytes)[0]));
    case ColumnMetaData_FieldType.UINT:
      return bigintToJs(readVarint(bytes)[0]);
    case ColumnMetaData_FieldType.DOUBLE:
      return readFloat64(bytes);
    case ColumnMetaData_FieldType.FLOAT:
      return readFloat32(bytes);
    case ColumnMetaData_FieldType.BYTES:
      return decodeBytes(meta, bytes);
    case ColumnMetaData_FieldType.BIT:
      return bigintToJs(readVarint(bytes)[0]);
    case ColumnMetaData_FieldType.ENUM:
      return decodeTerminatedString(bytes);
    case ColumnMetaData_FieldType.SET:
      return decodeSet(bytes);
    case ColumnMetaData_FieldType.TIME:
      return decodeTime(bytes);
    case ColumnMetaData_FieldType.DATETIME:
      return decodeDatetime(bytes);
    case ColumnMetaData_FieldType.DECIMAL:
      return decodeDecimal(bytes);
    default:
      return new Uint8Array(bytes);
  }
}

function readVarint(bytes: Uint8Array, start = 0): [bigint, number] {
  let result = 0n;
  let shift = 0n;
  let i = start;
  while (i < bytes.length) {
    const b = bytes[i]!;
    result |= BigInt(b & 0x7f) << shift;
    i++;
    if ((b & 0x80) === 0) return [result, i];
    shift += 7n;
  }
  throw new Error("truncated varint");
}

function zigzag(u: bigint): bigint {
  return (u >> 1n) ^ -(u & 1n);
}

function bigintToJs(n: bigint): number | bigint {
  const min = BigInt(Number.MIN_SAFE_INTEGER);
  const max = BigInt(Number.MAX_SAFE_INTEGER);
  if (n >= min && n <= max) return Number(n);
  return n;
}

function readFloat64(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getFloat64(0, true);
}

function readFloat32(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getFloat32(0, true);
}

function stripTerminator(bytes: Uint8Array): Uint8Array {
  if (bytes.length > 0 && bytes[bytes.length - 1] === 0) {
    return bytes.subarray(0, bytes.length - 1);
  }
  return bytes;
}

function decodeBytes(meta: ColumnMetaData, bytes: Uint8Array): unknown {
  const body = stripTerminator(bytes);
  if (meta.contentType === ContentType_BYTES.JSON) {
    const text = dec.decode(body);
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  if (meta.collation === BINARY_COLLATION) {
    return new Uint8Array(body);
  }
  return dec.decode(body);
}

function decodeTerminatedString(bytes: Uint8Array): string {
  return dec.decode(stripTerminator(bytes));
}

function decodeSet(bytes: Uint8Array): string[] {
  if (bytes.length === 1 && bytes[0] === 0x01) return [];
  if (bytes.length === 1 && bytes[0] === 0x00) return [""];
  const result: string[] = [];
  let i = 0;
  while (i < bytes.length) {
    const [len, next] = readVarint(bytes, i);
    i = next;
    const size = Number(len);
    result.push(dec.decode(bytes.subarray(i, i + size)));
    i += size;
  }
  return result;
}

function decodeTime(bytes: Uint8Array): string {
  if (bytes.length === 0) return "00:00:00";
  const negate = bytes[0] === 0x01;
  let i = 1;
  const pad = (n: bigint, w = 2) => String(n).padStart(w, "0");
  const [h, i1] = readVarint(bytes, i);
  i = i1;
  const [m, i2] = readVarint(bytes, i);
  i = i2;
  const [s, i3] = readVarint(bytes, i);
  i = i3;
  let out = `${pad(h)}:${pad(m)}:${pad(s)}`;
  if (i < bytes.length) {
    const [us] = readVarint(bytes, i);
    if (us > 0n) out += `.${String(us).padStart(6, "0")}`;
  }
  return negate ? `-${out}` : out;
}

function decodeDatetime(bytes: Uint8Array): string {
  let i = 0;
  const pad = (n: bigint, w = 2) => String(n).padStart(w, "0");
  const [Y, i1] = readVarint(bytes, i);
  i = i1;
  const [M, i2] = readVarint(bytes, i);
  i = i2;
  const [D, i3] = readVarint(bytes, i);
  i = i3;
  let out = `${pad(Y, 4)}-${pad(M)}-${pad(D)}`;
  if (i < bytes.length) {
    const [h, ih] = readVarint(bytes, i);
    i = ih;
    const [m, im] = readVarint(bytes, i);
    i = im;
    const [s, is] = readVarint(bytes, i);
    i = is;
    out += ` ${pad(h)}:${pad(m)}:${pad(s)}`;
    if (i < bytes.length) {
      const [us] = readVarint(bytes, i);
      if (us > 0n) out += `.${String(us).padStart(6, "0")}`;
    }
  }
  return out;
}

function decodeDecimal(bytes: Uint8Array): string {
  if (bytes.length < 2) return "0";
  const scale = bytes[0]!;
  let digits = "";
  let sign = "";
  outer: for (let i = 1; i < bytes.length; i++) {
    const hi = (bytes[i]! >> 4) & 0x0f;
    const lo = bytes[i]! & 0x0f;
    if (hi >= 0x0a) {
      sign = hi === 0x0d ? "-" : "";
      break outer;
    }
    digits += hi.toString();
    if (lo >= 0x0a) {
      sign = lo === 0x0d ? "-" : "";
      break outer;
    }
    digits += lo.toString();
  }
  if (scale > 0 && digits.length > scale) {
    digits = `${digits.slice(0, digits.length - scale)}.${digits.slice(-scale)}`;
  } else if (scale > 0) {
    digits = `0.${digits.padStart(scale, "0")}`;
  }
  return sign + digits;
}
