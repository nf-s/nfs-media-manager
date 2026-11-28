import { useSyncExternalStore } from 'react'

/** What the setting shows about the copy in this tab (DEVICE-42). */
export type DeviceStoreStatus =
  | { state: 'off' }
  /** The Worker is starting or the copy is opening. */
  | { state: 'starting' }
  /** No Worker, OPFS, Web Locks or WebAssembly in this browser. */
  | { state: 'unavailable' }
  /** Another tab holds the copy; this tab reads from the server. */
  | { state: 'other-tab' }
  /** The server has not finished building its feed. */
  | { state: 'waiting-for-feed' }
  | { state: 'filling'; rows: number }
  | { state: 'ready'; syncedAt: number | null; failed?: string }
  | { state: 'error'; message: string }
  /** The session ended and the copy was deleted. */
  | { state: 'signed-out' }

const listeners = new Set<() => void>()
const off: DeviceStoreStatus = { state: 'off' }
let current: DeviceStoreStatus = off

export function deviceStoreStatus(): DeviceStoreStatus {
  return current
}

export function publishDeviceStoreStatus(status: DeviceStoreStatus) {
  current = status
  for (const listener of [...listeners]) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useDeviceStoreStatus(): DeviceStoreStatus {
  return useSyncExternalStore(subscribe, deviceStoreStatus, () => off)
}
