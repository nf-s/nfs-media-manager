import { describe, expect, it, vi } from 'vitest'
import {
  audioCleanupTargets,
  parseAudioCleanupArguments,
  planAudioFeatureCleanup,
  runAudioFeatureCleanup,
  type AudioCleanupRow,
  type AudioCleanupTarget,
} from './audio-feature-cleanup'
import { checksumJson } from './media-utils'

function targetFor(table: string) {
  const target = audioCleanupTargets.find((entry) => entry.table === table)
  if (!target) throw new Error(`Missing test target: ${table}`)
  return target
}

describe('audio feature cleanup planning', () => {
  it('removes raw and normalized features but keeps snapshot identity, timestamps and unrelated data', () => {
    const row = {
      id: 'snapshot',
      media_item_id: 'album',
      provider: 'spotify',
      checksum: 'old',
      payload: {
        title: 'Album',
        audio_features: [{ energy: 0.4 }],
        popularity: 0,
      },
      normalized_data: {
        mediaPatch: {
          metadata: { browse: { energy: 0.4, ratingRymValue: 4 } },
        },
      },
      created_at: '2020-01-01',
      scrape_job_id: 'job',
      source: 'scrape-job',
    }
    const plan = planAudioFeatureCleanup(targetFor('provider_snapshot'), row)
    expect(plan.updates).toEqual({
      payload: { title: 'Album', popularity: 0 },
      normalized_data: {
        mediaPatch: { metadata: { browse: { ratingRymValue: 4 } } },
      },
      checksum: checksumJson({
        provider: 'spotify',
        payload: { title: 'Album', popularity: 0 },
        normalized: {
          mediaPatch: { metadata: { browse: { ratingRymValue: 4 } } },
        },
      }),
    })
    expect(
      planAudioFeatureCleanup(targetFor('provider_snapshot'), {
        ...row,
        ...plan.updates,
      }).changed,
    ).toBe(false)
    expect(row.checksum).toBe('old')
  })

  it('uses payload checksums for detached library/playlist snapshots', () => {
    const plan = planAudioFeatureCleanup(targetFor('provider_snapshot'), {
      id: 'library',
      media_item_id: null,
      provider: 'legacy-library',
      checksum: 'old',
      payload: {
        playlists: [
          { tracks: [{ audioFeatures: { tempo: 100 }, id: 'track' }] },
        ],
      },
      normalized_data: null,
    })
    expect(plan.updates.checksum).toBe(checksumJson(plan.updates.payload))
  })

  it('clears feature override values without deleting history rows or unrelated fields', () => {
    const target = targetFor('media_override')
    expect(
      planAudioFeatureCleanup(target, {
        id: 'o',
        field: 'metadata.browse.energy',
        value: 0,
      }).updates,
    ).toEqual({ value: null })
    expect(
      planAudioFeatureCleanup(target, {
        id: 'o',
        field: 'options.mode',
        value: 1,
      }).changed,
    ).toBe(false)
    expect(
      planAudioFeatureCleanup(target, {
        id: 'o',
        field: 'options',
        value: { mode: 1 },
      }).changed,
    ).toBe(false)
    expect(
      planAudioFeatureCleanup(target, {
        id: 'o',
        field: 'durationSec',
        value: 0,
      }).changed,
    ).toBe(false)
  })

  it('is dry-run by default and requires explicit backed-up apply', () => {
    expect(parseAudioCleanupArguments([])).toEqual({ apply: false })
    expect(parseAudioCleanupArguments(['--dry-run'])).toEqual({ apply: false })
    expect(
      parseAudioCleanupArguments(['--apply', '--backup-dir=/tmp/new-backup']),
    ).toEqual({ apply: true, backupDirectory: '/tmp/new-backup' })
    expect(() => parseAudioCleanupArguments(['--apply'])).toThrow('requires')
    expect(() => parseAudioCleanupArguments(['--apply', '--dry-run'])).toThrow(
      'not both',
    )
    expect(() => parseAudioCleanupArguments(['--typo'])).toThrow('Unknown')
  })
})

describe('offline cleanup runner', () => {
  function fixtureStore() {
    const data: Record<string, AudioCleanupRow[]> = {
      media_item: [
        { id: 'a', metadata: { browse: { energy: 0, scrobbles: 0 } } },
        { id: 'b', metadata: { browse: { scrobbles: 20 } } },
      ],
      track: [{ id: 't', metadata: { tempo: 120, duration_ms: 2000 } }],
      provider_current_state: [
        {
          id: 'p',
          media_item_id: 'a',
          provider: 'spotify',
          payload: { mode: 1, popularity: 0 },
          normalized_data: {},
          checksum: 'old',
          latest_snapshot_id: 's',
        },
      ],
    }
    const events: string[] = []
    const backups: AudioCleanupRow[] = []
    const store = {
      read: vi.fn(
        async (target: AudioCleanupTarget, cursor: string | undefined) =>
          (data[target.table] ?? [])
            .filter(
              (row) =>
                typeof row[target.idColumn] === 'string' &&
                (cursor === undefined || String(row[target.idColumn]) > cursor),
            )
            .slice(0, 1),
      ),
      backup: vi.fn(
        async (_target: AudioCleanupTarget, row: AudioCleanupRow) => {
          events.push('backup')
          backups.push(structuredClone(row))
        },
      ),
      update: vi.fn(
        async (
          target: AudioCleanupTarget,
          id: string,
          updates: AudioCleanupRow,
        ) => {
          events.push('update')
          const row = data[target.table]?.find(
            (entry) => entry[target.idColumn] === id,
          )
          if (!row) throw new Error('Missing row')
          Object.assign(row, updates)
        },
      ),
    }
    return { store, data, events, backups }
  }

  it('audits every target with counts only and performs no writes or backups', async () => {
    const { store, data } = fixtureStore()
    const before = structuredClone(data)
    const report = await runAudioFeatureCleanup(store)
    expect(report.changedRows).toBe(3)
    expect(report.tables.media_item).toMatchObject({
      scanned: 2,
      changed: 1,
      updated: 0,
      removed: { energy: 1 },
    })
    expect(Object.keys(report.tables)).toEqual(
      audioCleanupTargets.map((target) => target.table),
    )
    expect(store.backup).not.toHaveBeenCalled()
    expect(store.update).not.toHaveBeenCalled()
    expect(data).toEqual(before)
  })

  it('backs up before every update, preserves other data and does nothing on a second apply', async () => {
    const { store, data, events, backups } = fixtureStore()
    const report = await runAudioFeatureCleanup(store, true)
    expect(report.changedRows).toBe(3)
    expect(events).toEqual([
      'backup',
      'update',
      'backup',
      'update',
      'backup',
      'update',
    ])
    expect(backups[0]?.metadata).toHaveProperty('browse.energy', 0)
    expect(data.media_item?.[0]?.metadata).toEqual({ browse: { scrobbles: 0 } })
    expect(data.track?.[0]?.metadata).toEqual({ duration_ms: 2000 })
    expect(data.provider_current_state?.[0]?.latest_snapshot_id).toBe('s')
    expect((await runAudioFeatureCleanup(store, true)).changedRows).toBe(0)
    expect(store.update).toHaveBeenCalledTimes(3)
  })

  it('never updates a row if writing its backup fails', async () => {
    const { store } = fixtureStore()
    store.backup.mockRejectedValueOnce(new Error('disk full'))
    await expect(runAudioFeatureCleanup(store, true)).rejects.toThrow(
      'disk full',
    )
    expect(store.update).not.toHaveBeenCalled()
  })
})
