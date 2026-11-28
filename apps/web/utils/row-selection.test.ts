import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  describeRowSelection,
  emptyRowSelection,
  replaceRows,
  rowSelectionFor,
  selectMatchingRows,
  setLoadedRows,
  toggleRow,
  type SelectionRows,
} from './row-selection'

// Four of 128 matching tracks are loaded; track-3 is outside the library.
const loaded = ['track-1', 'track-2', 'track-3', 'track-4']
const rows: SelectionRows = {
  ordered: loaded,
  result: { ids: loaded, total: 128 },
  outside: ['track-3'],
}
const view = 'tracks:{"q":"rain"}:table'

test('ticking rows selects them; once every loaded row is ticked the bar offers all 128', () => {
  let state = emptyRowSelection(view)
  assert.equal(describeRowSelection(state, rows).count, 0)
  state = toggleRow(state, rows, 'track-2', true, false)
  let shown = describeRowSelection(state, rows)
  assert.deepEqual(shown.ids, ['track-2'])
  assert.equal(shown.has('track-2'), true)
  assert.equal(shown.some, true)
  assert.equal(shown.offerMatching, false)
  assert.equal(shown.canSelectMatching, true)
  // A shift-click ticks the range from the last row ticked.
  state = toggleRow(state, rows, 'track-4', true, true)
  assert.deepEqual(describeRowSelection(state, rows).ids, [
    'track-2',
    'track-3',
    'track-4',
  ])
  state = setLoadedRows(state, rows, true)
  shown = describeRowSelection(state, rows)
  assert.equal(shown.count, 4)
  assert.equal(shown.all, true)
  assert.equal(shown.matching, false)
  assert.equal(shown.offerMatching, true)
  // Not when every match is loaded, nor where the result cannot be selected.
  assert.equal(
    describeRowSelection(state, {
      ...rows,
      result: { ids: loaded, total: 4 },
    }).offerMatching,
    false,
  )
  assert.equal(
    describeRowSelection(state, { ordered: loaded }).offerMatching,
    false,
  )
  assert.equal(setLoadedRows(state, rows, false).ids.length, 0)
})

test('Select all matching selects the whole result: rows load ticked, unticking one excludes it', () => {
  let state = selectMatchingRows(
    toggleRow(emptyRowSelection(view), rows, 'track-1', true, false),
    rows,
  )
  let shown = describeRowSelection(state, rows)
  assert.equal(shown.matching, true)
  assert.equal(shown.everyMatch, true)
  assert.deepEqual(shown.ids, [])
  assert.equal(shown.count, 128)
  assert.equal(shown.total, 128)
  assert.equal(shown.all, true)
  assert.equal(shown.canSelectMatching, false)
  assert.equal(shown.offerMatching, false)
  // A row loaded later is ticked too.
  assert.equal(shown.has('track-90'), false)
  const later = describeRowSelection(state, {
    ordered: ['track-90'],
    result: { ids: ['track-90'], total: 128 },
  })
  assert.equal(later.has('track-90'), true)

  state = toggleRow(state, rows, 'track-3', false, false)
  state = toggleRow(state, rows, 'track-4', false, false)
  shown = describeRowSelection(state, rows)
  assert.deepEqual(shown.excludeIds, ['track-3', 'track-4'])
  assert.equal(shown.outsideExcluded, 1)
  assert.equal(shown.count, 126)
  assert.equal(shown.has('track-3'), false)
  assert.equal(shown.everyMatch, false)
  assert.equal(shown.some, true)
  // The toolbar link is offered again to take every match back.
  assert.equal(shown.canSelectMatching, true)

  // Ticking a row again takes it back.
  state = toggleRow(state, rows, 'track-4', true, false)
  shown = describeRowSelection(state, rows)
  assert.deepEqual(shown.excludeIds, ['track-3'])
  assert.equal(shown.count, 127)
  // The header ticks the loaded rows back in.
  state = setLoadedRows(state, rows, true)
  shown = describeRowSelection(state, rows)
  assert.equal(shown.everyMatch, true)
  assert.equal(shown.outsideExcluded, 0)
  // Unticking the header clears the whole selection.
  shown = describeRowSelection(setLoadedRows(state, rows, false), rows)
  assert.equal(shown.matching, false)
  assert.equal(shown.count, 0)
})

test('a whole-result selection counts the result as it is recounted', () => {
  const state = toggleRow(
    selectMatchingRows(emptyRowSelection(view), rows),
    rows,
    'track-1',
    false,
    false,
  )
  assert.equal(
    describeRowSelection(state, { ...rows, result: { ids: loaded } }).count,
    127,
  )
  assert.equal(
    describeRowSelection(state, {
      ...rows,
      result: { ids: loaded, total: 140 },
    }).count,
    139,
  )
  // Nothing to select before the result is counted.
  const uncounted = { ...rows, result: { ids: loaded } }
  const empty = emptyRowSelection(view)
  assert.equal(selectMatchingRows(empty, uncounted), empty)
  assert.equal(describeRowSelection(empty, uncounted).canSelectMatching, false)
})

test('release versions under a track are not part of a whole-result selection', () => {
  const withVersions: SelectionRows = {
    ...rows,
    ordered: ['track-1', 'version-1', ...loaded.slice(1)],
  }
  const state = selectMatchingRows(emptyRowSelection(view), withVersions)
  const shown = describeRowSelection(state, withVersions)
  assert.equal(shown.has('version-1'), false)
  assert.equal(shown.selectable('version-1'), false)
  assert.equal(shown.selectable('track-1'), true)
  assert.equal(shown.all, true)
  assert.equal(
    toggleRow(state, withVersions, 'version-1', true, false).matching?.excluded
      .length,
    0,
  )
  assert.equal(
    describeRowSelection(emptyRowSelection(view), withVersions).selectable(
      'version-1',
    ),
    true,
  )
})

test('changing the search, a filter, the scope, the sort or the view clears either selection', () => {
  const ticked = toggleRow(
    emptyRowSelection(view),
    rows,
    'track-1',
    true,
    false,
  )
  const matching = selectMatchingRows(ticked, rows)
  const next = 'tracks:{"q":"rain","sortBy":"title"}:table'
  for (const state of [ticked, matching]) {
    assert.equal(rowSelectionFor(state, view), state)
    const shown = describeRowSelection(rowSelectionFor(state, next), rows)
    assert.equal(shown.count, 0)
    assert.equal(shown.matching, false)
  }
})

test('a merge that comes back is a selection of ticked rows', () => {
  const state = replaceRows(selectMatchingRows(emptyRowSelection(view), rows), [
    'track-1',
    'track-2',
  ])
  const shown = describeRowSelection(state, rows)
  assert.equal(shown.matching, false)
  assert.equal(shown.count, 2)
})
