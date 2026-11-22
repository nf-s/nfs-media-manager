import { useSyncExternalStore } from 'react'
import {
  defaultKeyNotation,
  keyDisplayNotation,
  KeyNotationSchema,
  setKeyDisplayNotation,
  type KeyNotation,
} from '@repo/schemas/musical-keys'

const storageKey = 'display:key-notation'
const listeners = new Set<() => void>()

function storedKeyNotation(): KeyNotation {
  try {
    const parsed = KeyNotationSchema.safeParse(
      window.localStorage.getItem(storageKey),
    )
    return parsed.success ? parsed.data : defaultKeyNotation
  } catch {
    return defaultKeyNotation
  }
}

/** Apply the notation saved in this browser before Browse formats any key. */
export function initializeKeyNotation() {
  if (typeof window === 'undefined') return
  setKeyDisplayNotation(storedKeyNotation())
}

export function setKeyNotation(notation: KeyNotation) {
  setKeyDisplayNotation(notation)
  try {
    window.localStorage.setItem(storageKey, notation)
  } catch {
    // The choice still applies until the page is reloaded.
  }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  const onStorage = (event: StorageEvent) => {
    if (event.key !== storageKey) return
    setKeyDisplayNotation(storedKeyNotation())
    listener()
  }
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', onStorage)
  }
}

/** The key notation chosen in this browser. */
export function useKeyNotation(): KeyNotation {
  return useSyncExternalStore(
    subscribe,
    keyDisplayNotation,
    () => defaultKeyNotation,
  )
}
