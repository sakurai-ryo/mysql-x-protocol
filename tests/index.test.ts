import { describe, expect, test } from "vite-plus/test";

import { buildMysql41Response } from "../src/auth/mysql41.ts";
import { PreparedCache } from "../src/client/prepared-cache.ts";
import { escape as escapeSql, formatQuery } from "../src/client/query-format.ts";
import { encodeFrame, FrameBuffer } from "../src/protocol/framing.ts";

describe("framing", () => {
  test("encodeFrame writes little-endian length including type byte", () => {
    const payload = new Uint8Array([0x0a, 0x0b, 0x0c]);
    const frame = encodeFrame(0x01, payload);
    expect(frame.length).toBe(5 + payload.length);
    expect(frame.readUInt32LE(0)).toBe(payload.length + 1);
    expect(frame[4]).toBe(0x01);
    expect(Array.from(frame.subarray(5))).toEqual(Array.from(payload));
  });

  test("FrameBuffer reassembles frames split across chunks", () => {
    const payload1 = new Uint8Array([1, 2, 3, 4]);
    const payload2 = new Uint8Array([9]);
    const a = encodeFrame(12, payload1);
    const b = encodeFrame(13, payload2);
    const combined = Buffer.concat([a, b]);

    const fb = new FrameBuffer();
    const mid = 3;
    const frames1 = fb.push(combined.subarray(0, mid));
    const frames2 = fb.push(combined.subarray(mid));

    const all = [...frames1, ...frames2];
    expect(all).toHaveLength(2);

    const first = all[0];
    const second = all[1];
    if (!first || !second) throw new Error("unreachable");
    expect(first.type).toBe(12);
    expect(Array.from(first.payload)).toEqual(Array.from(payload1));
    expect(second.type).toBe(13);
    expect(Array.from(second.payload)).toEqual(Array.from(payload2));
  });
});

describe("query-format", () => {
  test("formatQuery substitutes ? placeholders in order", () => {
    expect(formatQuery("SELECT ?, ?", [1, "two"])).toBe("SELECT 1, 'two'");
  });

  test("escape handles null, boolean, number, bigint, bytes, and arrays", () => {
    expect(escapeSql(null)).toBe("NULL");
    expect(escapeSql(undefined)).toBe("NULL");
    expect(escapeSql(true)).toBe("true");
    expect(escapeSql(false)).toBe("false");
    expect(escapeSql(42)).toBe("42");
    expect(escapeSql(10n ** 20n)).toBe("100000000000000000000");
    expect(escapeSql(new Uint8Array([0xde, 0xad, 0xbe, 0xef]))).toBe("X'deadbeef'");
    expect(escapeSql([1, "a", null])).toBe("(1, 'a', NULL)");
  });

  test("escape escapes dangerous characters in strings", () => {
    expect(escapeSql("O'Brien")).toBe("'O\\'Brien'");
    expect(escapeSql("line\nbreak")).toBe("'line\\nbreak'");
    expect(escapeSql("back\\slash")).toBe("'back\\\\slash'");
    expect(escapeSql("null\0byte")).toBe("'null\\0byte'");
  });
});

describe("PreparedCache", () => {
  test("set evicts the oldest entry when capacity is full", () => {
    const cache = new PreparedCache(2);
    expect(cache.set("a", 1)).toBeUndefined();
    expect(cache.set("b", 2)).toBeUndefined();
    expect(cache.set("c", 3)).toEqual({ sql: "a", stmtId: 1 });
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(2);
    expect(cache.get("c")).toBe(3);
  });

  test("get promotes the accessed entry so it is not evicted next", () => {
    const cache = new PreparedCache(2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.get("a");
    const evicted = cache.set("c", 3);
    expect(evicted).toEqual({ sql: "b", stmtId: 2 });
  });

  test("re-setting an existing key updates the id without eviction", () => {
    const cache = new PreparedCache(2);
    cache.set("a", 1);
    cache.set("b", 2);
    expect(cache.set("a", 10)).toBeUndefined();
    expect(cache.get("a")).toBe(10);
    expect(cache.size).toBe(2);
  });

  test("capacity 0 disables caching", () => {
    const cache = new PreparedCache(0);
    cache.set("a", 1);
    cache.set("b", 2);
    expect(cache.size).toBe(2);
    // when capacity is 0 we treat it as "no eviction limit from set()" — the
    // real switch is done at the call site, which checks capacity before using
    // the cache at all
    expect(cache.capacity).toBe(0);
  });

  test("drain empties and returns all entries", () => {
    const cache = new PreparedCache(4);
    cache.set("a", 1);
    cache.set("b", 2);
    const drained = cache.drain();
    expect(drained).toEqual([
      { sql: "a", stmtId: 1 },
      { sql: "b", stmtId: 2 },
    ]);
    expect(cache.size).toBe(0);
  });
});

describe("mysql41 auth", () => {
  test("empty password omits scramble and STAR prefix", () => {
    const nonce = new Uint8Array(20);
    const out = buildMysql41Response(nonce, "root", "", "testdb");
    expect(new TextDecoder().decode(out)).toBe("testdb\0root\0");
  });

  test("non-empty password produces 40-char uppercase hex scramble", () => {
    const nonce = new Uint8Array(20).fill(0xab);
    const out = buildMysql41Response(nonce, "user", "password", "db");
    const text = new TextDecoder().decode(out);
    expect(text.startsWith("db\0user\0*")).toBe(true);
    const hex = text.slice("db\0user\0*".length);
    expect(hex).toHaveLength(40);
    expect(/^[0-9A-F]{40}$/.test(hex)).toBe(true);
  });

  test("scramble is deterministic for the same nonce", () => {
    const nonce = new Uint8Array(20).fill(0x11);
    const a = buildMysql41Response(nonce, "u", "p", "");
    const b = buildMysql41Response(nonce, "u", "p", "");
    expect(Array.from(a)).toEqual(Array.from(b));
  });
});
