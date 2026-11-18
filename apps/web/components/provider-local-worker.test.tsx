import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  QueryClient,
  QueryClientProvider,
  QueryObserver,
} from '@tanstack/react-query'
import {
  ProviderLocalWorkerStatusSchema,
  type ProviderLocalWorkerStatus,
} from '@repo/schemas/provider'
import {
  providerLocalWorkerQuery,
  useProviderLocalWorkerMode,
  useProviderLocalWorkerPair,
} from './provider-local-worker'

const idle = ProviderLocalWorkerStatusSchema.parse({
  mode: 'cloud',
  supportsModeSwitch: true,
  configured: true,
  paired: true,
  online: true,
  lastSeenAt: 1,
  blocked: false,
  active: false,
})
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 10))

test('worker status backs off while idle and keeps active requests responsive', () => {
  const client = new QueryClient()
  const options = providerLocalWorkerQuery('', 'fixture')
  const observer = new QueryObserver(client, options)
  try {
    const cases: Array<{
      status: ProviderLocalWorkerStatus
      expected: number
    }> = [
      { status: idle, expected: 30_000 },
      { status: { ...idle, mode: 'local' }, expected: 30_000 },
      { status: { ...idle, paired: false, online: false }, expected: 30_000 },
      { status: { ...idle, blocked: true }, expected: 30_000 },
      { status: { ...idle, active: true }, expected: 5000 },
    ]
    for (const { status, expected } of cases) {
      client.setQueryData(options.queryKey, status)
      const interval = options.refetchInterval
      assert.equal(
        typeof interval === 'function'
          ? interval(observer.getCurrentQuery())
          : interval,
        expected,
      )
    }
  } finally {
    observer.destroy()
    client.clear()
  }
})

test('recent worker status is shared across mounted views and refreshes immediately when invalidated', async (t) => {
  const client = new QueryClient()
  const fetch = t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ statusCode: 200, message: 'OK', data: idle }),
  )
  const options = providerLocalWorkerQuery('', 'fixture')
  const first = new QueryObserver(client, options)
  const closeFirst = first.subscribe(() => {})
  const second = new QueryObserver(client, options)
  let closeSecond = () => {}
  try {
    await settle()
    closeSecond = second.subscribe(() => {})
    await settle()
    assert.equal(fetch.mock.callCount(), 1)
    assert.deepEqual(second.getCurrentResult().data, idle)

    await client.invalidateQueries({ queryKey: options.queryKey })
    assert.equal(fetch.mock.callCount(), 2)
    assert.deepEqual(second.getCurrentResult().data, idle)
  } finally {
    closeFirst()
    closeSecond()
    client.clear()
  }
})

test('changing worker mode keeps the returned status without a duplicate read', async (t) => {
  const client = new QueryClient()
  const options = providerLocalWorkerQuery('', 'fixture')
  const updated = ProviderLocalWorkerStatusSchema.parse({
    ...idle,
    mode: 'local',
  })
  client.setQueryData(options.queryKey, idle)
  const observer = new QueryObserver(client, options)
  const close = observer.subscribe(() => {})
  const requests: string[] = []
  t.mock.method(
    globalThis,
    'fetch',
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(init?.method ?? 'GET')
      return Response.json({
        statusCode: 200,
        message: 'OK',
        data:
          init?.method === 'POST' ? { token: null, status: updated } : updated,
      })
    },
  )
  let changeMode:
    | ((mode: ProviderLocalWorkerStatus['mode']) => Promise<unknown>)
    | undefined
  function ModeControl() {
    changeMode = useProviderLocalWorkerMode('fixture').mutateAsync
    return null
  }
  try {
    renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ModeControl />
      </QueryClientProvider>,
    )
    assert.ok(changeMode)
    await changeMode('local')
    assert.deepEqual(requests, ['POST'])
    assert.deepEqual(observer.getCurrentResult().data, updated)
  } finally {
    close()
    client.clear()
  }
})

test('failed worker mode changes refresh the status before returning the error', async (t) => {
  const client = new QueryClient()
  const options = providerLocalWorkerQuery('', 'fixture')
  client.setQueryData(options.queryKey, idle)
  const observer = new QueryObserver(client, options)
  const close = observer.subscribe(() => {})
  const requests: string[] = []
  t.mock.method(
    globalThis,
    'fetch',
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(init?.method ?? 'GET')
      return init?.method === 'POST'
        ? Response.json({ message: 'Queue active' }, { status: 409 })
        : Response.json({ statusCode: 200, message: 'OK', data: idle })
    },
  )
  let changeMode:
    | ((mode: ProviderLocalWorkerStatus['mode']) => Promise<unknown>)
    | undefined
  function ModeControl() {
    changeMode = useProviderLocalWorkerMode('fixture').mutateAsync
    return null
  }
  try {
    renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ModeControl />
      </QueryClientProvider>,
    )
    assert.ok(changeMode)
    await assert.rejects(changeMode('local'))
    assert.deepEqual(requests, ['POST', 'GET'])
    assert.deepEqual(observer.getCurrentResult().data, idle)
  } finally {
    close()
    client.clear()
  }
})

test('pairing sends one no-store request and keeps only status in query and mutation data', async (t) => {
  const client = new QueryClient()
  const options = providerLocalWorkerQuery('', 'fixture')
  const token = 'a'.repeat(43)
  const paired = { ...idle, online: false }
  const requests: Array<{
    method: string | undefined
    cache: RequestCache | undefined
    body: BodyInit | null | undefined
  }> = []
  t.mock.method(
    globalThis,
    'fetch',
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        method: init?.method,
        cache: init?.cache,
        body: init?.body,
      })
      return Response.json({
        statusCode: 200,
        message: 'OK',
        data: { token, status: paired },
      })
    },
  )
  let pair: (() => Promise<unknown>) | undefined
  function PairControl() {
    pair = useProviderLocalWorkerPair('fixture').request.mutateAsync
    return null
  }
  try {
    renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <PairControl />
      </QueryClientProvider>,
    )
    assert.ok(pair)
    assert.deepEqual(await pair(), paired)
    assert.deepEqual(requests, [
      { method: 'POST', cache: 'no-store', body: '{"mode":"pair"}' },
    ])
    assert.deepEqual(client.getQueryData(options.queryKey), paired)
    assert.deepEqual(
      client
        .getMutationCache()
        .getAll()
        .map(({ state }) => state.data),
      [paired],
    )
  } finally {
    client.clear()
  }
})

test('acknowledging a worker request posts only review and refreshes provider safety and queue reads', async (t) => {
  const client = new QueryClient()
  const worker = providerLocalWorkerQuery('', 'fixture')
  const reads = [
    ['providers'],
    ['providers', 'overview', 'all'],
    ['jobs', 'dispatch', 'fixture'],
  ]
  client.setQueryData(worker.queryKey, { ...idle, blocked: true })
  for (const key of reads) client.setQueryData(key, { paused: true })
  const network = t.mock.method(
    globalThis,
    'fetch',
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      assert.equal(init?.method, 'POST')
      assert.equal(init?.body, '{"mode":"review"}')
      return Response.json({
        statusCode: 200,
        message: 'OK',
        data: { token: null, status: idle },
      })
    },
  )
  let review: (() => Promise<unknown>) | undefined
  function ReviewControl() {
    const control = useProviderLocalWorkerMode('fixture')
    review = () => control.mutateAsync('review')
    return null
  }
  try {
    renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ReviewControl />
      </QueryClientProvider>,
    )
    assert.ok(review)
    await review()
    assert.equal(network.mock.callCount(), 1)
    assert.deepEqual(client.getQueryData(worker.queryKey), idle)
    for (const key of reads) {
      assert.equal(client.getQueryState(key)?.isInvalidated, true)
      assert.deepEqual(client.getQueryData(key), { paused: true })
    }
  } finally {
    client.clear()
  }
})
