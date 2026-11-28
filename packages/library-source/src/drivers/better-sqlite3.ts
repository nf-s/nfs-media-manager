import Database from 'better-sqlite3'
import type { SqlValue, SqliteDriver } from '../driver'
import { createSerialDriver, toSqlRow } from './shared'

export type BetterSqliteOptions = {
  /** A file path, or `:memory:` (the default) for a database that lives as long as the driver. */
  filename?: string
  /** The page cache in KiB; 32 MiB when omitted. */
  cacheSizeKiB?: number
}

/**
 * The Node driver (DEVICE-29), for tests and Node hosts. Statements are
 * prepared once per SQL text and reused. A file database uses WAL.
 */
export function openBetterSqliteDriver(
  options: BetterSqliteOptions = {},
): SqliteDriver {
  const filename = options.filename ?? ':memory:'
  const db = new Database(filename)
  db.pragma(`cache_size = ${-Math.round(options.cacheSizeKiB ?? 32_768)}`)
  if (filename !== ':memory:') {
    db.pragma('journal_mode = WAL')
    db.pragma('synchronous = NORMAL')
  }
  const statements = new Map<string, Database.Statement>()

  function prepare(sql: string): Database.Statement {
    const cached = statements.get(sql)
    if (cached !== undefined) return cached
    const statement = db.prepare(sql)
    statements.set(sql, statement)
    return statement
  }

  return createSerialDriver({
    run(sql: string, params: readonly SqlValue[]) {
      const statement = prepare(sql)
      if (statement.reader) statement.all(...params)
      else statement.run(...params)
    },
    all(sql: string, params: readonly SqlValue[]) {
      const statement = prepare(sql)
      if (!statement.reader) {
        statement.run(...params)
        return []
      }
      return statement.all(...params).map(toSqlRow)
    },
    exec(sql: string) {
      db.exec(sql)
    },
    close() {
      statements.clear()
      db.close()
    },
  })
}
