import type { SqlValue, SqliteDriver, SqliteExecutor } from '../driver'

/**
 * The synchronous calls a host library offers on one connection. A driver
 * adapts its library to this; `createSerialDriver` adds the queue and the
 * transaction rules that every driver shares.
 */
export type SyncConnection = {
  run(sql: string, params: readonly SqlValue[]): void
  all(sql: string, params: readonly SqlValue[]): Record<string, SqlValue>[]
  exec(sql: string): void
  close(): void
}

/**
 * Wraps one connection as a `SqliteDriver`. Every top-level call and every
 * transaction runs one at a time in call order, so a read never sees a
 * transaction's uncommitted rows. Inside `transaction`, the executor runs
 * directly; using it after the transaction ends throws.
 */
export function createSerialDriver(connection: SyncConnection): SqliteDriver {
  let queue: Promise<unknown> = Promise.resolve()
  let closed = false

  function enqueue<T>(work: () => Promise<T> | T): Promise<T> {
    const result = queue.then(() => {
      if (closed) throw new Error('The database is closed.')
      return work()
    })
    queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  return {
    run: (sql, params = []) => enqueue(() => connection.run(sql, params)),
    all: (sql, params = []) => enqueue(() => connection.all(sql, params)),
    exec: (sql) => enqueue(() => connection.exec(sql)),
    transaction: (work) =>
      enqueue(async () => {
        let open = true
        const guard = <T>(call: () => T): Promise<T> => {
          if (!open) {
            return Promise.reject(
              new Error('The transaction has already ended.'),
            )
          }
          try {
            return Promise.resolve(call())
          } catch (error) {
            return Promise.reject(error)
          }
        }
        const tx: SqliteExecutor = {
          run: (sql, params = []) => guard(() => connection.run(sql, params)),
          all: (sql, params = []) => guard(() => connection.all(sql, params)),
        }
        connection.exec('BEGIN IMMEDIATE')
        try {
          const value = await work(tx)
          open = false
          connection.exec('COMMIT')
          return value
        } catch (error) {
          open = false
          rollback(connection)
          throw error
        }
      }),
    close: () =>
      enqueue(() => {
        closed = true
        connection.close()
      }),
  }
}

/**
 * Rolls back the open transaction. SQLite has already rolled back after some
 * errors (a full disk, an interrupt), and then ROLLBACK reports that no
 * transaction is active; the original error is the one to report.
 */
function rollback(connection: SyncConnection): void {
  try {
    connection.exec('ROLLBACK')
  } catch {
    return
  }
}

/** Checks a row from the host library holds only values the store writes. */
export function toSqlRow(row: unknown): Record<string, SqlValue> {
  if (typeof row !== 'object' || row === null) {
    throw new Error('SQLite returned a row that is not an object.')
  }
  const result: Record<string, SqlValue> = {}
  for (const [column, value] of Object.entries(row)) {
    result[column] = toSqlValue(column, value)
  }
  return result
}

function toSqlValue(column: string, value: unknown): SqlValue {
  if (value === null || typeof value === 'string') return value
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') {
    const number = Number(value)
    if (Number.isSafeInteger(number)) return number
    throw new Error(`Column ${column} holds an integer beyond 2^53.`)
  }
  throw new Error(`Column ${column} holds a value of type ${typeof value}.`)
}
