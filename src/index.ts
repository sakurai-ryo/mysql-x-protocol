import { Connection, type ConnectionOptions } from "./client/connection.ts";
import { Pool, type PoolOptions } from "./client/pool.ts";

export {
  Connection,
  type ConnectionOptions,
  type FieldPacket,
  type QueryResult,
  type ResultSetHeader,
  type RowDataPacket,
} from "./client/connection.ts";
export { MysqlError } from "./client/errors.ts";
export { Pool, PoolConnection, type PoolOptions } from "./client/pool.ts";

export function createConnection(opts: ConnectionOptions): Promise<Connection> {
  return Connection.connect(opts);
}

export function createPool(opts: PoolOptions): Pool {
  return new Pool(opts);
}
