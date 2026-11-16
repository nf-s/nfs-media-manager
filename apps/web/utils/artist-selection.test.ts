import assert from 'node:assert/strict'
import { test } from 'node:test'
import { JobSchema } from '@repo/schemas/job'
import {
  artistMetadataQuery,
  dispatchArtistSelection,
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
