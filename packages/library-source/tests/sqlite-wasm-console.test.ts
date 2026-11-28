import { afterEach, describe, expect, it, vi } from 'vitest'
import { openWasmMemoryDriver } from '../src/drivers/sqlite-wasm'

/**
 * DEVICE-42: the store logs nothing. The module binds its loggers when it
 * loads, so the console is watched before this file loads it.
 */
describe('sqlite-wasm driver console', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('writes nothing to the console when a write fails, and still throws', async () => {
    const methods = ['debug', 'error', 'info', 'log', 'warn'] as const
    const spies = methods.map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    )
    const driver = await openWasmMemoryDriver()
    try {
      await driver.exec(
        'PRAGMA max_page_count = 8; CREATE TABLE t (value BLOB)',
      )
      // Eight pages hold less than this value: the insert fails with
      // SQLITE_FULL, whose result code names the failure's category.
      const failure: unknown = await driver
        .run('INSERT INTO t VALUES (?)', ['x'.repeat(200_000)])
        .then(
          () => undefined,
          (error: unknown) => error,
        )
      expect(failure).toBeInstanceOf(Error)
      expect(failure).toMatchObject({ resultCode: 13 })
    } finally {
      await driver.close()
    }
    for (const [index, spy] of spies.entries())
      expect(spy.mock.calls, methods[index]).toEqual([])
  })
})
