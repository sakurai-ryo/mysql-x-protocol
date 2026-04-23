import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import type { DescMessage, MessageShape } from "@bufbuild/protobuf";

import {
  ClientMessages_Type,
  ErrorSchema,
  OkSchema,
  ServerMessages_Type,
} from "../../generated/mysqlx_pb.ts";
import {
  AuthenticateContinueSchema,
  AuthenticateOkSchema,
  AuthenticateStartSchema,
  CloseSchema as SessionCloseSchema,
} from "../../generated/mysqlx_session_pb.ts";
import { CloseSchema as ConnectionCloseSchema } from "../../generated/mysqlx_connection_pb.ts";
import { StmtExecuteSchema } from "../../generated/mysqlx_sql_pb.ts";
import {
  type ColumnMetaData,
  ColumnMetaDataSchema,
  type Row,
  RowSchema,
} from "../../generated/mysqlx_resultset_pb.ts";
import {
  Frame_Type as NoticeFrame_Type,
  FrameSchema as NoticeFrameSchema,
  SessionStateChanged_Parameter,
  SessionStateChangedSchema,
} from "../../generated/mysqlx_notice_pb.ts";
import {
  DeallocateSchema,
  ExecuteSchema as PrepareExecuteSchema,
  Prepare_OneOfMessage_Type,
  Prepare_OneOfMessageSchema,
  PrepareSchema,
} from "../../generated/mysqlx_prepare_pb.ts";

import { XSocket } from "../transport/node.ts";
import { buildMysql41Response } from "../auth/mysql41.ts";
import { encodeValue } from "../types/encode.ts";
import { decodeField } from "../types/decode.ts";
import { MysqlError } from "./errors.ts";
import { PreparedCache } from "./prepared-cache.ts";
import { formatQuery } from "./query-format.ts";

export interface ConnectionOptions {
  host?: string;
  port?: number;
  user: string;
  password?: string;
  database?: string;
  /**
   * Maximum number of server-side prepared statements cached per connection.
   * Set to 0 to disable preparation and fall back to inline argument binding.
   * Default: 256 (kept conservative to avoid collisions with MySQL's
   * max_prepared_stmt_count).
   */
  maxPreparedStatements?: number;
}

const DEFAULT_MAX_PREPARED_STATEMENTS = 256;

export interface FieldPacket {
  catalog: string;
  schema: string;
  name: string;
  orgName: string;
  table: string;
  orgTable: string;
  columnType: number;
  flags: number;
  decimals: number;
  columnLength: number;
  collation: number;
}

export interface ResultSetHeader {
  fieldCount: number;
  affectedRows: number;
  insertId: number;
  info: string;
  serverStatus: number;
  warningStatus: number;
  changedRows: number;
}

export type RowDataPacket = Record<string, unknown>;

export type QueryResult = [RowDataPacket[] | ResultSetHeader, FieldPacket[]];

class RowDataPacketCtor {}
Object.defineProperty(RowDataPacketCtor, "name", { value: "RowDataPacket" });

const textEnc = new TextEncoder();
const textDec = new TextDecoder();

export class Connection {
  private readonly preparedCache: PreparedCache;
  private nextStmtId = 1;

  private constructor(
    private readonly socket: XSocket,
    private readonly opts: ConnectionOptions,
  ) {
    const max = opts.maxPreparedStatements ?? DEFAULT_MAX_PREPARED_STATEMENTS;
    this.preparedCache = new PreparedCache(max);
  }

  static async connect(opts: ConnectionOptions): Promise<Connection> {
    const socket = await XSocket.connect({
      host: opts.host ?? "127.0.0.1",
      port: opts.port ?? 33060,
    });
    const conn = new Connection(socket, opts);
    try {
      await conn.authenticate();
    } catch (err) {
      await socket.close().catch(() => {});
      throw err;
    }
    return conn;
  }

  private async authenticate(): Promise<void> {
    const start = create(AuthenticateStartSchema, { mechName: "MYSQL41" });
    this.socket.send(
      ClientMessages_Type.SESS_AUTHENTICATE_START,
      toBinary(AuthenticateStartSchema, start),
    );
    const challenge = await this.expect(
      ServerMessages_Type.SESS_AUTHENTICATE_CONTINUE,
      AuthenticateContinueSchema,
    );
    const response = buildMysql41Response(
      challenge.authData,
      this.opts.user,
      this.opts.password ?? "",
      this.opts.database ?? "",
    );
    const cont = create(AuthenticateContinueSchema, { authData: response });
    this.socket.send(
      ClientMessages_Type.SESS_AUTHENTICATE_CONTINUE,
      toBinary(AuthenticateContinueSchema, cont),
    );
    await this.expect(ServerMessages_Type.SESS_AUTHENTICATE_OK, AuthenticateOkSchema);
  }

  query(sql: string, params?: ReadonlyArray<unknown>): Promise<QueryResult> {
    const formatted = formatQuery(sql, params);
    const msg = create(StmtExecuteSchema, {
      namespace: "sql",
      stmt: textEnc.encode(formatted),
      args: [],
    });
    this.socket.send(ClientMessages_Type.SQL_STMT_EXECUTE, toBinary(StmtExecuteSchema, msg));
    return this.readResult();
  }

  async execute(sql: string, params?: ReadonlyArray<unknown>): Promise<QueryResult> {
    const args = (params ?? []).map(encodeValue);
    if (this.preparedCache.capacity <= 0) {
      const msg = create(StmtExecuteSchema, {
        namespace: "sql",
        stmt: textEnc.encode(sql),
        args,
      });
      this.socket.send(ClientMessages_Type.SQL_STMT_EXECUTE, toBinary(StmtExecuteSchema, msg));
      return this.readResult();
    }

    const stmtId = await this.ensurePrepared(sql);
    const exec = create(PrepareExecuteSchema, { stmtId, args });
    this.socket.send(ClientMessages_Type.PREPARE_EXECUTE, toBinary(PrepareExecuteSchema, exec));
    return this.readResult();
  }

  private async ensurePrepared(sql: string): Promise<number> {
    const cached = this.preparedCache.get(sql);
    if (cached !== undefined) return cached;

    const stmtId = this.nextStmtId++;
    const innerStmt = create(StmtExecuteSchema, {
      namespace: "sql",
      stmt: textEnc.encode(sql),
    });
    const prep = create(PrepareSchema, {
      stmtId,
      stmt: create(Prepare_OneOfMessageSchema, {
        type: Prepare_OneOfMessage_Type.STMT,
        stmtExecute: innerStmt,
      }),
    });
    this.socket.send(ClientMessages_Type.PREPARE_PREPARE, toBinary(PrepareSchema, prep));
    await this.expect(ServerMessages_Type.OK, OkSchema);

    const evicted = this.preparedCache.set(sql, stmtId);
    if (evicted) await this.deallocate(evicted.stmtId);
    return stmtId;
  }

  private async deallocate(stmtId: number): Promise<void> {
    const msg = create(DeallocateSchema, { stmtId });
    this.socket.send(ClientMessages_Type.PREPARE_DEALLOCATE, toBinary(DeallocateSchema, msg));
    try {
      await this.expect(ServerMessages_Type.OK, OkSchema);
    } catch {
      // deallocate is best-effort; server will clean up on session close
    }
  }

  beginTransaction(): Promise<QueryResult> {
    return this.query("BEGIN");
  }

  commit(): Promise<QueryResult> {
    return this.query("COMMIT");
  }

  rollback(): Promise<QueryResult> {
    return this.query("ROLLBACK");
  }

  async ping(): Promise<void> {
    await this.query("SELECT 1");
  }

  async end(): Promise<void> {
    try {
      this.socket.send(
        ClientMessages_Type.SESS_CLOSE,
        toBinary(SessionCloseSchema, create(SessionCloseSchema, {})),
      );
      await this.expect(ServerMessages_Type.OK, OkSchema);
      this.socket.send(
        ClientMessages_Type.CON_CLOSE,
        toBinary(ConnectionCloseSchema, create(ConnectionCloseSchema, {})),
      );
      await this.expect(ServerMessages_Type.OK, OkSchema).catch(() => {});
    } catch {
      // shutting down; ignore
    }
    await this.socket.close();
  }

  private async expect<Desc extends DescMessage>(
    expectedType: number,
    schema: Desc,
  ): Promise<MessageShape<Desc>> {
    while (true) {
      const frame = await this.socket.recv();
      if (frame.type === ServerMessages_Type.ERROR) {
        throw new MysqlError(fromBinary(ErrorSchema, frame.payload));
      }
      if (frame.type === ServerMessages_Type.NOTICE) continue;
      if (frame.type !== expectedType) {
        throw new Error(
          `unexpected X Protocol message: got type=${frame.type}, expected=${expectedType}`,
        );
      }
      return fromBinary(schema, frame.payload);
    }
  }

  private async readResult(): Promise<QueryResult> {
    const columns: ColumnMetaData[] = [];
    const rows: Row[] = [];
    let affectedRows = 0n;
    let insertId: bigint | undefined;
    let warnings = 0;
    let hasResultset = false;

    loop: while (true) {
      const frame = await this.socket.recv();
      switch (frame.type) {
        case ServerMessages_Type.ERROR:
          throw new MysqlError(fromBinary(ErrorSchema, frame.payload));
        case ServerMessages_Type.NOTICE: {
          const n = fromBinary(NoticeFrameSchema, frame.payload);
          if (n.type === NoticeFrame_Type.SESSION_STATE_CHANGED) {
            const ssc = fromBinary(SessionStateChangedSchema, n.payload);
            const scalar = ssc.value[0];
            if (!scalar) break;
            switch (ssc.param) {
              case SessionStateChanged_Parameter.ROWS_AFFECTED:
                affectedRows = scalar.vUnsignedInt;
                break;
              case SessionStateChanged_Parameter.GENERATED_INSERT_ID:
                insertId = scalar.vUnsignedInt;
                break;
            }
          } else if (n.type === NoticeFrame_Type.WARNING) {
            warnings++;
          }
          break;
        }
        case ServerMessages_Type.RESULTSET_COLUMN_META_DATA:
          columns.push(fromBinary(ColumnMetaDataSchema, frame.payload));
          hasResultset = true;
          break;
        case ServerMessages_Type.RESULTSET_ROW:
          rows.push(fromBinary(RowSchema, frame.payload));
          break;
        case ServerMessages_Type.RESULTSET_FETCH_DONE:
          break;
        case ServerMessages_Type.RESULTSET_FETCH_DONE_MORE_RESULTSETS:
          // Phase 1: ignore secondary resultsets, keep draining
          break;
        case ServerMessages_Type.SQL_STMT_EXECUTE_OK:
          break loop;
        default:
          // silently ignore unknown server-side messages
          break;
      }
    }

    if (hasResultset) {
      const fields = columns.map(toFieldPacket);
      const packets = rows.map((row) => {
        const obj = Object.create(RowDataPacketCtor.prototype) as RowDataPacket;
        for (let i = 0; i < columns.length; i++) {
          const column = columns[i];
          const field = fields[i];
          if (!column || !field) continue;
          obj[field.name] = decodeField(column, row.field[i] ?? new Uint8Array());
        }
        return obj;
      });
      return [packets, fields];
    }

    const header: ResultSetHeader = {
      fieldCount: 0,
      affectedRows: Number(affectedRows),
      insertId: insertId === undefined ? 0 : Number(insertId),
      info: "",
      serverStatus: 2,
      warningStatus: warnings,
      changedRows: 0,
    };
    return [header, []];
  }
}

function toFieldPacket(c: ColumnMetaData): FieldPacket {
  return {
    catalog: textDec.decode(c.catalog),
    schema: textDec.decode(c.schema),
    name: textDec.decode(c.name),
    orgName: textDec.decode(c.originalName),
    table: textDec.decode(c.table),
    orgTable: textDec.decode(c.originalTable),
    columnType: c.type,
    flags: c.flags,
    decimals: c.fractionalDigits,
    columnLength: c.length,
    collation: Number(c.collation),
  };
}
