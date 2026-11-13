import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ListeningMonthSchema,
  ListeningTrackSchema,
} from '@repo/schemas/lastfm'
import {
  albumListeningPath,
  barLayout,
  chartPoints,
  LABEL_CHAR_WIDTH,
  listeningBars,
  monthBars,
  periodAt,
  periodScrobbles,
  scrobblesByPosition,
  steppedPeriod,
  xLabelIndices,
  yearBars,
  yTicks,
  type ListeningPeriod,
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

test('y ticks are distinct integers from zero with two to four intervals', () => {
  assert.deepEqual(yTicks(0), [0, 1])
  assert.deepEqual(yTicks(1), [0, 1])
  assert.deepEqual(yTicks(2), [0, 1, 2])
  assert.deepEqual(yTicks(3), [0, 1, 2, 3])
  assert.deepEqual(yTicks(8), [0, 2, 4, 6, 8])
  assert.deepEqual(yTicks(42), [0, 25, 50])
  assert.deepEqual(yTicks(100), [0, 25, 50, 75, 100])
  for (let max = 2; max <= 5000; max += 7) {
    const ticks = yTicks(max)
    assert.ok(ticks.length >= 3 && ticks.length <= 5, `max ${max}`)
    assert.ok(ticks.every(Number.isInteger), `max ${max}`)
    assert.ok((ticks.at(-1) ?? 0) >= max, `max ${max}`)
  }
})

function labelGaps(indices: number[], count: number, plotWidth: number) {
  const { slot } = barLayout(count, plotWidth)
  return indices.slice(1).map((index, i) => (index - (indices[i] ?? 0)) * slot)
}

const decades = ListeningMonthSchema.array().parse([
  { month: '1996-04', count: 2 },
  { month: '2025-09', count: 5 },
])

test('x labels keep their spacing at narrow and wide widths', () => {
  const minimum = 4 * LABEL_CHAR_WIDTH
  for (const period of ['year', 'month'] satisfies ListeningPeriod[]) {
    const bars = listeningBars(decades, period)
    for (const width of [264, 400, 800, 1600]) {
      const indices = xLabelIndices(bars, period, width)
      assert.ok(indices.length > 0)
      for (const gap of labelGaps(indices, bars.length, width))
        assert.ok(gap >= minimum, `${period} ${width}: ${gap}`)
    }
  }
})

test('year view labels every year when there is room', () => {
  const bars = yearBars(months)
  assert.deepEqual(xLabelIndices(bars, 'year', 600), [0, 1, 2, 3])
})

test('month view labels Januaries and a partial first year with room', () => {
  const bars = monthBars(months)
  const labelled = xLabelIndices(bars, 'month', 600).map(
    (index) => bars[index]?.period,
  )
  assert.deepEqual(labelled, ['2019-11', '2020-01', '2021-01', '2022-01'])
  assert.deepEqual(
    xLabelIndices(
      monthBars(
        ListeningMonthSchema.array().parse([
          { month: '2024-03', count: 1 },
          { month: '2024-05', count: 1 },
        ]),
      ),
      'month',
      600,
    ),
    [0],
  )
})

test('month bars narrow to fit without gaps instead of scrolling', () => {
  const wide = barLayout(10, 500)
  assert.equal(wide.slot, 50)
  assert.ok(wide.barWidth < wide.slot)
  assert.equal(barLayout(1, 600).barWidth, 48)
  const narrow = barLayout(360, 264)
  assert.equal(narrow.barWidth, narrow.slot)
  assert.ok(narrow.slot * 360 <= 264)
})

test('points sit at slot centres scaled to the top tick', () => {
  const plot = { left: 10, top: 0, width: 120, height: 50 }
  assert.deepEqual(chartPoints([0, 5, 10], 10, plot), [
    { x: 30, y: 50 },
    { x: 70, y: 25 },
    { x: 110, y: 0 },
  ])
  assert.equal(periodAt(0, 3, plot), 0)
  assert.equal(periodAt(75, 3, plot), 1)
  assert.equal(periodAt(500, 3, plot), 2)
  assert.equal(periodAt(50, 0, plot), null)
})

test('line points run from the left edge of the plot to the right', () => {
  const plot = { left: 10, top: 0, width: 120, height: 50 }
  assert.deepEqual(
    chartPoints([0, 5, 10], 10, plot, 'line').map((point) => point.x),
    [10, 70, 130],
  )
  assert.deepEqual(chartPoints([5], 10, plot, 'line'), [{ x: 70, y: 25 }])
  assert.equal(periodAt(35, 3, plot, 'line'), 0)
  assert.equal(periodAt(45, 3, plot, 'line'), 1)
  assert.equal(periodAt(500, 3, plot, 'line'), 2)
})

test('keyboard steps through periods and stays in range', () => {
  assert.equal(steppedPeriod(null, 'ArrowLeft', 4), 3)
  assert.equal(steppedPeriod(2, 'ArrowLeft', 4), 1)
  assert.equal(steppedPeriod(0, 'ArrowLeft', 4), 0)
  assert.equal(steppedPeriod(3, 'ArrowRight', 4), 3)
  assert.equal(steppedPeriod(1, 'Home', 4), 0)
  assert.equal(steppedPeriod(1, 'End', 4), 3)
  assert.equal(steppedPeriod(1, 'Enter', 4), null)
})

test('period readout uses singular and plural scrobbles', () => {
  assert.equal(
    periodScrobbles({ period: '2019-03', year: '2019', count: 1, share: 100 }),
    '2019-03: 1 scrobble',
  )
  assert.equal(
    periodScrobbles({ period: '2019', year: '2019', count: 42, share: 100 }),
    '2019: 42 scrobbles',
  )
})
