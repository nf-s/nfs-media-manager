import assert from 'node:assert/strict'
import { test } from 'node:test'
import { QueryClient } from '@tanstack/react-query'
import type { SetTagParentsInput, TagProvenancePage } from '@repo/schemas/tags'
import {
  dispatchTagBatches,
  dispatchTagParents,
  invalidateTags,
  relevantTagSources,
  tagSelectionMediaType,
} from './tag-actions'
import { updateJobSelection } from './job-selection'

test('tag changes invalidate both library selections and retain unrelated cached data', async () => {
  const client = new QueryClient()
  const affected = [
    ['album-selection', 'tag filter'],
    ['film-selection', 'tag filter'],
    ['albums', 'facets', 'tag'],
    ['films', 'facets', 'tag'],
    ['tracks', 'facets', 'tag'],
    ['tracks', 'browse', 'tag filter'],
    ['artists', 'facets', 'tag'],
    ['artists', 'browse-count', 'tag filter'],
    ['tags', 'hierarchy', 'album'],
    ['tag-detail', 'album', 'tag-1'],
  ]
  try {
    for (const key of [...affected, ['subscriptions', 'sources']])
      client.setQueryData(key, { fixture: true })
    await invalidateTags(client)
    for (const key of affected) {
      assert.equal(
        client.getQueryState(key)?.isInvalidated,
        true,
        key.join('/'),
      )
      assert.deepEqual(client.getQueryData(key), { fixture: true })
    }
    assert.equal(
      client.getQueryState(['subscriptions', 'sources'])?.isInvalidated,
      false,
    )
  } finally {
    client.clear()
  }
})

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

test('tag batches deduplicate and bound requests without limiting selection', async () => {
  const ids = Array.from({ length: 251 }, (_, index) => `tag-${index}`)
  const batches: string[][] = []
  const result = await dispatchTagBatches([...ids, 'tag-0'], async (batch) => {
    batches.push(batch)
  })
  assert.deepEqual(
    batches.map((batch) => batch.length),
    [100, 100, 51],
  )
  assert.deepEqual(result, { completed: ids, interrupted: false })
})

test('a failed tag batch keeps only confirmed batches, returns the failure and sends no later batches', async () => {
  const ids = Array.from({ length: 251 }, (_, index) => `tag-${index}`)
  const batches: string[][] = []
  const failure = { statusCode: 409, message: 'Unconfirmed' }
  const result = await dispatchTagBatches(ids, async (batch) => {
    batches.push(batch)
    if (batches.length === 2) throw failure
  })
  assert.equal(batches.length, 2)
  assert.deepEqual(result, {
    completed: ids.slice(0, 100),
    interrupted: true,
    error: failure,
  })
})

test('an empty tag selection sends no requests', async () => {
  const result = await dispatchTagBatches([], async () =>
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

test('parent changes send each batch of 100 tags with the same parents and mode', async () => {
  const tagIds = Array.from({ length: 205 }, (_, index) => `tag-${index}`)
  const bodies: SetTagParentsInput[] = []
  const result = await dispatchTagParents(
    { mediaType: 'film', tagIds, parentIds: ['parent-1'], mode: 'add' },
    async (body) => {
      bodies.push(body)
    },
  )
  assert.deepEqual(
    bodies.map((body) => body.tagIds.length),
    [100, 100, 5],
  )
  assert.deepEqual(
    bodies.flatMap((body) => body.tagIds),
    tagIds,
  )
  assert.ok(
    bodies.every(
      (body) =>
        body.mediaType === 'film' &&
        body.mode === 'add' &&
        body.parentIds.join() === 'parent-1',
    ),
  )
  assert.deepEqual(result, { completed: tagIds, interrupted: false })
})

test('removing all parents sends replace with no parents and stops at a conflict', async () => {
  const tagIds = Array.from({ length: 150 }, (_, index) => `tag-${index}`)
  const conflict = {
    statusCode: 409,
    message: 'A tag cannot sit beneath one of its own subtags',
  }
  const bodies: SetTagParentsInput[] = []
  const result = await dispatchTagParents(
    { mediaType: 'album', tagIds, parentIds: [], mode: 'replace' },
    async (body) => {
      bodies.push(body)
      if (bodies.length === 2) throw conflict
    },
  )
  assert.equal(bodies.length, 2)
  assert.ok(bodies.every((body) => body.parentIds.length === 0))
  assert.deepEqual(result, {
    completed: tagIds.slice(0, 100),
    interrupted: true,
    error: conflict,
  })
})
