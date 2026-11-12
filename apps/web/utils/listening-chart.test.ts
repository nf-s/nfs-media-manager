import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ListeningMonthSchema,
  ListeningTrackSchema,
} from '@repo/schemas/lastfm'
import {
  albumListeningPath,
  listeningBars,
  monthBars,
  scrobblesByPosition,
  yearBars,
} from './listening-chart'

const months = ListeningMonthSchema.array().parse([
  { month: '2019-11', count: 3 },
  { month: '2019-12', count: 1 },
  { month: '2020-02', count: 4 },
  { month: '2022-01', count: 8 },
])

test('year view aggregates months and keeps empty years between first and last', () => {
  assert.deepEqual(
    yearBars(months).map((bar) => [bar.period, bar.count, bar.share]),
    [
      ['2019', 4, 50],
      ['2020', 4, 50],
      ['2021', 0, 0],
      ['2022', 8, 100],
    ],
  )
})

test('month view fills empty months across year boundaries', () => {
  const bars = monthBars(months)
  assert.equal(bars.length, 27)
  assert.deepEqual(
    bars.slice(0, 4).map((bar) => [bar.period, bar.year, bar.count]),
    [
      ['2019-11', '2019', 3],
      ['2019-12', '2019', 1],
      ['2020-01', '2020', 0],
      ['2020-02', '2020', 4],
    ],
  )
  assert.equal(bars.at(-1)?.period, '2022-01')
  assert.equal(bars.at(-1)?.share, 100)
  assert.equal(
    bars.reduce((sum, bar) => sum + bar.count, 0),
    16,
  )
})

test('no scrobbles produce no bars', () => {
  assert.deepEqual(listeningBars([], 'year'), [])
  assert.deepEqual(listeningBars([], 'month'), [])
})

test('a single month is one full-height bar', () => {
  const single = ListeningMonthSchema.array().parse([
    { month: '2024-06', count: 2 },
  ])
  assert.deepEqual(listeningBars(single, 'month'), [
    { period: '2024-06', year: '2024', count: 2, share: 100 },
  ])
  assert.deepEqual(listeningBars(single, 'year'), [
    { period: '2024', year: '2024', count: 2, share: 100 },
  ])
})

test('track counts sum entries per album position and skip unmatched tracks', () => {
  const tracks = ListeningTrackSchema.array().parse([
    {
      key: 'a',
      title: 'Opening',
      position: 1,
      count: 5,
      lastListenedAt: '2024-01-01T00:00:00Z',
    },
    {
      key: 'a-live',
      title: 'Opening (Live)',
      position: 1,
      count: 2,
      lastListenedAt: '2024-01-01T00:00:00Z',
    },
    {
      key: 'b',
      title: 'Unknown',
      position: null,
      count: 9,
      lastListenedAt: '2024-01-01T00:00:00Z',
    },
  ])
  const counts = scrobblesByPosition(tracks)
  assert.equal(counts.get(1), 7)
  assert.equal(counts.size, 1)
})

test('listening path encodes the optional track key', () => {
  assert.equal(albumListeningPath('one', ''), '/api/v1/albums/one/listening')
  const url = new URL(
    albumListeningPath('one', 'artist & title?'),
    'http://localhost',
  )
  assert.equal(url.pathname, '/api/v1/albums/one/listening')
  assert.equal(url.searchParams.get('track'), 'artist & title?')
})
