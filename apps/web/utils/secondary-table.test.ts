import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sortTableRows } from './secondary-table'

test('secondary table sorting uses numeric values and keeps absent values last in either direction', () => {
  const rows = [
    { value: 12 },
    { value: null },
    { value: 0 },
    { value: 2 },
    { value: NaN },
  ]
  assert.deepEqual(
    sortTableRows(
      rows,
      { key: 'value', direction: 'asc' },
      (row) => row.value,
    ).map((row) => row.value),
    [0, 2, 12, null, NaN],
  )
  assert.deepEqual(
    sortTableRows(
      rows,
      { key: 'value', direction: 'desc' },
      (row) => row.value,
    ).map((row) => row.value),
    [12, 2, 0, null, NaN],
  )
  assert.equal(rows[0]?.value, 12)
})

test('secondary table text sorting is natural, case insensitive and stable for ties', () => {
  const rows = [
    { name: 'Item 12', id: 1 },
    { name: 'item 2', id: 2 },
    { name: 'Item 2', id: 3 },
  ]
  assert.deepEqual(
    sortTableRows(
      rows,
      { key: 'name', direction: 'asc' },
      (row) => row.name,
    ).map((row) => row.id),
    [2, 3, 1],
  )
})

test('secondary table date and boolean sorts compare raw values', () => {
  const rows = [
    { date: '2025-12-01', checked: true },
    { date: '2026-02-01', checked: false },
  ]
  assert.equal(
    sortTableRows(rows, { key: 'date', direction: 'desc' }, (row) =>
      Date.parse(row.date),
    )[0]?.date,
    '2026-02-01',
  )
  assert.equal(
    sortTableRows(
      rows,
      { key: 'checked', direction: 'asc' },
      (row) => row.checked,
    )[0]?.checked,
    false,
  )
})
