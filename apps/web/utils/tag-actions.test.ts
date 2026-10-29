import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { TagProvenancePage } from '@repo/schemas/tags'
import {
  dispatchTagVisibility,
  relevantTagSources,
  tagSelectionMediaType,
} from './tag-actions'
import { updateJobSelection } from './job-selection'

test('tag actions reject empty and mixed-media selections', () => {
  assert.equal(
    tagSelectionMediaType([{ mediaType: 'album' }, { mediaType: 'album' }]),
    'album',
  )
  assert.equal(tagSelectionMediaType([{ mediaType: 'film' }]), 'film')
  assert.equal(
    tagSelectionMediaType([{ mediaType: 'album' }, { mediaType: 'film' }]),
    null,
  )
  assert.equal(tagSelectionMediaType([]), null)
})

function source(
  url: string,
  onMedia: boolean | null,
): TagProvenancePage['items'][number] {
  return {
    provider: 'fixture',
    source: null,
    providerLabel: 'Fixture',
    rawName: 'Original name',
    kind: 'keyword',
    onMedia,
    linkKind: 'tag',
    link: { provider: 'fixture', providerLabel: 'Fixture', name: 'Tag', url },
  }
}

test('compact links deduplicate exact URLs and omit other-film and unresolved origins', () => {
  const first = source('https://example.com/tags/one', true)
  const global = source('https://example.com/tags/two', null)
  assert.deepEqual(
    relevantTagSources([
      source('https://example.com/tags/one', false),
      first,
      { ...first, rawName: 'Merged alias', sourceId: 'opaque-id' },
      { ...first, link: null },
      global,
      source('https://example.com/tags/other-film', false),
    ]),
    [first, global],
  )
})

test('visibility dispatch deduplicates and bounds requests without limiting selection', async () => {
  const ids = Array.from({ length: 251 }, (_, index) => `tag-${index}`)
  const batches: string[][] = []
  const result = await dispatchTagVisibility(
    [...ids, 'tag-0'],
    async (batch) => {
      batches.push(batch)
    },
  )
  assert.deepEqual(
    batches.map((batch) => batch.length),
    [100, 100, 51],
  )
  assert.deepEqual(result, { completed: ids, interrupted: false })
})

test('visibility failure retains only confirmed batches and never retries or dispatches later batches', async () => {
  const ids = Array.from({ length: 251 }, (_, index) => `tag-${index}`)
  const batches: string[][] = []
  const result = await dispatchTagVisibility(ids, async (batch) => {
    batches.push(batch)
    if (batches.length === 2) throw new Error('unconfirmed')
  })
  assert.equal(batches.length, 2)
  assert.deepEqual(result, { completed: ids.slice(0, 100), interrupted: true })
})

test('empty visibility selection sends no requests', async () => {
  const result = await dispatchTagVisibility([], async () =>
    assert.fail('Unexpected request'),
  )
  assert.deepEqual(result, { completed: [], interrupted: false })
})

test('tag ranges use displayed order, reverse selection, deselection, and missing anchors', () => {
  const ids = ['tag-c', 'tag-a', 'tag-b', 'tag-d']
  assert.deepEqual(updateJobSelection([], ids, 'tag-b', 'tag-c', true, true), [
    'tag-c',
    'tag-a',
    'tag-b',
  ])
  assert.deepEqual(updateJobSelection([], ids, 'tag-c', 'tag-b', true, true), [
    'tag-c',
    'tag-a',
    'tag-b',
  ])
  assert.deepEqual(
    updateJobSelection(ids, ids, 'tag-c', 'tag-b', true, false),
    ['tag-d'],
  )
  assert.deepEqual(
    updateJobSelection([], ids, 'tag-b', 'filtered-out', true, true),
    ['tag-b'],
  )
})
