import assert from 'node:assert/strict'
import { test } from 'node:test'
import { QueryClient } from '@tanstack/react-query'
import type { ImportRun } from '@repo/schemas/imports'
import {
  hasNewlyCompletedImports,
  importIdlePollMs,
  importPollInterval,
  invalidateImportedLibrary,
} from './import-cache'

function run(
  id: string,
  status: ImportRun['status'],
): Pick<ImportRun, 'id' | 'status' | 'finishedAt'> {
  return {
    id,
    status,
    finishedAt:
      status === 'queued' || status === 'running'
        ? null
        : '2026-01-01T12:00:00.000Z',
  }
}

test('imports poll quickly while active and keep a slower idle guard', () => {
  assert.equal(importPollInterval(undefined), importIdlePollMs)
  assert.equal(importPollInterval([]), importIdlePollMs)
  assert.equal(importPollInterval([run('done', 'succeeded')]), importIdlePollMs)
  assert.equal(importPollInterval([run('pending', 'queued')]), 2000)
  assert.equal(
    importPollInterval([run('done', 'succeeded'), run('active', 'running')]),
    2000,
  )
})

test('reopening unchanged import history does not invalidate library caches', () => {
  const completed = [run('one', 'succeeded'), run('two', 'failed')]
  assert.equal(hasNewlyCompletedImports(completed, completed), false)
  assert.equal(
    hasNewlyCompletedImports(completed, [...completed].reverse()),
    false,
  )
  assert.equal(
    hasNewlyCompletedImports(completed, [run('one', 'succeeded')]),
    false,
  )
  assert.equal(hasNewlyCompletedImports([], [run('queued', 'queued')]), false)
})

test('newly observed terminal imports invalidate even after partial failure', () => {
  for (const status of [
    'succeeded',
    'failed',
    'cancelled',
  ] satisfies ImportRun['status'][]) {
    assert.equal(
      hasNewlyCompletedImports([run('one', 'running')], [run('one', status)]),
      true,
    )
    assert.equal(hasNewlyCompletedImports([], [run('one', status)]), true)
  }
})

test('completed imports invalidate derived library data without deleting cached rows', async () => {
  const client = new QueryClient()
  const affected = [
    ['albums', 'browse', 'default', 1],
    ['films', 'facets', ''],
    ['album', 'fixture'],
    ['film', 'fixture'],
    ['tracks', 'browse', 'default', 1],
    ['track', 'fixture'],
    ['tags', 'infinite'],
    ['tag-detail', 'film', 'fixture'],
    ['tag-provenance', 'album', 'fixture'],
    ['playlists'],
    ['playlist', 'fixture'],
    ['album-playlists', 'fixture'],
    ['film-collections'],
    ['film-collection', 'fixture'],
    ['album-picker', ''],
    ['album-selection'],
    ['film-selection'],
    ['lastfm-links'],
    ['history', 'fixture'],
    ['jobs'],
    ['job-activity'],
  ]
  try {
    for (const key of affected) client.setQueryData(key, ['cached'])
    client.setQueryData(['imports'], ['completed'])
    client.setQueryData(['providers'], ['unchanged'])
    await invalidateImportedLibrary(client)
    for (const key of affected) {
      assert.equal(client.getQueryState(key)?.isInvalidated, true)
      assert.deepEqual(client.getQueryData(key), ['cached'])
    }
    assert.equal(client.getQueryState(['imports'])?.isInvalidated, false)
    assert.equal(client.getQueryState(['providers'])?.isInvalidated, false)
  } finally {
    client.clear()
  }
})
