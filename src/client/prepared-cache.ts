export interface CacheEntry {
  sql: string;
  stmtId: number;
}

export class PreparedCache {
  private readonly map = new Map<string, number>();

  constructor(private readonly max: number) {}

  get capacity(): number {
    return this.max;
  }

  get size(): number {
    return this.map.size;
  }

  get(sql: string): number | undefined {
    const id = this.map.get(sql);
    if (id === undefined) return undefined;
    this.map.delete(sql);
    this.map.set(sql, id);
    return id;
  }

  set(sql: string, stmtId: number): CacheEntry | undefined {
    if (this.map.has(sql)) {
      this.map.delete(sql);
      this.map.set(sql, stmtId);
      return undefined;
    }
    let evicted: CacheEntry | undefined;
    if (this.max > 0 && this.map.size >= this.max) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey !== undefined) {
        const oldestId = this.map.get(oldestKey);
        this.map.delete(oldestKey);
        if (oldestId !== undefined) {
          evicted = { sql: oldestKey, stmtId: oldestId };
        }
      }
    }
    this.map.set(sql, stmtId);
    return evicted;
  }

  delete(sql: string): number | undefined {
    const id = this.map.get(sql);
    if (id === undefined) return undefined;
    this.map.delete(sql);
    return id;
  }

  drain(): CacheEntry[] {
    const entries = [...this.map.entries()].map(([sql, stmtId]) => ({ sql, stmtId }));
    this.map.clear();
    return entries;
  }
}
