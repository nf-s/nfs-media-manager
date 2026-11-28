import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SqliteDriver } from '../src/driver'
import { openBetterSqliteDriver } from '../src/drivers/better-sqlite3'
import { openStore, readStoreStatus } from '../src/store'
import { drivers } from './fixtures'

describe.each(drivers)('$name driver', ({ open }) => {
  let driver: SqliteDriver

  beforeEach(async () => {
    driver = await open()
    await driver.exec(
      'CREATE TABLE value (id INTEGER PRIMARY KEY, name TEXT, amount NUMERIC); CREATE TABLE other (id INTEGER)',
    )
  })

  afterEach(async () => {
    await driver.close()
  })

  it('binds parameters and returns rows as plain values', async () => {
    await driver.run('INSERT INTO value (name, amount) VALUES (?, ?)', [
      'first',
      1_700_000_000_000_000,
    ])
    await driver.run('INSERT INTO value (name, amount) VALUES (?, ?)', [
      null,
      2.5,
    ])
    expect(
      await driver.all('SELECT id, name, amount FROM value ORDER BY id'),
    ).toEqual([
      { id: 1, name: 'first', amount: 1_700_000_000_000_000 },
      { id: 2, name: null, amount: 2.5 },
    ])
    expect(await driver.all('SELECT 1 AS one')).toEqual([{ one: 1 }])
    expect(
      await driver.all('INSERT INTO other (id) VALUES (7) RETURNING id'),
    ).toEqual([{ id: 7 }])
  })

  it('rolls back a transaction that throws', async () => {
    await expect(
      driver.transaction(async (tx) => {
        await tx.run("INSERT INTO value (name) VALUES ('kept?')")
        throw new Error('stop')
      }),
    ).rejects.toThrow('stop')
    await expect(
      driver.transaction(async (tx) => {
        await tx.run("INSERT INTO value (name) VALUES ('kept?')")
        await tx.run('INSERT INTO missing_table VALUES (1)')
      }),
    ).rejects.toThrow()
    expect(await driver.all('SELECT * FROM value')).toEqual([])
    expect(
      await driver.transaction(async (tx) => {
        await tx.run("INSERT INTO value (name) VALUES ('kept')")
        return 'done'
      }),
    ).toBe('done')
    expect(await driver.all('SELECT name FROM value')).toEqual([
      { name: 'kept' },
    ])
  })

  it('runs transactions one at a time and holds reads until they commit', async () => {
    const order: string[] = []
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const first = driver.transaction(async (tx) => {
      order.push('first start')
      await tx.run("INSERT INTO value (name) VALUES ('a')")
      await gate
      await tx.run("INSERT INTO value (name) VALUES ('b')")
      order.push('first end')
    })
    const read = driver
      .all('SELECT count(*) AS count FROM value')
      .then((rows) => {
        order.push('read')
        return rows
      })
    const second = driver.transaction(async () => {
      order.push('second')
    })
    await Promise.resolve()
    release()
    await Promise.all([first, second])
    expect(await read).toEqual([{ count: 2 }])
    expect(order).toEqual(['first start', 'first end', 'read', 'second'])
  })

  it('rejects use of a transaction executor after it ends', async () => {
    let leaked: { run: (sql: string) => Promise<void> } | null = null
    await driver.transaction(async (tx) => {
      leaked = tx
    })
    await expect(
      leaked === null ? Promise.resolve() : leaked.run('SELECT 1'),
    ).rejects.toThrow('already ended')
  })

  it('reports a closed database', async () => {
    await driver.close()
    await expect(driver.all('SELECT 1')).rejects.toThrow('closed')
    driver = await open()
  })
})

describe('better-sqlite3 file database', () => {
  let directory: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'library-source-'))
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  it('keeps the store across reopening', async () => {
    const filename = join(directory, 'store.sqlite3')
    const first = openBetterSqliteDriver({ filename })
    await openStore(first)
    await first.run("UPDATE sync_state SET phase = 'ready', cursor = 9")
    await first.close()

    const second = openBetterSqliteDriver({ filename })
    await openStore(second)
    expect(await readStoreStatus(second)).toMatchObject({
      ready: true,
      cursor: 9,
    })
    await second.close()
  })
})
