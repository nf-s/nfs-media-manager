/**
 * The only host-specific code of the store is a driver: `better-sqlite3` in
 * Node and tests, `@sqlite.org/sqlite-wasm` on OPFS in a browser Worker. The
 * store uses nothing else from a host: no custom SQL functions, collations or
 * extensions beyond FTS5 with the trigram tokenizer.
 */
export type SqlValue = string | number | null

export interface SqliteExecutor {
  run(sql: string, params?: readonly SqlValue[]): Promise<void>
  all(
    sql: string,
    params?: readonly SqlValue[],
  ): Promise<Record<string, SqlValue>[]>
}

export interface SqliteDriver extends SqliteExecutor {
  /** Several statements without parameters, for the schema. */
  exec(sql: string): Promise<void>
  /** Runs `work` in one transaction; rolls back when it throws. */
  transaction<T>(work: (tx: SqliteExecutor) => Promise<T>): Promise<T>
  close(): Promise<void>
}
