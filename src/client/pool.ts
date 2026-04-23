import { Connection, type ConnectionOptions, type QueryResult } from "./connection.ts";

export interface PoolOptions extends ConnectionOptions {
  /** Maximum simultaneous live connections. Default: 10. */
  connectionLimit?: number;
  /**
   * Maximum number of requests queued while waiting for a connection to be
   * released. 0 disables the cap. Default: 0.
   */
  queueLimit?: number;
  /**
   * When false, calls to getConnection/query/execute reject immediately once
   * the pool is saturated instead of queuing. Default: true.
   */
  waitForConnections?: boolean;
}

type Waiter = {
  resolve: (conn: Connection) => void;
  reject: (err: Error) => void;
};

export class Pool {
  private readonly opts: PoolOptions;
  private readonly connectionLimit: number;
  private readonly queueLimit: number;
  private readonly waitForConnections: boolean;
  private readonly idle: Connection[] = [];
  private readonly waiters: Waiter[] = [];
  private totalConnections = 0;
  private closed = false;

  constructor(opts: PoolOptions) {
    this.opts = opts;
    this.connectionLimit = opts.connectionLimit ?? 10;
    this.queueLimit = opts.queueLimit ?? 0;
    this.waitForConnections = opts.waitForConnections ?? true;
  }

  async getConnection(): Promise<PoolConnection> {
    const conn = await this.acquire();
    return new PoolConnection(conn, this);
  }

  async query(sql: string, params?: ReadonlyArray<unknown>): Promise<QueryResult> {
    const pc = await this.getConnection();
    try {
      return await pc.query(sql, params);
    } finally {
      pc.release();
    }
  }

  async execute(sql: string, params?: ReadonlyArray<unknown>): Promise<QueryResult> {
    const pc = await this.getConnection();
    try {
      return await pc.execute(sql, params);
    } finally {
      pc.release();
    }
  }

  async end(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const err = new Error("Pool has been closed");
    while (this.waiters.length > 0) this.waiters.shift()!.reject(err);
    const idle = this.idle.splice(0);
    this.totalConnections -= idle.length;
    await Promise.allSettled(idle.map((conn) => conn.end()));
  }

  private async acquire(): Promise<Connection> {
    if (this.closed) throw new Error("Pool has been closed");

    const reused = this.idle.shift();
    if (reused) return reused;

    if (this.totalConnections < this.connectionLimit) {
      this.totalConnections++;
      try {
        return await Connection.connect(this.opts);
      } catch (err) {
        this.totalConnections--;
        throw err;
      }
    }

    if (!this.waitForConnections) {
      throw new Error("Pool is full and waitForConnections is disabled");
    }
    if (this.queueLimit > 0 && this.waiters.length >= this.queueLimit) {
      throw new Error("Pool queue is full");
    }

    return new Promise<Connection>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  /** @internal */
  _return(conn: Connection): void {
    if (this.closed) {
      this.totalConnections--;
      conn.end().catch(() => {});
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve(conn);
      return;
    }
    this.idle.push(conn);
  }

  /** @internal */
  _discard(conn: Connection): void {
    this.totalConnections--;
    conn.end().catch(() => {});
  }
}

export class PoolConnection {
  private released = false;

  constructor(
    private readonly connection: Connection,
    private readonly pool: Pool,
  ) {}

  query(sql: string, params?: ReadonlyArray<unknown>): Promise<QueryResult> {
    this.assertLive();
    return this.connection.query(sql, params);
  }

  execute(sql: string, params?: ReadonlyArray<unknown>): Promise<QueryResult> {
    this.assertLive();
    return this.connection.execute(sql, params);
  }

  beginTransaction(): Promise<QueryResult> {
    this.assertLive();
    return this.connection.beginTransaction();
  }

  commit(): Promise<QueryResult> {
    this.assertLive();
    return this.connection.commit();
  }

  rollback(): Promise<QueryResult> {
    this.assertLive();
    return this.connection.rollback();
  }

  ping(): Promise<void> {
    this.assertLive();
    return this.connection.ping();
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    this.pool._return(this.connection);
  }

  /**
   * Closes the underlying connection and removes it from the pool. Use this
   * when the connection is known to be in a bad state (e.g. after a protocol
   * error) so the pool will open a fresh one on the next acquire.
   */
  destroy(): void {
    if (this.released) return;
    this.released = true;
    this.pool._discard(this.connection);
  }

  private assertLive(): void {
    if (this.released) {
      throw new Error("PoolConnection has already been released");
    }
  }
}
