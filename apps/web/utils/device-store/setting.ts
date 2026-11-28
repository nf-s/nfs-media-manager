import { useSyncExternalStore } from 'react'
import { z } from 'zod'

/** Whether Browse reads use the copy of the library saved in this browser (DEVICE-42). */
export const DeviceStoreSettingSchema = z.enum(['off', 'on'])
export type DeviceStoreSetting = z.infer<typeof DeviceStoreSettingSchema>

const storageKey = 'library:device-store'
const listeners = new Set<() => void>()
let current: DeviceStoreSetting | undefined

function storedSetting(): DeviceStoreSetting {
  try {
    const parsed = DeviceStoreSettingSchema.safeParse(
      window.localStorage.getItem(storageKey),
    )
    return parsed.success ? parsed.data : 'off'
  } catch {
    return 'off'
  }
}

/** The setting in this browser; off by default and on the server. */
export function deviceStoreSetting(): DeviceStoreSetting {
  if (typeof window === 'undefined') return 'off'
  current ??= storedSetting()
  return current
}

export function setDeviceStoreSetting(setting: DeviceStoreSetting) {
  current = setting
  try {
    window.localStorage.setItem(storageKey, setting)
  } catch {
    // The choice still applies in this tab until the page is reloaded.
  }
  for (const listener of [...listeners]) listener()
}

/** Calls `listener` when this tab or another tab changes the setting. */
export function subscribeDeviceStoreSetting(listener: () => void) {
  listeners.add(listener)
  const onStorage = (event: StorageEvent) => {
    if (event.key !== storageKey) return
    current = storedSetting()
    listener()
  }
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', onStorage)
  }
}

export function useDeviceStoreSetting(): DeviceStoreSetting {
  return useSyncExternalStore(
    subscribeDeviceStoreSetting,
    deviceStoreSetting,
    () => 'off',
  )
}
