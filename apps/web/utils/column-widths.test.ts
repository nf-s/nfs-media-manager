import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  SavedWidthsSchema,
  resizedWidth,
  tableColumnLayout,
  tableWidthLimits,
} from './column-widths'

const limits = { min: 70, max: 650 }

test('a drag changes a column by the distance moved, within its limits', () => {
  assert.equal(resizedWidth({ width: 200, delta: 40, limits }), 240)
  assert.equal(resizedWidth({ width: 200, delta: -40, limits }), 160)
  assert.equal(resizedWidth({ width: 200, delta: -400, limits }), 70)
  assert.equal(resizedWidth({ width: 200, delta: 900, limits }), 650)
  assert.equal(
    resizedWidth({ width: 200, rendered: 200.4, delta: 12, limits }),
    212,
  )
})

test('the column that takes the leftover room grows from its width on screen', () => {
  const stretched = { width: 240, rendered: 500, limits }
  assert.equal(resizedWidth({ ...stretched, delta: 30 }), 530)
  // Narrowing changes nothing until the drag passes the column's set width.
  assert.equal(resizedWidth({ ...stretched, delta: -100 }), 240)
  assert.equal(resizedWidth({ ...stretched, delta: -300 }), 200)
  // Wider on screen than the limit: its set width stays as it is.
  assert.equal(
    resizedWidth({ width: 240, rendered: 900, delta: 20, limits }),
    240,
  )
})

test('every column keeps its width and the last keyed column takes the rest', () => {
  const widthFor = (key: string) => ({ title: 300, status: 120 })[key] ?? 140
  assert.deepEqual(
    tableColumnLayout([36, 'title', 'status', 'result', 84], widthFor),
    {
      widths: [36, 300, 120, undefined, 84],
      sizes: [36, 300, 120, 140, 84],
      minWidth: 680,
    },
  )
  // `sizes` keeps the filling column's own width, for the table's least width.
  assert.deepEqual(tableColumnLayout(['title'], widthFor), {
    widths: [undefined],
    sizes: [300],
    minWidth: 300,
  })
  assert.deepEqual(tableColumnLayout([36, 84], widthFor), {
    widths: [36, 84],
    sizes: [36, 84],
    minWidth: 120,
  })
})

test('a table can name the column that takes the rest', () => {
  const widthFor = (key: string) => ({ title: 300, status: 120 })[key] ?? 140
  assert.deepEqual(
    tableColumnLayout([36, 'title', 'status', 'count'], widthFor, 'title'),
    {
      widths: [36, undefined, 120, 140],
      sizes: [36, 300, 120, 140],
      minWidth: 596,
    },
  )
  // Hidden, it leaves the room to the last keyed column.
  assert.deepEqual(
    tableColumnLayout([36, 'status', 'count'], widthFor, 'title'),
    { widths: [36, 120, undefined], sizes: [36, 120, 140], minWidth: 296 },
  )
})

test('saved widths outside the limits are rejected', () => {
  assert.ok(SavedWidthsSchema.safeParse({ title: 320, count: 48 }).success)
  assert.ok(
    !SavedWidthsSchema.safeParse({ title: tableWidthLimits.max + 1 }).success,
  )
  assert.ok(!SavedWidthsSchema.safeParse({ title: 'wide' }).success)
})
