import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { QueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import { fetchApiData } from './api'
import {
  clearDeviceStore,
  startDeviceStore,
  syncDeviceStoreBeforeRefresh,
} from './device-store/bootstrap'
import {
  createDeviceController,
  READ_TIMEOUT_MS,
  START_WAIT_MS,
  type DeviceStoreHost,
  type HostEvents,
  type HostReadAnswer,
  type HostSyncOutcome,
} from './device-store/controller'
import { deviceSeam, installDeviceSeam } from './device-store/seam'
import { clearSessionData } from './logout'
import { setDeviceStoreSetting } from './device-store/setting'
import {
  deviceStoreStatus,
  type DeviceStoreStatus,
} from './device-store/status'

const countPath = '/api/v1/tracks/browse-count?q=example'
const CountSchema = z
  .object({ totalCount: z.number().int() })
  .transform(({ totalCount }) => ({ totalCount, parsed: true }))
const synced: HostSyncOutcome = {
  outcome: 'synced',
  rowsApplied: 0,
  refilled: false,
  pending: false,
}

function flush() {
  return new Promise<void>((resolve) => setImmediate(resolve))
}

async function settle() {
  for (let index = 0; index < 10; index += 1) await flush()
}

type FakeHost = DeviceStoreHost & {
  reads: string[]
  syncs: number
  destroyed: number
  events?: HostEvents
  nextSync: () => Promise<HostSyncOutcome>
}

function fakeHost(overrides: Partial<DeviceStoreHost> = {}): FakeHost {
  const host: FakeHost = {
    reads: [],
    syncs: 0,
    destroyed: 0,
    nextSync: async () => synced,
    async open(events) {
      host.events = events
      return { kind: 'opened', ready: true, syncedAt: 1 }
    },
    isLibraryRead: (path) => path.startsWith('/api/v1/tracks/'),
    async read(path) {
      host.reads.push(path)
      return { kind: 'served', data: { totalCount: 3 } }
    },
    async sync() {
      host.syncs += 1
      host.events?.verified()
      return host.nextSync()
    },
    async destroy() {
      host.destroyed += 1
    },
    ...overrides,
  }
  return host
}

function mockApi(t: TestContext, status = 200) {
  const calls: Array<{ url: string; method: string }> = []
  t.mock.method(
    globalThis,
    'fetch',
    async (url: string, init: RequestInit = {}) => {
      calls.push({ url, method: init.method ?? 'GET' })
      return Response.json(
        status === 200
          ? { statusCode: 200, message: 'OK', data: { totalCount: 9 } }
          : { statusCode: status, message: 'Unauthorized' },
        { status },
      )
    },
  )
  return calls
}

async function startController(
  t: TestContext,
  host: FakeHost,
  refresh: () => void = () => undefined,
) {
  const statuses: DeviceStoreStatus[] = []
  const controller = createDeviceController({
    loadHost: async () => host,
    publish: (status) => statuses.push(status),
    refreshLibraryQueries: refresh,
    isVisible: () => true,
  })
  installDeviceSeam(controller)
  t.after(async () => {
    installDeviceSeam(undefined)
    await controller.stop()
  })
  void controller.start()
  await settle()
  return { controller, statuses }
}

function browserGlobals(t: TestContext) {
  const saved = new Map<string, string>()
  const target = new EventTarget()
  const window = {
    localStorage: {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => saved.set(key, value),
    },
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
  }
  const document = {
    visibilityState: 'visible',
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
  }
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: window,
  })
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: document,
  })
  t.after(() => {
    Reflect.deleteProperty(globalThis, 'window')
    Reflect.deleteProperty(globalThis, 'document')
  })
}

test('with the setting off nothing loads and fetchApiData calls the API as before', async (t) => {
  browserGlobals(t)
  const calls = mockApi(t)
  let loads = 0
  setDeviceStoreSetting('off')
  const stopFollowing = startDeviceStore({
    apiBaseUrl: '',
    client: new QueryClient(),
    loadHost: async () => {
      loads += 1
      return fakeHost()
    },
  })
  assert.equal(deviceSeam(), undefined)
  assert.deepEqual(await fetchApiData('', countPath, CountSchema), {
    totalCount: 9,
    parsed: true,
  })
  assert.equal(syncDeviceStoreBeforeRefresh(), undefined)
  await clearDeviceStore()
  stopFollowing()
  assert.equal(loads, 0)
  assert.deepEqual(calls, [{ url: countPath, method: 'GET' }])
})

test('turning the setting on loads the host once and turning it off deletes the copy', async (t) => {
  browserGlobals(t)
  const host = fakeHost()
  let loads = 0
  setDeviceStoreSetting('off')
  const stopFollowing = startDeviceStore({
    apiBaseUrl: '',
    client: new QueryClient(),
    loadHost: async () => {
      loads += 1
      return host
    },
  })
  setDeviceStoreSetting('on')
  setDeviceStoreSetting('on')
  await settle()
  assert.equal(loads, 1)
  assert.ok(deviceSeam())
  assert.equal(deviceStoreStatus().state, 'ready')
  setDeviceStoreSetting('off')
  await settle()
  assert.equal(deviceSeam(), undefined)
  assert.equal(host.destroyed, 1)
  assert.deepEqual(deviceStoreStatus(), { state: 'off' })
  stopFollowing()
})

test('a served read is parsed by the caller schema and makes no request', async (t) => {
  const calls = mockApi(t)
  const host = fakeHost()
  await startController(t, host)
  const sources: string[] = []
  assert.deepEqual(
    await fetchApiData('', countPath, CountSchema, {
      onAnswer: (source) => sources.push(source),
    }),
    { totalCount: 3, parsed: true },
  )
  assert.deepEqual(host.reads, [countPath])
  assert.deepEqual(calls, [])
  assert.deepEqual(sources, ['device'])
})

test('reads the copy does not serve, cannot answer or answers wrongly go to the API', async (t) => {
  const calls = mockApi(t)
  const answers: HostReadAnswer[] = [
    { kind: 'not-served', reason: 'ai-search' },
    { kind: 'failed' },
    { kind: 'served', data: { totalCount: 'three' } },
  ]
  const host = fakeHost({
    async read() {
      return answers.shift() ?? { kind: 'failed' }
    },
  })
  await startController(t, host)
  for (let index = 0; index < 3; index += 1)
    assert.deepEqual(await fetchApiData('', countPath, CountSchema), {
      totalCount: 9,
      parsed: true,
    })
  await fetchApiData('', '/api/v1/tracks/example-id', z.unknown())
  assert.equal(calls.length, 4)
})

test('a read the Worker does not answer in time goes to the API', async (t) => {
  const calls = mockApi(t)
  const host = fakeHost({ read: () => new Promise(() => undefined) })
  await startController(t, host)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const answer = fetchApiData('', countPath, CountSchema)
  await settle()
  assert.equal(calls.length, 0)
  t.mock.timers.tick(READ_TIMEOUT_MS)
  assert.deepEqual(await answer, { totalCount: 9, parsed: true })
  assert.equal(calls.length, 1)
})

test('an aborted device read rejects with the signal reason, as fetch does', async (t) => {
  mockApi(t)
  const host = fakeHost({ read: () => new Promise(() => undefined) })
  await startController(t, host)
  const abort = new AbortController()
  const answer = fetchApiData('', countPath, CountSchema, {
    signal: abort.signal,
  })
  abort.abort()
  await assert.rejects(answer, (error: unknown) => {
    assert.ok(error instanceof DOMException)
    assert.equal(error.name, 'AbortError')
    return true
  })
})

test('reads go to the API from the start of a write until a sync with no pending marks', async (t) => {
  const calls = mockApi(t)
  const host = fakeHost()
  await startController(t, host)
  const syncs: Array<(outcome: HostSyncOutcome) => void> = []
  host.nextSync = () =>
    new Promise((resolve) => {
      syncs.push(resolve)
    })
  let finishWrite: (() => void) | undefined
  t.mock.method(
    globalThis,
    'fetch',
    async (url: string, init: RequestInit = {}) => {
      calls.push({ url, method: init.method ?? 'GET' })
      if (init.method === 'PATCH')
        await new Promise<void>((resolve) => {
          finishWrite = resolve
        })
      return Response.json({
        statusCode: 200,
        message: 'OK',
        data: { totalCount: 9 },
      })
    },
  )
  const write = fetchApiData('', '/api/v1/albums/example', z.unknown(), {
    method: 'PATCH',
    body: '{}',
  })
  await settle()
  await fetchApiData('', countPath, CountSchema)
  assert.ok(finishWrite)
  finishWrite()
  await write
  await settle()
  assert.equal(syncs.length, 1)
  await fetchApiData('', countPath, CountSchema)
  syncs.shift()?.({ ...synced, pending: true })
  await settle()
  await fetchApiData('', countPath, CountSchema)
  assert.deepEqual(host.reads, [])
  await new Promise((resolve) => setTimeout(resolve, 600))
  await settle()
  assert.equal(syncs.length, 1)
  syncs.shift()?.(synced)
  await settle()
  assert.deepEqual(await fetchApiData('', countPath, CountSchema), {
    totalCount: 3,
    parsed: true,
  })
  assert.deepEqual(host.reads, [countPath])
  assert.deepEqual(
    calls.map(({ method }) => method),
    ['PATCH', 'GET', 'GET', 'GET'],
  )
})

test('player and AI requests with a body do not hold reads on the API', async (t) => {
  mockApi(t)
  const host = fakeHost()
  await startController(t, host)
  await fetchApiData('', '/api/v1/playback/session', z.unknown(), {
    method: 'POST',
    body: '{}',
  })
  await fetchApiData('', '/api/v1/ai/search', z.unknown(), {
    method: 'POST',
    body: '{}',
  })
  await settle()
  assert.deepEqual(await fetchApiData('', countPath, CountSchema), {
    totalCount: 3,
    parsed: true,
  })
  assert.equal(host.syncs, 1)
})

test('a 401 from the API deletes the copy and later reads go to the API', async (t) => {
  const host = fakeHost()
  const { statuses } = await startController(t, host)
  mockApi(t, 401)
  await assert.rejects(fetchApiData('', '/api/v1/jobs', z.unknown()))
  await settle()
  assert.equal(host.destroyed, 1)
  assert.deepEqual(statuses.at(-1), { state: 'signed-out' })
  t.mock.restoreAll()
  const calls = mockApi(t)
  await fetchApiData('', countPath, CountSchema)
  assert.deepEqual(host.reads, [])
  assert.equal(calls.length, 1)
})

test('a 401 or 403 from the feed deletes the copy', async (t) => {
  const host = fakeHost()
  host.nextSync = async () => ({ outcome: 'unauthorized' })
  const { statuses } = await startController(t, host)
  assert.equal(host.destroyed, 1)
  assert.deepEqual(statuses.at(-1), { state: 'signed-out' })
})

test('while another tab holds the copy, reads go straight to the API', async (t) => {
  const calls = mockApi(t)
  const host = fakeHost({
    open(events) {
      events.otherTab()
      return new Promise(() => undefined)
    },
  })
  const { statuses } = await startController(t, host)
  assert.deepEqual(statuses.at(-1), { state: 'other-tab' })
  await fetchApiData('', countPath, CountSchema)
  assert.deepEqual(host.reads, [])
  assert.equal(calls.length, 1)
})

test('reads at page start wait for the session check, then go to the API if it is late', async (t) => {
  const calls = mockApi(t)
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const host = fakeHost({ sync: () => new Promise(() => undefined) })
  const controller = createDeviceController({
    loadHost: async () => host,
    publish: () => undefined,
    refreshLibraryQueries: () => undefined,
    isVisible: () => true,
  })
  installDeviceSeam(controller)
  t.after(async () => {
    installDeviceSeam(undefined)
    await controller.stop()
  })
  void controller.start()
  const answer = fetchApiData('', countPath, CountSchema)
  await settle()
  assert.equal(calls.length, 0)
  t.mock.timers.tick(START_WAIT_MS)
  await answer
  assert.deepEqual(host.reads, [])
  assert.equal(calls.length, 1)
})

test('an unfilled copy and a feed that is not built leave reads on the API', async (t) => {
  const calls = mockApi(t)
  const host = fakeHost({
    async open(events) {
      host.events = events
      return { kind: 'opened', ready: false, syncedAt: null }
    },
  })
  host.nextSync = async () => ({ outcome: 'feed-not-ready' })
  const { statuses } = await startController(t, host)
  assert.deepEqual(statuses.at(-1), { state: 'waiting-for-feed' })
  await fetchApiData('', countPath, CountSchema)
  assert.deepEqual(host.reads, [])
  assert.equal(calls.length, 1)
})

test('a sync that changes rows refreshes library queries; one after a write does not', async (t) => {
  mockApi(t)
  const host = fakeHost()
  let refreshes = 0
  const { controller } = await startController(t, host, () => {
    refreshes += 1
  })
  host.nextSync = async () => ({ ...synced, rowsApplied: 2 })
  await controller.requestSync('interval')
  assert.equal(refreshes, 1)
  await fetchApiData('', '/api/v1/tags/merge', z.unknown(), {
    method: 'POST',
    body: '{}',
  })
  await settle()
  assert.equal(refreshes, 1)
})

test('Refresh syncs before reloading, and a failed sync sends reads to the API', async (t) => {
  const calls = mockApi(t)
  const host = fakeHost()
  const { controller } = await startController(t, host)
  host.nextSync = async () => ({ outcome: 'failed', message: 'offline' })
  await controller.syncBeforeRefresh()
  assert.equal(host.syncs, 2)
  await fetchApiData('', countPath, CountSchema)
  assert.deepEqual(host.reads, [])
  assert.equal(calls.length, 1)
  host.nextSync = async () => synced
  await controller.syncBeforeRefresh()
  await fetchApiData('', countPath, CountSchema)
  assert.deepEqual(host.reads, [countPath])
})

test('sign-out deletes the copy before navigating and leaves the API in charge', async (t) => {
  browserGlobals(t)
  const host = fakeHost()
  setDeviceStoreSetting('on')
  const stopFollowing = startDeviceStore({
    apiBaseUrl: '',
    client: new QueryClient(),
    loadHost: async () => host,
  })
  await settle()
  assert.ok(deviceSeam())
  const destinations: string[] = []
  await clearSessionData(new QueryClient(), (path) => {
    assert.equal(host.destroyed, 1)
    assert.equal(deviceSeam(), undefined)
    destinations.push(path)
  })
  assert.deepEqual(destinations, ['/login'])
  assert.deepEqual(deviceStoreStatus(), { state: 'signed-out' })
  setDeviceStoreSetting('off')
  stopFollowing()
})
