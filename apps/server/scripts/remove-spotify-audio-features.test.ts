import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'
import { removeStoredSpotifyAudioFeatures } from './remove-spotify-audio-features'

const database = vi.hoisted(() => ({
  execute: vi.fn<(query: SQL) => Promise<{ rows: unknown[] }>>(),
  transaction: vi.fn(),
  end: vi.fn(),
}))
vi.mock('@/lib/db', () => ({
  db: {
    transaction: database.transaction,
    $client: { end: database.end },
  },
}))

describe('audio feature cleanup CLI with mocked database', () => {
  let directory: string
  let conflict = false
  let includeSnapshot = false
  const statements: string[] = []
  beforeEach(async () => {
    vi.clearAllMocks()
    statements.length = 0
    conflict = false
    includeSnapshot = false
    directory = await mkdtemp(join(tmpdir(), 'audio-cleanup-test-'))
    database.transaction.mockImplementation(
      async (
        callback: (tx: {
          execute: typeof database.execute
        }) => Promise<unknown>,
      ) => callback({ execute: database.execute }),
    )
    database.execute.mockImplementation(async (statement) => {
      const query = new PgDialect().sqlToQuery(statement)
      statements.push(query.sql)
      if (
        query.sql.includes('select to_jsonb(t)') &&
        query.sql.includes('from "media_item"') &&
        query.params.length === 0
      ) {
        return {
          rows: [
            {
              row: {
                id: 'album',
                media_type: 'album',
                metadata: { browse: { energy: 0.8, scrobbles: 0 } },
                title: 'Retained title',
              },
            },
          ],
        }
      }
      if (
        includeSnapshot &&
        query.sql.includes('from "provider_snapshot"') &&
        query.params.length === 0
      ) {
        return {
          rows: [
            {
              row: {
                id: 'snapshot',
                media_item_id: 'album',
                provider: 'spotify',
                payload: { energy: 0.8 },
                normalized_data: null,
                checksum: 'old',
              },
            },
          ],
        }
      }
      if (query.sql.includes('update "provider_snapshot"')) {
        expect(query.sql).toContain(
          'coalesce("normalized_data", \'null\'::jsonb) is not distinct from',
        )
        expect(query.sql).toContain(
          'coalesce("payload", \'null\'::jsonb) is not distinct from',
        )
        return { rows: [{ id: 'snapshot' }] }
      }
      if (query.sql.includes('update "media_item"')) {
        // The backup must already be durable when the first update is attempted.
        const backup = await readFile(
          join(directory, 'backup', 'media_item.jsonl'),
          'utf8',
        )
        expect(backup).toContain('"energy":0.8')
        expect(query.sql).toContain('is not distinct from')
        return { rows: conflict ? [] : [{ id: 'album' }] }
      }
      return { rows: [] }
    })
  })
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('defaults to a read-only audit without update statements', async () => {
    const report = await removeStoredSpotifyAudioFeatures([])
    expect(report.changedRows).toBe(1)
    expect(statements[0]).toBe('set transaction read only')
    expect(
      statements.some((statement) => statement.startsWith('update ')),
    ).toBe(false)
    expect(database.end).toHaveBeenCalledOnce()
  })

  it('writes private original-row backups before narrowly scoped updates', async () => {
    const backup = join(directory, 'backup')
    const report = await removeStoredSpotifyAudioFeatures([
      '--apply',
      `--backup-dir=${backup}`,
    ])
    expect(report.tables.media_item?.updated).toBe(1)
    expect((await stat(backup)).mode & 0o777).toBe(0o700)
    expect((await stat(join(backup, 'media_item.jsonl'))).mode & 0o777).toBe(
      0o600,
    )
    expect(await readFile(join(backup, 'report.json'), 'utf8')).toContain(
      '"changedRows": 1',
    )
    await expect(
      removeStoredSpotifyAudioFeatures(['--apply', `--backup-dir=${backup}`]),
    ).rejects.toThrow()
    expect(database.transaction).toHaveBeenCalledOnce()
  })

  it('aborts on a concurrent update, retains the preimage and closes its pool', async () => {
    conflict = true
    const backup = join(directory, 'backup')
    await expect(
      removeStoredSpotifyAudioFeatures(['--apply', `--backup-dir=${backup}`]),
    ).rejects.toThrow('Concurrent change')
    expect(await readFile(join(backup, 'media_item.jsonl'), 'utf8')).toContain(
      '"energy":0.8',
    )
    await expect(stat(join(backup, 'report.json'))).rejects.toThrow()
    expect(database.end).toHaveBeenCalledOnce()
  })

  it('guards both checksum inputs even when normalized data is nullable and unchanged', async () => {
    includeSnapshot = true
    const report = await removeStoredSpotifyAudioFeatures([
      '--apply',
      `--backup-dir=${join(directory, 'backup')}`,
    ])
    expect(report.tables.provider_snapshot?.updated).toBe(1)
  })
})
