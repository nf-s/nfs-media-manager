import type { QueryClient } from '@tanstack/react-query'
import {
  createDeviceController,
  type DeviceController,
  type DeviceStoreHost,
} from './controller'
import { installDeviceSeam } from './seam'
import { deviceStoreSetting, subscribeDeviceStoreSetting } from './setting'
import { publishDeviceStoreStatus, type DeviceStoreStatus } from './status'

/**
 * Starts the device store while the setting is on and stops it, deleting the
 * copy, when the setting is turned off here or in another tab. With the
 * setting off nothing is loaded: no Worker, no WebAssembly, no request.
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
const channelName = 'media-device-store'
const signedOutMessage = 'signed-out'

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
  channel?.addEventListener('message', (event: MessageEvent<unknown>) => {
    if (event.data === signedOutMessage) void end({ state: 'signed-out' })
  })
  running = {
    controller,
    detach() {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('online', onOnline)
      channel?.close()
    },
  }
  installDeviceSeam(controller)
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
 * Follows the setting for the life of the page. The returned function stops
 * following it and leaves the store running, so a remount does not delete
 * the copy.
 */
export function startDeviceStore(options: DeviceStoreOptions): () => void {
  if (typeof window === 'undefined') return () => undefined
  const apply = () => {
    if (deviceStoreSetting() === 'on') begin(options)
    else void end()
  }
  apply()
  return subscribeDeviceStoreSetting(apply)
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
