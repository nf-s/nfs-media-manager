import assert from 'node:assert/strict'
import { test } from 'node:test'
import { QueryClient, QueryObserver } from '@tanstack/react-query'
import type { Job } from '@repo/schemas/job'
import { jobDataOptions } from './job-data'

const empty = {
  jobId: 'job/1',
  snapshots: [],
  diagnostics: [],
  itemPayloads: [],
}
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 10))
function response(data: unknown = empty) {
  return Response.json({ statusCode: 200, message: 'OK', data })
}

test('mounting the open viewer reads only the exact job data endpoint; closing aborts the read', async (t) => {
  const client = new QueryClient()
  const requests: { input: RequestInfo | URL; init?: RequestInit }[] = []
  t.mock.method(
    globalThis,
    'fetch',
    (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ input, init })
      return new Promise<Response>(() => {})
    },
  )
  const observer = new QueryObserver(
    client,
    jobDataOptions('/backend', { id: 'job/1', status: 'running' }),
  )
  try {
    assert.equal(requests.length, 0)
    const close = observer.subscribe(() => {})
    assert.equal(requests.length, 1)
    assert.equal(requests[0]?.input, '/backend/api/v1/scrape/jobs/job%2F1/data')
    assert.equal(requests[0]?.init?.method ?? 'GET', 'GET')
    assert.equal(requests[0]?.init?.credentials, 'include')
    assert.equal(requests[0]?.init?.signal?.aborted, false)
    close()
    assert.equal(requests[0]?.init?.signal?.aborted, true)
  } finally {
    observer.destroy()
    client.clear()
  }
})

test('only active jobs poll and each status transition triggers a fresh stored-data read', async (t) => {
  const client = new QueryClient()
  const fetch = t.mock.method(globalThis, 'fetch', async () => response())
  const options = (status: Job['status']) =>
    jobDataOptions('', { id: 'job/1', status })
  const observer = new QueryObserver(client, options('queued'))
  const close = observer.subscribe(() => {})
  try {
    await settle()
    assert.equal(fetch.mock.callCount(), 1)
    assert.equal(options('queued').refetchInterval, 3000)
    observer.setOptions(options('running'))
    await settle()
    assert.equal(fetch.mock.callCount(), 2)
    assert.equal(options('running').refetchInterval, 3000)
    observer.setOptions(options('succeeded'))
    await settle()
    assert.equal(fetch.mock.callCount(), 3)
    assert.deepEqual(observer.getCurrentResult().data, empty)
    const terminalStatuses: Job['status'][] = [
      'succeeded',
      'failed',
      'cancelled',
    ]
    for (const status of terminalStatuses) {
      const terminal = options(status)
      assert.equal(terminal.refetchInterval, false)
      assert.equal(terminal.refetchOnWindowFocus, false)
      assert.equal(terminal.refetchOnReconnect, false)
    }
  } finally {
    close()
    client.clear()
  }
})

test('opening again refreshes cached data; changing job cannot reuse another job response', async (t) => {
  const client = new QueryClient()
  const fetch = t.mock.method(globalThis, 'fetch', async () => response())
  const options = jobDataOptions('', { id: 'job/1', status: 'failed' })
  const observer = new QueryObserver(client, options)
  const close = observer.subscribe(() => {})
  await settle()
  close()
  const reopened = new QueryObserver(client, options)
  const closeAgain = reopened.subscribe(() => {})
  try {
    await settle()
    assert.equal(fetch.mock.callCount(), 2)
    reopened.setOptions(
      jobDataOptions('', { id: 'another-job', status: 'failed' }),
    )
    assert.equal(reopened.getCurrentResult().data, undefined)
    await settle()
    assert.equal(fetch.mock.callCount(), 3)
  } finally {
    closeAgain()
    client.clear()
  }
})

test('malformed data is rejected and read failures never automatically retry', async (t) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: 3 } } })
  const fetch = t.mock.method(globalThis, 'fetch', async () =>
    response({ ...empty, snapshots: [{}] }),
  )
  const observer = new QueryObserver(
    client,
    jobDataOptions('', { id: 'job/1', status: 'failed' }),
  )
  const close = observer.subscribe(() => {})
  try {
    await settle()
    assert.equal(observer.getCurrentResult().isError, true)
    assert.equal(observer.getCurrentResult().data, undefined)
    assert.equal(fetch.mock.callCount(), 1)
    fetch.mock.mockImplementation(async () => response())
    await observer.refetch()
    assert.equal(fetch.mock.callCount(), 2)
    assert.deepEqual(observer.getCurrentResult().data, empty)
  } finally {
    close()
    client.clear()
  }
})
