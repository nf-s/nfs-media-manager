import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  formatAge,
  formatElapsed,
  formatItemCount,
  formatRuntime,
  formatTrackLength,
  formatUntil,
} from '@repo/ui/lib/format'
import {
  DAY_MS,
  axisLabels,
  bucketTrend,
  periodLabel,
  smoothPath,
  sparkValues,
  trendTicks,
  utcDay,
} from '@repo/ui/lib/trend'

const today = utcDay('2026-11-16')

function daily(from: string, to: string, count: (index: number) => number) {
  const samples = []
  for (let t = utcDay(from), index = 0; t <= utcDay(to); t += DAY_MS, index++)
    if (count(index) > 0) samples.push({ t, v: count(index) })
  return samples
}

test('counts name the item and show a filtered total', () => {
  const noun = { one: 'album', other: 'albums' }
  assert.equal(formatItemCount(128, noun), '128 albums')
  assert.equal(formatItemCount(1, noun), '1 album')
  assert.equal(formatItemCount(6, noun, 1280), '6 of 1,280 albums')
  assert.equal(formatItemCount(1, noun, 1), '1 album')
})

test('durations, ages and waits use one format each', () => {
  assert.equal(formatTrackLength(250_000), '4:10')
  assert.equal(formatTrackLength(3_765_000), '1:02:45')
  assert.equal(formatTrackLength(null), '–')
  assert.equal(formatRuntime(42), '42 min')
  assert.equal(formatRuntime(171), '2h 51m')
  assert.equal(formatElapsed(8_000), '8s')
  assert.equal(formatElapsed(252_000), '4m 12s')
  assert.equal(formatElapsed(3_900_000), '1h 05m')
  const now = new Date(2026, 10, 16, 12, 0)
  assert.equal(formatAge(new Date(2026, 10, 16, 11, 59, 40), now), 'just now')
  assert.equal(formatAge(new Date(2026, 10, 16, 11, 55), now), '5 min ago')
  assert.equal(formatAge(new Date(2026, 10, 16, 9, 0), now), '3 h ago')
  assert.equal(formatAge(new Date(2026, 10, 14, 12, 0), now), '2 days ago')
  assert.equal(formatAge(new Date(2026, 6, 16, 12, 0), now), '4 months ago')
  assert.equal(formatAge(new Date(2024, 10, 16, 12, 0), now), '2 years ago')
  assert.equal(formatAge(null, now), '–')
  assert.equal(formatUntil(new Date(2026, 10, 16, 14, 20), now), '14:20')
  assert.equal(
    formatUntil(new Date(2026, 10, 17, 9, 0), now),
    '2026-11-17 09:00',
  )
})

test('a dense recent history is drawn by day and fills empty days with zero', () => {
  const samples = daily('2026-10-18', '2026-11-16', (index) =>
    index % 7 === 3 ? 0 : 5,
  )
  const series = bucketTrend(samples, '30d', { today })
  assert.equal(series.grain, 'day')
  assert.equal(series.points.length, 30)
  assert.equal(series.points[3]?.v, 0)
  assert.equal(series.points[series.points.length - 1]?.t, today)
})

test('a sparse history takes the coarsest grain that still gives ten points', () => {
  const samples = [
    { t: utcDay('2026-01-10'), v: 1 },
    { t: utcDay('2026-06-02'), v: 2 },
    { t: utcDay('2026-11-01'), v: 1 },
  ]
  const series = bucketTrend(samples, '1y', { today })
  assert.equal(series.grain, 'month')
  assert.ok(series.points.length >= 10)
  assert.equal(
    series.points.reduce((sum, point) => sum + point.v, 0),
    4,
  )
})

test('the grain coarsens with density, range and chart width', () => {
  const samples = daily('2021-11-17', '2026-11-16', () => 4)
  assert.equal(bucketTrend(samples, '5y', { today }).grain, 'month')
  assert.equal(bucketTrend(samples, '1y', { today }).grain, 'week')
  assert.equal(
    bucketTrend(samples, '1y', { today, maxPoints: 20 }).grain,
    'month',
  )
  for (const maxPoints of [12, 40, 120])
    assert.ok(
      bucketTrend(samples, 'all', { today, maxPoints }).points.length <=
        maxPoints,
    )
})

test('all time never shows less than thirty days, even with no history', () => {
  const empty = bucketTrend([], 'all', { today })
  assert.equal(empty.points.length, 30)
  assert.ok(empty.points.every((point) => point.v === 0))
  const recent = bucketTrend([{ t: today - 2 * DAY_MS, v: 9 }], 'all', {
    today,
  })
  assert.equal(recent.points.length, 30)
})

test('all time starts at the given start when it is earlier than the first sample', () => {
  const samples = [
    { t: utcDay('2024-03-01'), v: 6 },
    { t: utcDay('2026-11-01'), v: 2 },
  ]
  const own = bucketTrend(samples, 'all', { today, finest: 'month' })
  assert.equal(own.points[0]?.t, utcDay('2024-01-01'))
  const shared = bucketTrend(samples, 'all', {
    today,
    finest: 'month',
    from: utcDay('2010-06-20'),
  })
  assert.equal(shared.grain, 'year')
  assert.equal(shared.points[0]?.t, utcDay('2010-01-01'))
  assert.equal(shared.points.length, 17)
  assert.equal(
    shared.points.reduce((sum, point) => sum + point.v, 0),
    8,
  )
  const later = bucketTrend(samples, 'all', {
    today,
    finest: 'month',
    from: utcDay('2025-01-01'),
  })
  assert.equal(later.points[0]?.t, own.points[0]?.t)
  const ranged = bucketTrend(samples, '1y', {
    today,
    finest: 'month',
    from: utcDay('2010-06-20'),
  })
  assert.equal(ranged.points[0]?.t, utcDay('2025-11-01'))
})

test('monthly samples never use a grain finer than a month', () => {
  const samples = Array.from({ length: 140 }, (_, index) => ({
    t: Date.UTC(2015 + Math.floor(index / 12), index % 12, 1),
    v: 30,
  }))
  const series = bucketTrend(samples, 'all', { today, finest: 'month' })
  assert.notEqual(series.grain, 'day')
  assert.notEqual(series.grain, 'week')
  assert.ok(series.points.length <= 120)
})

test('the line passes through every point and never overshoots a flat run', () => {
  const path = smoothPath([
    [0, 10],
    [10, 10],
    [20, 2],
    [30, 2],
  ])
  assert.equal(path.start, 'M0 10')
  assert.equal(path.segments.length, 3)
  assert.match(path.segments[0] ?? '', /^C3\.3 10 6\.7 10 10 10$/)
  assert.match(path.segments[2] ?? '', / 30 2$/)
  assert.deepEqual(smoothPath([[0, 1]]), { start: 'M0 1', segments: [] })
  assert.deepEqual(smoothPath([]), { start: '', segments: [] })
})

test('ticks, labels and sparklines stay small and round', () => {
  assert.deepEqual(trendTicks(1), [0, 1])
  assert.deepEqual(trendTicks(47), [0, 20, 40, 60])
  assert.deepEqual(trendTicks(1240), [0, 500, 1000, 1500])
  assert.equal(periodLabel(utcDay('2026-11-01'), 'month', false), 'Nov 2026')
  assert.equal(
    periodLabel(utcDay('2026-10-01'), 'quarter', true),
    'Oct–Dec 2026, so far',
  )
  assert.equal(periodLabel(utcDay('2026-11-16'), 'day', true), '2026-11-16')
  const months = Array.from({ length: 36 }, (_, index) => ({
    t: Date.UTC(2024 + Math.floor(index / 12), index % 12, 1),
    v: 1,
  }))
  assert.deepEqual(
    axisLabels(months, 'month', 8).map((label) => label.text),
    ['2024', '2025', '2026'],
  )
  assert.equal(axisLabels(months, 'month', 1).length, 1)
  assert.equal(sparkValues(Array.from({ length: 52 }, () => 1)).length, 13)
  assert.deepEqual(sparkValues([1, 2, 3]), [1, 2, 3])
  assert.deepEqual(sparkValues([1, 2, 3, 4, 5, 6, 7], 3), [1, 9, 18])
})
