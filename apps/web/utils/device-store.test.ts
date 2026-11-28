import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { QueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import { fetchApiData } from './api'
import { DeviceSnapshotResponseSchema } from '@repo/schemas/device'
import {
  deviceStoreStatusText,
  storeErrorText,
} from '../components/device-store-setting'
import {
  clearDeviceStore,
  enterSignedInPage,
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
import {
  FeedStatusError,
  FeedUnreachableError,
  storeErrorOf,
} from './device-store/errors'
import { StoreErrorSchema, WorkerMessageSchema } from './device-store/protocol'
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

/** Counts the channels opened while the test runs. */
function countChannels(t: TestContext) {
  const opened = { count: 0 }
  const Original = globalThis.BroadcastChannel
  class CountedChannel extends Original {
    constructor(name: string) {
      super(name)
      opened.count += 1
    }
  }
  Object.defineProperty(globalThis, 'BroadcastChannel', {
    configurable: true,
    writable: true,
    value: CountedChannel,
  })
  t.after(() => {
    Object.defineProperty(globalThis, 'BroadcastChannel', {
      configurable: true,
      writable: true,
      value: Original,
    })
  })
  return opened
}

test('with the setting off nothing loads and fetchApiData calls the API as before', async (t) => {
  browserGlobals(t)
  t.after(enterSignedInPage())
  const channels = countChannels(t)
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
  await fetchApiData('', '/api/v1/albums/example', z.unknown(), {
    method: 'PATCH',
    body: '{}',
  })
  stopFollowing()
  assert.equal(loads, 0)
  assert.equal(channels.count, 0)
  assert.deepEqual(calls, [
    { url: countPath, method: 'GET' },
    { url: '/api/v1/albums/example', method: 'PATCH' },
  ])
})

test('turning the setting on loads the host once and turning it off deletes the copy', async (t) => {
  browserGlobals(t)
  t.after(enterSignedInPage())
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
  host.nextSync = async () => ({ outcome: 'failed', error: 'unreachable' })
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
  t.after(enterSignedInPage())
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

test('reads that are not library reads go to the API at page start without waiting for the copy', async (t) => {
  const calls = mockApi(t)
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const host = fakeHost({
    isLibraryRead: () => true,
    open: () => new Promise(() => undefined),
  })
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
  const paths = [
    '/api/v1/jobs/activity',
    '/api/v1/providers/overview',
    '/api/v1/ai/status',
    '/api/v1/spotify/status',
  ]
  const answers = paths.map((path) => fetchApiData('', path, z.unknown()))
  const library = fetchApiData('', countPath, CountSchema)
  await settle()
  assert.deepEqual(
    calls.map(({ url }) => url),
    paths,
  )
  await Promise.all(answers)
  t.mock.timers.tick(START_WAIT_MS)
  await library
  assert.equal(calls.length, 5)
  assert.deepEqual(host.reads, [])
})

/** Waits for messages between channels, which Node delivers on a later turn. */
async function deliver() {
  for (let index = 0; index < 5; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5))
    await settle()
  }
}

/** Turns the setting off and stops following it; registered before `browserGlobals`, whose clean-up runs after it. */
function followSetting(t: TestContext) {
  let stopFollowing: () => void = () => undefined
  t.after(async () => {
    setDeviceStoreSetting('off')
    stopFollowing()
    await settle()
  })
  browserGlobals(t)
  return (stop: () => void) => {
    stopFollowing = stop
  }
}

async function startSignedIn(t: TestContext, host: FakeHost) {
  const follow = followSetting(t)
  t.after(enterSignedInPage())
  setDeviceStoreSetting('on')
  follow(
    startDeviceStore({
      apiBaseUrl: '',
      client: new QueryClient(),
      loadHost: async () => host,
    }),
  )
  await settle()
}

test('a write in another tab holds reads on the API in the tab holding the copy until a sync after it has settled', async (t) => {
  const calls = mockApi(t)
  const host = fakeHost()
  await startSignedIn(t, host)
  assert.deepEqual(await fetchApiData('', countPath, CountSchema), {
    totalCount: 3,
    parsed: true,
  })
  const otherTab = new BroadcastChannel('media-device-store')
  t.after(() => otherTab.close())
  otherTab.postMessage({
    type: 'write-started',
    id: 'other-tab:0',
    path: '/api/v1/films/example',
  })
  await deliver()
  await fetchApiData('', countPath, CountSchema)
  assert.equal(calls.length, 1)
  const syncs = host.syncs
  otherTab.postMessage({ type: 'write-settled', id: 'other-tab:0' })
  // A second settling, or one for a write this tab never saw, changes nothing.
  otherTab.postMessage({ type: 'write-settled', id: 'other-tab:0' })
  otherTab.postMessage({ type: 'write-settled', id: 'unknown' })
  await deliver()
  assert.equal(host.syncs, syncs + 1)
  assert.deepEqual(await fetchApiData('', countPath, CountSchema), {
    totalCount: 3,
    parsed: true,
  })
  assert.equal(calls.length, 1)
})

test('a write through fetchApiData tells the other tabs when it starts and settles', async (t) => {
  mockApi(t)
  await startSignedIn(t, fakeHost())
  const holdingTab = new BroadcastChannel('media-device-store')
  t.after(() => holdingTab.close())
  const messages: unknown[] = []
  holdingTab.addEventListener('message', (event: MessageEvent<unknown>) =>
    messages.push(event.data),
  )
  await fetchApiData('', '/api/v1/films/example', z.unknown(), {
    method: 'PATCH',
    body: '{}',
  })
  await fetchApiData('', '/api/v1/playback/session', z.unknown(), {
    method: 'POST',
    body: '{}',
  })
  await deliver()
  const [started, settled, ...rest] = messages
  assert.deepEqual(rest, [])
  assert.ok(typeof started === 'object' && started !== null && 'id' in started)
  assert.deepEqual(started, {
    type: 'write-started',
    id: started.id,
    path: '/api/v1/films/example',
  })
  assert.deepEqual(settled, { type: 'write-settled', id: started.id })
})

test('a signed-out page does not start the store; a signed-in page starts it without a reload', async (t) => {
  const follow = followSetting(t)
  const host = fakeHost()
  let loads = 0
  setDeviceStoreSetting('on')
  follow(
    startDeviceStore({
      apiBaseUrl: '',
      client: new QueryClient(),
      loadHost: async () => {
        loads += 1
        return host
      },
    }),
  )
  await settle()
  assert.equal(loads, 0)
  assert.equal(deviceSeam(), undefined)
  assert.equal(host.syncs, 0)
  const leave = enterSignedInPage()
  t.after(leave)
  await settle()
  assert.equal(loads, 1)
  assert.ok(deviceSeam())
  assert.equal(deviceStoreStatus().state, 'ready')
  // Leaving the signed-in page, as a remount does, keeps the copy.
  leave()
  await settle()
  assert.ok(deviceSeam())
  assert.equal(host.destroyed, 0)
})

test('rows the client schema rejects end the fill not ready, with no refill until the next page load', async (t) => {
  const calls = mockApi(t)
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const host = fakeHost({
    async open(events) {
      host.events = events
      return { kind: 'opened', ready: false, syncedAt: null }
    },
  })
  host.nextSync = async () => {
    host.events?.progress({ phase: 'snapshot', rows: 500 })
    return { outcome: 'failed', error: 'version-mismatch' }
  }
  const { controller, statuses } = await startController(t, host)
  assert.deepEqual(statuses.at(-1), {
    state: 'error',
    error: 'version-mismatch',
  })
  assert.equal(host.syncs, 1)
  await fetchApiData('', countPath, CountSchema)
  assert.deepEqual(host.reads, [])
  assert.equal(calls.length, 1)
  for (let tick = 0; tick < 20; tick += 1) {
    t.mock.timers.tick(5 * 60_000)
    await settle()
  }
  assert.equal(await controller.requestSync('visible'), false)
  assert.equal(host.syncs, 1)
  // The next page load opens the copy and tries again.
  const next = createDeviceController({
    loadHost: async () => host,
    publish: () => undefined,
    refreshLibraryQueries: () => undefined,
    isVisible: () => true,
  })
  t.after(() => next.stop())
  await next.start()
  await settle()
  assert.equal(host.syncs, 2)
})

test('a ready copy whose change rows the client rejects stops serving', async (t) => {
  const calls = mockApi(t)
  const host = fakeHost()
  const { controller, statuses } = await startController(t, host)
  host.nextSync = async () => ({ outcome: 'failed', error: 'version-mismatch' })
  await controller.requestSync('interval')
  assert.deepEqual(statuses.at(-1), {
    state: 'error',
    error: 'version-mismatch',
  })
  await fetchApiData('', countPath, CountSchema)
  assert.deepEqual(host.reads, [])
  assert.equal(calls.length, 1)
})

test('the state line shows a fixed sentence for each failure, never exception text', () => {
  const sentences = new Set<string>()
  for (const error of StoreErrorSchema.options) {
    const text = deviceStoreStatusText('on', { state: 'error', error })
    assert.equal(
      text,
      `${storeErrorText[error]} Browse pages read from the server.`,
    )
    assert.ok(text.length <= 120, text)
    sentences.add(storeErrorText[error])
    assert.equal(
      deviceStoreStatusText('on', {
        state: 'ready',
        syncedAt: null,
        failed: error,
      }).endsWith(`The last sync failed. ${storeErrorText[error]}`),
      true,
    )
  }
  assert.equal(sentences.size, StoreErrorSchema.options.length)
  // The server may be newer or older than the page: the sentence names neither.
  assert.equal(
    deviceStoreStatusText('on', { state: 'error', error: 'version-mismatch' }),
    "The server's library rows do not match this page's version. Reloading may fix it. Browse pages read from the server.",
  )
  // The Worker cannot send text: a failure carries only its category.
  assert.equal(
    WorkerMessageSchema.safeParse({
      type: 'open-failed',
      unavailable: false,
      error: 'Aborted(both async and sync fetching of the wasm failed)',
    }).success,
    false,
  )
  assert.equal(
    WorkerMessageSchema.safeParse({
      type: 'synced',
      id: 1,
      result: { outcome: 'failed', message: 'QuotaExceededError' },
    }).success,
    false,
  )
})

test('Worker failures are named by category', () => {
  const rejected = DeviceSnapshotResponseSchema.safeParse({
    rows: [{ unexpected: true }],
  })
  assert.ok(!rejected.success)
  assert.equal(storeErrorOf(rejected.error, 'failed'), 'version-mismatch')
  assert.equal(
    storeErrorOf(new DOMException('full', 'QuotaExceededError'), 'failed'),
    'storage-full',
  )
  const sqliteError = (resultCode: number) =>
    Object.assign(new Error('sqlite'), { resultCode })
  assert.equal(storeErrorOf(sqliteError(13), 'failed'), 'storage-full')
  assert.equal(storeErrorOf(sqliteError(11), 'failed'), 'unreadable')
  assert.equal(storeErrorOf(sqliteError(26 | 0x100), 'failed'), 'unreadable')
  assert.equal(
    storeErrorOf(new FeedUnreachableError(), 'failed'),
    'unreachable',
  )
  assert.equal(storeErrorOf(new FeedStatusError(503), 'failed'), 'unreachable')
  assert.equal(storeErrorOf(new FeedStatusError(404), 'failed'), 'failed')
  assert.equal(
    storeErrorOf(new Error('Aborted(wasm)'), 'not-loaded'),
    'not-loaded',
  )
  assert.equal(
    storeErrorOf(
      new DOMException('denied', 'SecurityError'),
      'storage-unavailable',
    ),
    'storage-unavailable',
  )
})
