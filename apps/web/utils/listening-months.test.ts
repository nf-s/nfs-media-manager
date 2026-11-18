import assert from 'node:assert/strict'
import { test } from 'node:test'
import { listeningMonthsSince } from './listening-months'

test('runs from the month of the start to the current UTC month, with gaps as zero', () => {
  assert.deepEqual(
    listeningMonthsSince(
      [
        { month: '2025-12', count: 1 },
        { month: '2026-03', count: 7 },
        { month: '2026-11', count: 2 },
      ],
      '2025-11-28',
      new Date('2026-11-17T09:00:00.000Z'),
    ),
    [0, 1, 0, 0, 7, 0, 0, 0, 0, 0, 0, 0, 2],
  )
})

test('every item gets the same months, whenever its own scrobbles began', () => {
  const now = new Date('2026-11-17T00:00:00.000Z')
  const old = listeningMonthsSince(
    [{ month: '2009-03', count: 9 }],
    '2009-03-08',
    now,
  )
  const recent = listeningMonthsSince(
    [{ month: '2026-10', count: 4 }],
    '2009-03-08',
    now,
  )
  assert.equal(old.length, 213)
  assert.equal(recent.length, old.length)
  assert.equal(old[0], 9)
  assert.equal(recent[recent.length - 2], 4)
  assert.deepEqual(
    listeningMonthsSince([], '2009-03-08', now),
    Array.from({ length: 213 }, () => 0),
  )
})

test('uses UTC month boundaries, not local time', () => {
  const months = [
    { month: '2026-10', count: 3 },
    { month: '2026-11', count: 5 },
  ]
  assert.deepEqual(
    listeningMonthsSince(
      months,
      '2026-09-30',
      new Date('2026-10-31T23:59:59.999Z'),
    ),
    [0, 3],
  )
  assert.deepEqual(
    listeningMonthsSince(
      months,
      '2026-09-30',
      new Date('2026-11-01T00:00:00.000Z'),
    ),
    [0, 3, 5],
  )
})

test('crosses a year boundary', () => {
  assert.deepEqual(
    listeningMonthsSince(
      [
        { month: '2025-12', count: 6 },
        { month: '2026-01', count: 2 },
      ],
      '2025-11-01',
      new Date('2026-01-15T00:00:00.000Z'),
    ),
    [0, 6, 2],
  )
})

test('a start in the current month, or after it, is the current month alone', () => {
  const months = [{ month: '2026-11', count: 2 }]
  assert.deepEqual(
    listeningMonthsSince(
      months,
      '2026-11-17',
      new Date('2026-11-17T00:00:00.000Z'),
    ),
    [2],
  )
  assert.deepEqual(
    listeningMonthsSince(
      months,
      '2026-12-01',
      new Date('2026-11-17T00:00:00.000Z'),
    ),
    [2],
  )
})
