import type { QueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import {
  createDeviceController,
  type DeviceController,
  type DeviceStoreHost,
} from './controller'
import { installDeviceSeam, type DeviceSeam } from './seam'
import { deviceStoreSetting, subscribeDeviceStoreSetting } from './setting'
import { publishDeviceStoreStatus, type DeviceStoreStatus } from './status'

/**
 * Starts the device store while the setting is on and a signed-in page is
 * mounted, and stops it, deleting the copy, when the setting is turned off
 * here or in another tab. With the setting off nothing is loaded: no Worker,
 * no WebAssembly, no request, no channel.
 */

/** Query keys whose reads the copy can answer; a sync that changed rows refreshes the mounted ones. */
const libraryQueryPrefixes = [
  'tracks',
  'albums',
  'films',
  'artists',
  'playlists',
  'listening-histogram',
]
/** Sign-out waits at most this long for the copy to be deleted. */
const SIGN_OUT_WAIT_MS = 3_000
/** A write another tab announced but never settled (the tab closed) stops holding reads after this. */
export const REMOTE_WRITE_LIMIT_MS = 2 * 60_000
const channelName = 'media-device-store'
const signedOutMessage = 'signed-out'

/**
 * Messages between this browser's tabs: sign-out, and each write's start and
 * settling, so the tab holding the copy holds reads on the API for writes
 * made in any tab (DEVICE-43).
 */
const ChannelMessageSchema = z.union([
  z.literal(signedOutMessage),
  z.object({
    type: z.literal('write-started'),
    id: z.string(),
    path: z.string(),
  }),
  z.object({ type: z.literal('write-settled'), id: z.string() }),
])
type ChannelMessage = z.infer<typeof ChannelMessageSchema>

export type DeviceStoreOptions = {
  apiBaseUrl: string
  client: QueryClient
  /** The Worker host, loaded on first use; tests give a fake. */
  loadHost?: (apiBaseUrl: string) => Promise<DeviceStoreHost>
}

type Running = {
  controller: DeviceController
  detach: () => void
}

let running: Running | undefined
let signedInPages = 0
const sessionListeners = new Set<() => void>()
/** Names this tab's writes on the channel. */
const tabId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
let nextWrite = 0

function loadWorkerHost(apiBaseUrl: string) {
  return import('./host').then((module) => module.createWorkerHost(apiBaseUrl))
}

function refreshLibraryQueries(client: QueryClient) {
  for (const prefix of libraryQueryPrefixes)
    void client.invalidateQueries({ queryKey: [prefix] })
}

function begin({
  apiBaseUrl,
  client,
  loadHost = loadWorkerHost,
}: DeviceStoreOptions) {
  if (running && !running.controller.isStopped()) return
  const controller = createDeviceController({
    loadHost: () => loadHost(apiBaseUrl),
    publish: publishDeviceStoreStatus,
    refreshLibraryQueries: () => refreshLibraryQueries(client),
    isVisible: () => document.visibilityState === 'visible',
  })
  const onVisible = () => {
    if (document.visibilityState === 'visible')
      void controller.requestSync('visible')
  }
  const onOnline = () => void controller.requestSync('online')
  document.addEventListener('visibilitychange', onVisible)
  window.addEventListener('online', onOnline)
  const channel =
    typeof BroadcastChannel === 'function'
      ? new BroadcastChannel(channelName)
      : undefined
  const post = (message: ChannelMessage) => channel?.postMessage(message)
  const otherWrites = new Map<
    string,
    { settle: () => void; timer: ReturnType<typeof setTimeout> }
  >()
  const settleOther = (id: string) => {
    const write = otherWrites.get(id)
    if (!write) return
    otherWrites.delete(id)
    clearTimeout(write.timer)
    write.settle()
  }
  channel?.addEventListener('message', (event: MessageEvent<unknown>) => {
    const parsed = ChannelMessageSchema.safeParse(event.data)
    if (!parsed.success) return
    const message = parsed.data
    if (message === signedOutMessage) {
      void end({ state: 'signed-out' })
      return
    }
    if (message.type === 'write-settled') {
      settleOther(message.id)
      return
    }
    if (otherWrites.has(message.id)) return
    otherWrites.set(message.id, {
      settle: controller.beginWrite(message.path),
      timer: setTimeout(() => settleOther(message.id), REMOTE_WRITE_LIMIT_MS),
    })
  })
  const seam: DeviceSeam = {
    read: (path, signal) => controller.read(path, signal),
    beginWrite(path) {
      const settle = controller.beginWrite(path)
      const id = `${tabId}:${nextWrite++}`
      let settled = false
      post({ type: 'write-started', id, path })
      return () => {
        if (settled) return
        settled = true
        settle()
        post({ type: 'write-settled', id })
      }
    },
    unauthorized: () => controller.unauthorized(),
  }
  running = {
    controller,
    detach() {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('online', onOnline)
      for (const { timer } of otherWrites.values()) clearTimeout(timer)
      otherWrites.clear()
      channel?.close()
    },
  }
  installDeviceSeam(seam)
  void controller.start()
}

async function end(status?: DeviceStoreStatus) {
  const current = running
  if (!current) return
  running = undefined
  installDeviceSeam(undefined)
  current.detach()
  await current.controller.stop(status)
  // A controller that a 401 had already stopped publishes nothing more.
  publishDeviceStoreStatus(status ?? { state: 'off' })
}

/**
 * A page behind the session check is mounted: the store may start. Signed-out
 * pages never mount one, so they load no store code and send no feed request.
 * The returned function leaves the page; that does not stop the store, which
 * sign-out and a 401 stop.
 */
export function enterSignedInPage(): () => void {
  signedInPages += 1
  for (const listener of [...sessionListeners]) listener()
  let left = false
  return () => {
    if (left) return
    left = true
    signedInPages -= 1
  }
}

/**
 * Follows the setting for the life of the page. The returned function stops
 * following it and leaves the store running, so a remount does not delete
 * the copy.
 */
export function startDeviceStore(options: DeviceStoreOptions): () => void {
  if (typeof window === 'undefined') return () => undefined
  const apply = () => {
    if (deviceStoreSetting() !== 'on') void end()
    else if (signedInPages > 0) begin(options)
  }
  apply()
  sessionListeners.add(apply)
  const stopFollowing = subscribeDeviceStoreSetting(apply)
  return () => {
    sessionListeners.delete(apply)
    stopFollowing()
  }
}

/**
 * Sign-out (DEVICE-45): deletes the copy held by this tab and tells the tab
 * holding it to delete it, before the page navigates.
 */
export async function clearDeviceStore(): Promise<void> {
  if (typeof window === 'undefined' || deviceStoreSetting() !== 'on') return
  if (typeof BroadcastChannel === 'function') {
    const channel = new BroadcastChannel(channelName)
    channel.postMessage(signedOutMessage)
    channel.close()
  }
  await Promise.race([
    end({ state: 'signed-out' }),
    new Promise<void>((resolve) => setTimeout(resolve, SIGN_OUT_WAIT_MS)),
  ])
}

/** Refresh: brings the copy up to date before mounted reads refetch; nothing while the store is off. */
export function syncDeviceStoreBeforeRefresh(): Promise<void> | undefined {
  return running?.controller.syncBeforeRefresh()
}

export function retryDeviceStore() {
  running?.controller.retry()
}
