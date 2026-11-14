import assert from 'node:assert/strict'
import { test } from 'node:test'
import { QueryClient, QueryObserver } from '@tanstack/react-query'
import { JobActivitySchema, JobPageSchema } from '@repo/schemas/job'
import {
  invalidateChangedJobActivity,
  jobActivityPollInterval,
  jobPagesPollInterval,
} from './job-cache'

const idle = JobActivitySchema.parse({
  queued: 0,
  running: 0,
  failed: 0,
  imports: 0,
  completed: 2,
  completedImports: 1,
})

test('activity keeps a lightweight idle check and speeds up for queued, running or importing work', () => {
  assert.equal(jobActivityPollInterval(undefined), 30_000)
  assert.equal(jobActivityPollInterval(idle), 30_000)
  assert.equal(jobActivityPollInterval({ ...idle, queued: 1 }), 4000)
  assert.equal(jobActivityPollInterval({ ...idle, running: 1 }), 4000)
  assert.equal(jobActivityPollInterval({ ...idle, imports: 1 }), 4000)
  assert.equal(jobActivityPollInterval({ ...idle, failed: 3 }), 30_000)
})

test('full job pages poll only while a loaded job can change status', () => {
  const page = JobPageSchema.parse({
    page: 1,
    size: 25,
    totalCount: 1,
    pageCount: 1,
    items: [
      {
        id: 'example-job',
        provider: 'example',
        status: 'succeeded',
        createdAt: '2026-01-01T00:00:00Z',
        startedAt: null,
        finishedAt: null,
        errorMessage: null,
        scope: {},
        options: {},
        confirmBroadRun: false,
        items: [],
        logs: [],
      },
    ],
  })
  assert.equal(jobPagesPollInterval(undefined), false)
  assert.equal(jobPagesPollInterval([]), false)
  assert.equal(jobPagesPollInterval([page]), false)
  const job = page.items[0]
  assert.ok(job)
  job.status = 'queued'
  assert.equal(jobPagesPollInterval([page]), 3000)
  job.status = 'running'
  assert.equal(jobPagesPollInterval([page]), 3000)
  job.status = 'failed'
  assert.equal(jobPagesPollInterval([page]), false)
})

test('mounting activity or re-reading unchanged counts preserves cached library and job freshness', async () => {
  const client = new QueryClient()
  client.setQueryData(['albums'], ['saved album'])
  client.setQueryData(['jobs', 'infinite', 'album'], ['saved job'])
  try {
    await invalidateChangedJobActivity(client, undefined, idle)
    await invalidateChangedJobActivity(client, idle, structuredClone(idle))
    assert.equal(client.getQueryState(['albums'])?.isInvalidated, false)
    assert.equal(
      client.getQueryState(['jobs', 'infinite', 'album'])?.isInvalidated,
      false,
    )
  } finally {
    client.clear()
  }
})

test('queue changes invalidate cached job details and filtered history without expiring library data', async () => {
  const client = new QueryClient()
  const keys = [
    ['jobs', 'detail', 'example-job'],
    ['jobs', 'infinite', 'film', 'succeeded'],
    ['providers'],
    ['lastfm-sync'],
  ]
  for (const key of [...keys, ['albums']]) client.setQueryData(key, [])
  try {
    await invalidateChangedJobActivity(client, idle, { ...idle, queued: 1 })
    for (const key of keys)
      assert.equal(client.getQueryState(key)?.isInvalidated, true)
    assert.equal(client.getQueryState(['albums'])?.isInvalidated, false)
  } finally {
    client.clear()
  }
})

test('completed or partially stopped work invalidates derived library views while keeping their cached data', async () => {
  for (const next of [
    { ...idle, completed: 3 },
    { ...idle, completedImports: 2 },
    { ...idle, failed: 1 },
    { ...idle, running: 0 },
  ]) {
    const client = new QueryClient()
    const keys = [
      ['tracks', 'browse', 'example'],
      ['track', 'example-track'],
      ['tags', 'infinite', 'album'],
      ['subscriptions', 'sources'],
      ['playlist', 'example-playlist'],
      ['playlist-additions', 'example-album'],
    ]
    for (const key of keys) client.setQueryData(key, ['cached'])
    try {
      await invalidateChangedJobActivity(client, { ...idle, running: 1 }, next)
      for (const key of keys) {
        assert.equal(client.getQueryState(key)?.isInvalidated, true)
        assert.deepEqual(client.getQueryData(key), ['cached'])
      }
    } finally {
      client.clear()
    }
  }
})

test('activity updates refetch mounted job lists in the background and keep stale results after failure', async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  })
  const key = ['jobs', 'infinite', 'film', 'succeeded']
  client.setQueryData(key, ['saved job'])
  let requests = 0
  const observer = new QueryObserver(client, {
    queryKey: key,
    queryFn: async () => {
      requests += 1
      throw new Error('Offline')
    },
  })
  const close = observer.subscribe(() => {})
  try {
    assert.equal(requests, 0)
    const refresh = invalidateChangedJobActivity(client, idle, {
      ...idle,
      completed: 3,
    })
    assert.equal(observer.getCurrentResult().isFetching, true)
    assert.deepEqual(observer.getCurrentResult().data, ['saved job'])
    await refresh
    assert.equal(requests, 1)
    assert.equal(observer.getCurrentResult().isError, true)
    assert.deepEqual(observer.getCurrentResult().data, ['saved job'])
  } finally {
    close()
    client.clear()
  }
})
