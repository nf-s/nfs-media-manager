import assert from 'node:assert/strict'
import { test } from 'node:test'
import { JobSchema } from '@repo/schemas/job'
import {
  artistMetadataQuery,
  dispatchArtistSelection,
  dispatchArtistSnapshot,
} from './artist-selection'

test('an invalid saved artist sort does not discard valid search or filters', () => {
  const freshness = [{ provider: 'spotify', mode: 'never' }]
  const params = new URLSearchParams({
    q: 'Fixture artist',
    sortBy: 'lastScrapedAt',
    freshness: JSON.stringify(freshness),
    playlistIds: '["fixture-playlist"]',
    filters:
      '[{"field":"playlist","value":"Fixture favourites","mode":"required"}]',
    ranges: '[{"field":"trackCount","min":2,"includeMissing":false}]',
    limitResults: '25',
  })
  const query = artistMetadataQuery(params)
  assert.equal(query.sortBy, 'name')
  assert.equal(query.q, 'Fixture artist')
  assert.deepEqual(query.freshness, freshness)
  assert.deepEqual(query.playlistIds, ['fixture-playlist'])
  assert.deepEqual(query.filters, [
    { field: 'playlist', value: 'Fixture favourites', mode: 'required' },
  ])
  assert.deepEqual(query.ranges, [
    { field: 'trackCount', min: 2, includeMissing: false },
  ])
  assert.equal(query.limitResults, 25)
  params.set('q', 'Changed artist')
  params.set('provider', 'invalid')
  assert.equal(artistMetadataQuery(params).q, 'Changed artist')
})

test('invalid artist browse fields do not erase valid freshness and playlist selection', () => {
  const query = artistMetadataQuery(
    new URLSearchParams({
      filters: '{invalid',
      ranges: 'invalid',
      limitResults: '-1',
      freshness: '[{"provider":"spotify","mode":"never"}]',
      playlistIds: '["fixture-playlist"]',
    }),
  )
  assert.deepEqual(query.filters, [])
  assert.deepEqual(query.ranges, [])
  assert.equal(query.limitResults, undefined)
  assert.deepEqual(query.freshness, [{ provider: 'spotify', mode: 'never' }])
  assert.deepEqual(query.playlistIds, ['fixture-playlist'])
})

const job = JobSchema.parse({
  id: 'fixture-job',
  provider: 'musicbrainz',
  status: 'queued',
  scope: {},
  options: { task: 'artist-enrichment', artistId: 'fixture-artist' },
  confirmBroadRun: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  startedAt: null,
  finishedAt: null,
  errorMessage: null,
  logs: [],
  items: [],
})

test('artist selections queue unique bounded batches and report skipped pairs', async () => {
  const ids = Array.from({ length: 205 }, (_, index) => `artist-${index}`)
  const calls: string[][] = []
  const progress: number[] = []
  const result = await dispatchArtistSelection(
    [...ids, ids[0] ?? ''],
    async (chunk) => {
      calls.push(chunk)
      return {
        jobs: [job],
        skipped: [
          {
            artistId: chunk[0] ?? '',
            provider: 'spotify',
            reason: 'Provider unavailable.',
          },
        ],
      }
    },
    (count) => progress.push(count),
  )
  assert.deepEqual(
    calls.map((chunk) => chunk.length),
    [100, 100, 5],
  )
  assert.deepEqual(progress, [100, 200, 205])
  assert.deepEqual(result.completed, ids)
  assert.equal(result.queued, 3)
  assert.equal(result.skipped, 3)
  assert.deepEqual(result.warnings, ['Provider unavailable.'])
})

test('an uncertain artist batch stops without retrying or clearing unconfirmed selections', async () => {
  const ids = Array.from({ length: 250 }, (_, index) => `artist-${index}`)
  let calls = 0
  const result = await dispatchArtistSelection(
    ids,
    async () => {
      calls += 1
      if (calls === 2) throw new Error('Fixture disconnect')
      return { jobs: [job], skipped: [] }
    },
    () => {},
  )
  assert.equal(calls, 2)
  assert.equal(result.queued, 1)
  assert.deepEqual(result.completed, ids.slice(0, 100))
  assert.match(result.warnings[0] ?? '', /Check artist jobs before retrying/)
})

test('all matching selection dispatches only bounded snapshot IDs without loading records', async () => {
  const ids = Array.from(
    { length: 1001 },
    (_, index) => `artist-${String(index).padStart(4, '0')}`,
  )
  const reads: Array<string | undefined> = []
  const sends: string[][] = []
  const result = await dispatchArtistSnapshot(
    ['artist-0005'],
    async (after) => {
      reads.push(after)
      const offset = after ? ids.indexOf(after) + 1 : 0
      const page = ids.slice(offset, offset + 100)
      return {
        ids: page,
        nextCursor: offset + 100 < ids.length ? (page.at(-1) ?? null) : null,
        totalCount: ids.length,
        expiresAt: '2027-01-01T00:00:00.000Z',
      }
    },
    async (batch) => {
      sends.push(batch)
      return { jobs: [], skipped: [] }
    },
    () => {},
  )
  assert.equal(reads.length, 11)
  assert.equal(sends.flat().length, 1000)
  assert.ok(sends.every((batch) => batch.length <= 100))
  assert.ok(!result.completed.includes('artist-0005'))
  assert.deepEqual(
    result.completed,
    ids.filter((id) => id !== 'artist-0005'),
  )
})

test('snapshot dispatch stops before another read after an uncertain batch', async () => {
  let reads = 0
  let sends = 0
  const result = await dispatchArtistSnapshot(
    [],
    async () => {
      reads += 1
      return {
        ids: [`artist-${reads}`],
        nextCursor: `artist-${reads}`,
        totalCount: 5,
        expiresAt: '2027-01-01T00:00:00.000Z',
      }
    },
    async () => {
      sends += 1
      if (sends === 2) throw new Error('Fixture disconnect')
      return { jobs: [], skipped: [] }
    },
    () => {},
  )
  assert.equal(reads, 2)
  assert.equal(sends, 2)
  assert.deepEqual(result.completed, ['artist-1'])
  assert.match(result.warnings[0] ?? '', /Check artist jobs before retrying/)
})

test('snapshot expiry preserves confirmed progress and repeated cursors cannot loop', async () => {
  for (const expires of [true, false]) {
    let reads = 0
    let sends = 0
    const result = await dispatchArtistSnapshot(
      [],
      async () => {
        reads += 1
        if (expires && reads === 2) throw new Error('Fixture expired')
        return {
          ids: ['artist-1'],
          nextCursor: 'artist-1',
          totalCount: 5,
          expiresAt: '2027-01-01T00:00:00.000Z',
        }
      },
      async () => {
        sends += 1
        return { jobs: [], skipped: [] }
      },
      () => {},
    )
    assert.equal(reads, 2)
    assert.equal(sends, 1)
    assert.deepEqual(result.completed, ['artist-1'])
    assert.equal(result.warnings.length, 1)
  }
})
