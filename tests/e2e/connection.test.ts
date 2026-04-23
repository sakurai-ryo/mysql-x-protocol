import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import {
  type Connection,
  createConnection,
  createPool,
  type ResultSetHeader,
} from "../../src/index.ts";

const ENABLED = process.env.MYSQL_X_TEST === "1";

describe.skipIf(!ENABLED)("e2e: mysql:8 X Protocol", () => {
  let conn: Connection;

  beforeAll(async () => {
    conn = await createConnection({
      host: process.env.MYSQL_X_HOST ?? "127.0.0.1",
      port: Number(process.env.MYSQL_X_PORT ?? 33060),
      user: process.env.MYSQL_X_USER ?? "testuser",
      password: process.env.MYSQL_X_PASSWORD ?? "testpass",
      database: process.env.MYSQL_X_DATABASE ?? "testdb",
    });
  });

  afterAll(async () => {
    await conn?.end();
  });

  test("SELECT literal via query()", async () => {
    const [rows] = await conn.query("SELECT 1 AS one, 'hello' AS greeting");
    const list = rows as Array<{ one: number; greeting: string }>;
    expect(list).toHaveLength(1);
    expect(list[0]?.one).toBe(1);
    expect(list[0]?.greeting).toBe("hello");
  });

  test("INSERT reports affectedRows and insertId; SELECT returns inserted row", async () => {
    await conn.query("DELETE FROM users");
    const [ins] = await conn.execute("INSERT INTO users (name, age) VALUES (?, ?)", ["alice", 30]);
    const header = ins as ResultSetHeader;
    expect(header.affectedRows).toBe(1);
    expect(header.insertId).toBeGreaterThan(0);

    const [sel] = await conn.execute("SELECT id, name, age FROM users WHERE name = ?", ["alice"]);
    const list = sel as Array<{ id: number; name: string; age: number }>;
    expect(list).toHaveLength(1);
    expect(list[0]?.name).toBe("alice");
    expect(list[0]?.age).toBe(30);
  });

  test("beginTransaction + commit persists rows", async () => {
    await conn.query("DELETE FROM users");
    await conn.beginTransaction();
    await conn.execute("INSERT INTO users (name) VALUES (?)", ["bob"]);
    await conn.commit();
    const [rows] = await conn.query("SELECT COUNT(*) AS c FROM users");
    const list = rows as Array<{ c: number }>;
    expect(list[0]?.c).toBe(1);
  });

  test("beginTransaction + rollback discards rows", async () => {
    await conn.query("DELETE FROM users");
    await conn.beginTransaction();
    await conn.execute("INSERT INTO users (name) VALUES (?)", ["zombie"]);
    await conn.rollback();
    const [rows] = await conn.query("SELECT COUNT(*) AS c FROM users");
    const list = rows as Array<{ c: number }>;
    expect(list[0]?.c).toBe(0);
  });

  test("execute() reuses the prepared statement cache for identical SQL", async () => {
    await conn.query("DELETE FROM users");
    for (const name of ["a", "b", "c"]) {
      await conn.execute("INSERT INTO users (name, age) VALUES (?, ?)", [name, 10]);
    }
    const [rows] = await conn.execute("SELECT name FROM users WHERE age = ? ORDER BY name", [10]);
    const list = rows as Array<{ name: string }>;
    expect(list.map((r) => r.name)).toEqual(["a", "b", "c"]);
  });

  test("execute() with maxPreparedStatements=0 falls back to inline StmtExecute", async () => {
    const direct = await createConnection({
      host: process.env.MYSQL_X_HOST ?? "127.0.0.1",
      port: Number(process.env.MYSQL_X_PORT ?? 33060),
      user: process.env.MYSQL_X_USER ?? "testuser",
      password: process.env.MYSQL_X_PASSWORD ?? "testpass",
      database: process.env.MYSQL_X_DATABASE ?? "testdb",
      maxPreparedStatements: 0,
    });
    try {
      const [rows] = await direct.execute("SELECT ? AS v", [42]);
      const list = rows as Array<{ v: number }>;
      expect(list[0]?.v).toBe(42);
    } finally {
      await direct.end();
    }
  });
});

describe.skipIf(!ENABLED)("e2e: Pool", () => {
  test("pool.query auto-acquires and releases a connection", async () => {
    const pool = createPool({
      host: process.env.MYSQL_X_HOST ?? "127.0.0.1",
      port: Number(process.env.MYSQL_X_PORT ?? 33060),
      user: process.env.MYSQL_X_USER ?? "testuser",
      password: process.env.MYSQL_X_PASSWORD ?? "testpass",
      database: process.env.MYSQL_X_DATABASE ?? "testdb",
      connectionLimit: 2,
    });
    try {
      const [rows] = await pool.query("SELECT 7 AS v");
      expect((rows as Array<{ v: number }>)[0]?.v).toBe(7);
    } finally {
      await pool.end();
    }
  });

  test("connectionLimit queues excess requests without dropping them", async () => {
    const pool = createPool({
      host: process.env.MYSQL_X_HOST ?? "127.0.0.1",
      port: Number(process.env.MYSQL_X_PORT ?? 33060),
      user: process.env.MYSQL_X_USER ?? "testuser",
      password: process.env.MYSQL_X_PASSWORD ?? "testpass",
      database: process.env.MYSQL_X_DATABASE ?? "testdb",
      connectionLimit: 2,
    });
    try {
      const results = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          pool.execute("SELECT ? AS v", [i]).then(([rows]) => (rows as Array<{ v: number }>)[0]?.v),
        ),
      );
      expect(results).toEqual([0, 1, 2, 3, 4]);
    } finally {
      await pool.end();
    }
  });

  test("getConnection + release returns the same conn to the next waiter", async () => {
    const pool = createPool({
      host: process.env.MYSQL_X_HOST ?? "127.0.0.1",
      port: Number(process.env.MYSQL_X_PORT ?? 33060),
      user: process.env.MYSQL_X_USER ?? "testuser",
      password: process.env.MYSQL_X_PASSWORD ?? "testpass",
      database: process.env.MYSQL_X_DATABASE ?? "testdb",
      connectionLimit: 1,
    });
    try {
      const a = await pool.getConnection();
      const bPromise = pool.getConnection();
      const [rows] = await a.query("SELECT 1 AS v");
      expect((rows as Array<{ v: number }>)[0]?.v).toBe(1);
      a.release();
      const b = await bPromise;
      const [rows2] = await b.query("SELECT 2 AS v");
      expect((rows2 as Array<{ v: number }>)[0]?.v).toBe(2);
      b.release();
    } finally {
      await pool.end();
    }
  });

  test("getConnection after pool.end() rejects", async () => {
    const pool = createPool({
      host: process.env.MYSQL_X_HOST ?? "127.0.0.1",
      port: Number(process.env.MYSQL_X_PORT ?? 33060),
      user: process.env.MYSQL_X_USER ?? "testuser",
      password: process.env.MYSQL_X_PASSWORD ?? "testpass",
      database: process.env.MYSQL_X_DATABASE ?? "testdb",
    });
    await pool.end();
    await expect(pool.getConnection()).rejects.toThrow(/closed/);
  });
});
