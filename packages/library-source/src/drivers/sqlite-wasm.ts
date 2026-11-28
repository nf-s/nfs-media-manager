import type {
  Database,
  PreparedStatement,
  SAHPoolUtil,
  Sqlite3Static,
} from '@sqlite.org/sqlite-wasm' with { 'resolution-mode': 'import' }
import type { SqlValue, SqliteDriver } from '../driver'
import { createSerialDriver, toSqlRow } from './shared'

/**
 * The browser driver (DEVICE-29): `@sqlite.org/sqlite-wasm` on the
 * `opfs-sahpool` VFS, which needs a dedicated Worker but no COOP or COEP
 * headers. The same module opens an in-memory database in Node for tests.
 */

let sqlite3: Promise<Sqlite3Static> | undefined

/**
 * The Emscripten module options the package's init reads for its messages
 * (`Module.print` and `Module.printErr` in its index.mjs), which write to
 * the console when absent.
 */
type SqliteWasmInitOptions = {
  print: (...messages: unknown[]) => void
  printErr: (...messages: unknown[]) => void
}

const discard = () => {}

/**
 * The library's logger, which sqlite3ApiBootstrap (in the package's
 * index.mjs and node.mjs) reads from `globalThis.sqlite3ApiConfig` while
 * init runs, then deletes. Without it the logger is the console: a failed
 * step logs its result code and SQL, and the OPFS pool logs its I/O errors.
 * Failures still throw from the call that met them.
 */
const silentApiConfig = {
  debug: discard,
  log: discard,
  warn: discard,
  error: discard,
}

/**
 * Loads the WebAssembly module once per Worker, or once per process in
 * Node. The module's own messages are discarded; a failed load still
 * rejects with its error.
 */
export function loadSqliteWasm(): Promise<Sqlite3Static> {
  sqlite3 ??= import('@sqlite.org/sqlite-wasm').then((module) => {
    // The package declares init without the module argument it accepts; a
    // function that takes fewer parameters is assignable to this type.
    const init: (options: SqliteWasmInitOptions) => Promise<Sqlite3Static> =
      module.default
    Object.assign(globalThis, { sqlite3ApiConfig: silentApiConfig })
    return init({ print: discard, printErr: discard }).finally(() => {
      Reflect.deleteProperty(globalThis, 'sqlite3ApiConfig')
    })
  })
  return sqlite3
}

export type OpfsStoreOptions = {
  /** The database file inside the pool, an absolute name such as `/library.sqlite3`. */
  filename: string
  /** The pool's OPFS directory; the library's default when omitted. */
  directory?: string
  /** The page cache in KiB; 32 MiB when omitted. */
  cacheSizeKiB?: number
}

export type OpfsStore = {
  driver: SqliteDriver
  /** Closes the database and deletes its file from the pool. */
  destroy(): Promise<void>
}

/** Opens or creates the store's database on OPFS. Call inside a Worker. */
export async function openOpfsStore(
  options: OpfsStoreOptions,
): Promise<OpfsStore> {
  const module = await loadSqliteWasm()
  const pool: SAHPoolUtil = await module.installOpfsSAHPoolVfs(
    options.directory === undefined ? {} : { directory: options.directory },
  )
  const db = new pool.OpfsSAHPoolDb(options.filename)
  db.exec('PRAGMA temp_store = MEMORY')
  db.exec(`PRAGMA cache_size = ${-Math.round(options.cacheSizeKiB ?? 32_768)}`)
  const driver = createWasmDriver(db)
  return {
    driver,
    async destroy() {
      await driver.close()
      pool.unlink(options.filename)
    },
  }
}

/** An in-memory database, for tests and hosts without OPFS. */
export async function openWasmMemoryDriver(): Promise<SqliteDriver> {
  const module = await loadSqliteWasm()
  return createWasmDriver(new module.oo1.DB(':memory:', 'c'))
}

/** Adapts an open sqlite-wasm database. Statements are prepared once per SQL text. */
export function createWasmDriver(db: Database): SqliteDriver {
  const statements = new Map<string, PreparedStatement>()

  function prepare(
    sql: string,
    params: readonly SqlValue[],
  ): PreparedStatement {
    let statement = statements.get(sql)
    if (statement === undefined) {
      statement = db.prepare(sql)
      statements.set(sql, statement)
    }
    if (params.length > 0) statement.bind([...params])
    return statement
  }

  function collect(sql: string, params: readonly SqlValue[]) {
    const statement = prepare(sql, params)
    const rows: Record<string, SqlValue>[] = []
    try {
      while (statement.step()) rows.push(toSqlRow(statement.get({})))
    } finally {
      statement.reset(true)
    }
    return rows
  }

  return createSerialDriver({
    run(sql: string, params: readonly SqlValue[]) {
      collect(sql, params)
    },
    all: collect,
    exec(sql: string) {
      db.exec(sql)
    },
    close() {
      for (const statement of statements.values()) statement.finalize()
      statements.clear()
      db.close()
    },
  })
}
