import { describe, expect, it } from 'vitest'
import type { PlaylistSyncSchedule } from '@repo/schemas/tracks'
import { nextPlaylistSyncAt } from './playlist-sync'

type Input = Parameters<typeof nextPlaylistSyncAt>[0]

const base: Input = {
  syncable: true,
  schedule: 'daily',
  checkedAt: new Date('2026-05-01T10:00:00.000Z'),
  importedAt: new Date('2026-04-01T10:00:00.000Z'),
  jobStatus: 'succeeded',
}
const intervals: Array<[PlaylistSyncSchedule, string]> = [
  ['1h', '2026-05-01T11:00:00.000Z'],
  ['3h', '2026-05-01T13:00:00.000Z'],
  ['6h', '2026-05-01T16:00:00.000Z'],
  ['daily', '2026-05-02T10:00:00.000Z'],
  ['weekly', '2026-05-08T10:00:00.000Z'],
]
const waiting: Array<Partial<Input>> = [
  { schedule: 'off' },
  { syncable: false },
  { checkedAt: null, importedAt: null },
  { jobStatus: 'queued' },
  { jobStatus: 'running' },
  { jobStatus: 'failed' },
  { jobStatus: 'cancelled' },
]

describe('nextPlaylistSyncAt', () => {
  it.each(intervals)(
    'measures %s from the last check',
    (schedule, expected) => {
      expect(nextPlaylistSyncAt({ ...base, schedule })?.toISOString()).toBe(
        expected,
      )
    },
  )

  it('falls back to the import time before the first recorded check', () => {
    expect(
      nextPlaylistSyncAt({ ...base, checkedAt: null })?.toISOString(),
    ).toBe('2026-04-02T10:00:00.000Z')
  })

  it.each(waiting)('has no next time for %o', (change) => {
    expect(nextPlaylistSyncAt({ ...base, ...change })).toBeNull()
  })

  it('schedules a playlist whose import job is no longer stored', () => {
    expect(
      nextPlaylistSyncAt({ ...base, jobStatus: null })?.toISOString(),
    ).toBe('2026-05-02T10:00:00.000Z')
  })
})
