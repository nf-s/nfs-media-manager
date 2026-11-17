import assert from 'node:assert/strict'
import { test } from 'node:test'
import { recentListeningMonths } from './listening-months'

test('ends with the current UTC month, oldest first, with gaps as zero', () => {
  assert.deepEqual(
    recentListeningMonths(
      [
        { month: '2025-11', count: 4 },
        { month: '2025-12', count: 1 },
        { month: '2026-03', count: 7 },
        { month: '2026-11', count: 2 },
      ],
      new Date('2026-11-17T09:00:00.000Z'),
    ),
    [1, 0, 0, 7, 0, 0, 0, 0, 0, 0, 0, 2],
  )
})

test('uses UTC month boundaries, not local time', () => {
  const months = [
    { month: '2026-10', count: 3 },
    { month: '2026-11', count: 5 },
  ]
  assert.deepEqual(
    recentListeningMonths(months, new Date('2026-10-31T23:59:59.999Z'), 2),
    [0, 3],
  )
  assert.deepEqual(
    recentListeningMonths(months, new Date('2026-11-01T00:00:00.000Z'), 2),
    [3, 5],
  )
})

test('crosses a year boundary', () => {
  assert.deepEqual(
    recentListeningMonths(
      [
        { month: '2025-12', count: 6 },
        { month: '2026-01', count: 2 },
      ],
      new Date('2026-01-15T00:00:00.000Z'),
      3,
    ),
    [0, 6, 2],
  )
})

test('an empty series is twelve zeros', () => {
  assert.deepEqual(
    recentListeningMonths([], new Date('2026-11-17T00:00:00.000Z')),
    Array.from({ length: 12 }, () => 0),
  )
})

test('a series that ended more than twelve months ago is all zeros', () => {
  assert.deepEqual(
    recentListeningMonths(
      [
        { month: '2019-03', count: 9 },
        { month: '2025-11', count: 4 },
      ],
      new Date('2026-11-17T00:00:00.000Z'),
    ),
    Array.from({ length: 12 }, () => 0),
  )
})
