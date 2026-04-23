# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

A TypeScript client library for MySQL's **X Protocol** (port 33060), built on top of `@bufbuild/protobuf`. The public API (`Connection`, `Pool`, `createConnection`, `createPool`) is shaped to be compatible with `mysql2`'s interface (`QueryResult`, `RowDataPacket`, `ResultSetHeader`, `FieldPacket`), so consumers can swap it in with minimal code changes — but the wire protocol underneath is X Protocol, not the classic MySQL protocol.

## Commands

Package manager is **pnpm** (`packageManager: pnpm@10.33.1`). Toolchain is **vite-plus** (`vp`).

- `pnpm install` — install deps
- `pnpm test` / `pnpm vp test` — run unit tests (Vitest-compatible via `vite-plus/test`)
- `pnpm vp test path/to/file.test.ts` — run a single test file
- `pnpm vp test -t "pattern"` — run tests whose name matches
- `pnpm check` — run format + lint + type checks together (use this before committing)
- `pnpm build` (= `vp pack`) — bundle the library to `dist/`
- `pnpm gen` (= `buf generate`) — regenerate `generated/*_pb.ts` from `third_party/mysql-x-proto/*.proto`

### E2E tests

E2E tests live in `tests/e2e/` and are **gated by `MYSQL_X_TEST=1`** (see `describe.skipIf(!ENABLED)` in `tests/e2e/connection.test.ts`). They require a running MySQL 8 with X Plugin enabled:

```bash
docker compose up -d           # starts mysql:8 with --mysqlx=ON on :33060
MYSQL_X_TEST=1 pnpm test       # runs unit + e2e
docker compose down -v
```

Env overrides: `MYSQL_X_HOST`, `MYSQL_X_PORT`, `MYSQL_X_USER`, `MYSQL_X_PASSWORD`, `MYSQL_X_DATABASE` (defaults match `compose.yml` + `tests/e2e/init.sql`: `testuser` / `testpass` / `testdb`).

## Architecture

The layers are deliberately thin and stacked; follow them top-down when tracing a query:

```
src/index.ts                  public API (createConnection / createPool)
  └─ src/client/pool.ts       connectionLimit, FIFO queue, PoolConnection wrapper
      └─ src/client/connection.ts   authenticate → query/execute → readResult loop
          ├─ src/client/prepared-cache.ts   LRU of SQL→stmtId (for execute())
          ├─ src/client/query-format.ts     ? placeholder escaping (for query())
          ├─ src/auth/mysql41.ts            MYSQL41 SHA1 challenge scramble
          ├─ src/types/encode.ts            JS value → Scalar/Any protobuf
          ├─ src/types/decode.ts            X Protocol column bytes → JS value
          └─ src/transport/node.ts          XSocket: net/tls + frame push/pull
              └─ src/protocol/framing.ts    5-byte header: LE length + type byte
generated/                    protoc-gen-es output from third_party/mysql-x-proto
```

### Wire format

X Protocol frames are `[4-byte LE length including the type byte][1-byte msg type][protobuf payload]`. `FrameBuffer.push` handles reassembly across TCP chunks, and `XSocket` exposes async `send`/`recv`. Everything above this layer speaks message-types-and-protobuf, never raw bytes.

### Two query paths on `Connection`

1. **`query(sql, params?)`** — substitutes `?` client-side via `formatQuery`/`escape` and sends `SQL_STMT_EXECUTE` with `namespace: "sql"`. Use for DDL, transaction control, or ad-hoc SQL.
2. **`execute(sql, params?)`** — real parameter binding. Sends `PREPARE_PREPARE` once per unique SQL string, caches the `stmtId` in `PreparedCache` (LRU, default 256), then sends `PREPARE_EXECUTE` with protobuf-encoded `Any` args. Falls back to inline `SQL_STMT_EXECUTE` when `maxPreparedStatements: 0`. On LRU eviction, `PREPARE_DEALLOCATE` is sent best-effort.

Both paths converge on `readResult()`, which drains a message loop until `SQL_STMT_EXECUTE_OK`, handling `ERROR` / `NOTICE` (for `ROWS_AFFECTED` / `GENERATED_INSERT_ID`) / `RESULTSET_COLUMN_META_DATA` / `RESULTSET_ROW` / `RESULTSET_FETCH_DONE[_MORE_RESULTSETS]`.

### Why the return shape looks odd

`QueryResult = [RowDataPacket[] | ResultSetHeader, FieldPacket[]]` is the `mysql2` tuple shape on purpose. When `hasResultset` is true, you get rows + fields; otherwise, a header with `affectedRows`/`insertId` (populated from `Mysqlx.Notice.SessionStateChanged`). Row objects inherit from a class whose `.name` is `"RowDataPacket"` so `row.constructor.name` matches mysql2.

### Auth

Only **MYSQL41** is implemented (`src/auth/mysql41.ts`). The server replies `SESS_AUTHENTICATE_CONTINUE` with a 20-byte nonce; response is `schema\0user\0*<40-hex-upper>` where the hex is `SHA1(pw) XOR SHA1(nonce + SHA1(SHA1(pw)))`. Empty password ⇒ omit the `*...` suffix entirely. `mysql_native_password` is why `init.sql` uses `IDENTIFIED WITH mysql_native_password`.

### TLS

`XSocket.startTls()` exists but nothing currently calls it. If wiring TLS into the auth flow, it must happen **before** `SESS_AUTHENTICATE_START` via a `CapabilitiesSet(tls=true)` handshake — not yet implemented.

### Protobuf generation

`.proto` files in `third_party/mysql-x-proto/` are vendored from MySQL and **must not be hand-edited**. They're referenced via `buf.yaml` / `buf.gen.yaml` and regenerated into `generated/` by `pnpm gen`. `generated/` is committed (imports like `../../generated/mysqlx_pb.ts` in `src/` assume it's present). If protos change, re-run `pnpm gen` and commit the diff.

## Conventions worth knowing

- **TypeScript strict + `verbatimModuleSyntax` + `allowImportingTsExtensions`**: imports use explicit `.ts` suffixes (e.g. `./connection.ts`), and `type` imports must be marked `import type`. `noEmit: true` — bundling is vite-plus's job, not `tsc`'s.
- **`bigint` flows through the data layer**: `decodeField` returns `bigint` for integers outside `Number.MAX_SAFE_INTEGER`; `encodeValue` maps JS `bigint` to `V_SINT`/`V_UINT`. Don't silently `Number(x)` these.
- **`.vscode/extensions.json`** recommends the vite-plus extension; prefer its integrated lint/format over ad-hoc scripts.
