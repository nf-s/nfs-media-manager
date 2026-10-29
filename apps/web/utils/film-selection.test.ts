import assert from 'node:assert/strict'
import test from 'node:test'
import { dispatchFilmSelection } from './film-selection'
import { updateJobSelection } from './job-selection'

test('selection has no total cap and supports inclusive shift ranges and deselection', () => {
  const ids = Array.from({ length: 251 }, (_, i) => `film-${i}`)
  const last = ids.at(-1)
  assert.ok(last)
  const selected = updateJobSelection(
    ['film-0'],
    ids,
    last,
    'film-0',
    true,
    true,
  )
  assert.equal(selected.length, 251)
  assert.equal(
    updateJobSelection(selected, ids, 'film-0', last, true, false).length,
    0,
  )
})
test('sends explicit films serially in bounded chunks, with no overall selection cap', async () => {
  const ids = Array.from({ length: 251 }, (_, i) => `film-${i}`)
  const sizes: number[] = []
  const progress: number[] = []
  let active = 0
  const result = await dispatchFilmSelection(
    [...ids, 'film-0'],
    async (chunk) => {
      active++
      assert.equal(active, 1)
      sizes.push(chunk.length)
      await Promise.resolve()
      active--
      return {
        batchId: 'batch',
        queued: chunk.length,
        skipped: 0,
        warnings: [],
      }
    },
    (count) => progress.push(count),
  )
  assert.deepEqual(sizes, [100, 100, 51])
  assert.deepEqual(progress, [100, 200, 251])
  assert.equal(result.queued, 251)
  assert.equal(result.interrupted, false)
})
test('stops on uncertain failure, retaining confirmed results and unsubmitted selections', async () => {
  const ids = Array.from({ length: 251 }, (_, i) => `film-${i}`)
  let calls = 0
  const result = await dispatchFilmSelection(
    ids,
    async (chunk) => {
      if (++calls === 2) throw new Error('connection lost')
      return {
        batchId: 'batch',
        queued: chunk.length - 1,
        skipped: 1,
        warnings: ['Missing ID'],
      }
    },
    () => {},
  )
  assert.equal(calls, 2)
  assert.equal(result.completed.length, 100)
  assert.equal(result.queued, 99)
  assert.equal(result.skipped, 1)
  assert.equal(result.interrupted, true)
  assert.equal(result.warnings.length, 2)
})
