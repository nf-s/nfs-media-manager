import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { LibraryChange } from '@repo/schemas/library-changes'
import {
  describeLibraryChange,
  describeMergeCaution,
  libraryChangeBlock,
} from './library-changes'

const record = (id: string, title: string) => ({
  id,
  title,
  by: 'Fixture Artist',
  exists: true,
})
const change: LibraryChange = {
  id: 'change-1',
  kind: 'track',
  action: 'merge',
  actor: 'owner',
  rule: null,
  batchId: null,
  target: record('kept', 'Night Drive'),
  sources: [record('merged', 'Nite Drive')],
  names: [
    { artistName: 'Fixture Artist', trackName: 'Nite Drive', scrobbles: 2 },
  ],
  nameCount: 1,
  scrobbles: 2,
  createdAt: '2024-01-01T00:00:00.000Z',
  undoneAt: null,
  reversible: true,
  canUndo: true,
  canRedo: false,
  blocked: null,
  details: null,
}

test('a change is described by its action, the names it moved and its records', () => {
  assert.equal(
    describeLibraryChange(change),
    'Merged “Nite Drive” into “Night Drive”',
  )
  assert.equal(
    describeLibraryChange({
      ...change,
      sources: [record('a', 'Nite Drive'), record('b', 'Night Drive (Demo)')],
    }),
    'Merged 2 tracks into “Night Drive”',
  )
  assert.equal(
    describeLibraryChange({ ...change, action: 'move' }),
    'Moved “Nite Drive” to “Night Drive”',
  )
  assert.equal(
    describeLibraryChange({ ...change, action: 'move', nameCount: 1200 }),
    'Moved 1,200 names to “Night Drive”',
  )
  assert.equal(
    describeLibraryChange({
      ...change,
      action: 'separate',
      target: record('merged', 'Nite Drive'),
      sources: [record('kept', 'Night Drive')],
    }),
    'Separated “Nite Drive” from “Night Drive”',
  )
  assert.equal(
    describeLibraryChange({ ...change, action: 'rematch' }),
    'Returned “Nite Drive” to automatic matching',
  )
})

test('undo is offered only while the names are where the change put them', () => {
  assert.equal(libraryChangeBlock(change), null)
  assert.equal(
    libraryChangeBlock({ ...change, canUndo: false }),
    'A later change moved these names. Undo that change first.',
  )
  assert.equal(
    libraryChangeBlock({
      ...change,
      undoneAt: '2024-01-02T00:00:00.000Z',
      canUndo: false,
      canRedo: true,
    }),
    null,
  )
  assert.match(
    libraryChangeBlock({ ...change, reversible: false, canUndo: false }) ?? '',
    /cannot be undone/,
  )
})

test('each caution reads as one sentence', () => {
  assert.equal(
    describeMergeCaution({ code: 'version', words: ['Demo'] }),
    '“Demo” is in some titles only.',
  )
  assert.equal(
    describeMergeCaution({ code: 'version', words: ['Live', 'Demo'] }),
    '“Live” and “Demo” are in some titles only.',
  )
  assert.equal(
    describeMergeCaution({ code: 'duration', seconds: 60 }),
    'Lengths differ by 1:00.',
  )
  assert.equal(
    describeMergeCaution({
      code: 'artists',
      names: ['Fixture Artist', 'Other Band'],
    }),
    'The artists differ: Fixture Artist, Other Band.',
  )
})
