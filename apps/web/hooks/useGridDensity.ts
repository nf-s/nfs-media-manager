'use client'

import { useSyncExternalStore } from 'react'
import {
  defaultGridDensity,
  nestedGridDensityKey,
  parseGridDensity,
  phoneMediaQuery,
  type GridDensity,
} from '@/utils/media-grid'

function subscribePhone(onChange: () => void) {
  if (typeof window.matchMedia !== 'function') return () => {}
  const query = window.matchMedia(phoneMediaQuery)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

function phoneSnapshot() {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia(phoneMediaQuery).matches
  )
}

/**
 * Whether the window is phone width. The server render and hydration read
 * false; React then re-renders with the real width before the grid has
 * items, so there is no mismatch and no visible change of size.
 */
export function usePhoneWidth() {
  return useSyncExternalStore(subscribePhone, phoneSnapshot, () => false)
}

/** The density `value` names, else compact on phones and standard elsewhere. */
export function useGridDensity(value: string | null | undefined) {
  return parseGridDensity(value, defaultGridDensity(usePhoneWidth()))
}

/*
 * Nested grids keep one density per artwork shape. The toolbar that changes
 * it and the virtual window that measures it can sit in different
 * components, so they share this store and update together.
 */
const listeners = new Set<() => void>()
/** Choices made while browser storage is unavailable, for this page load. */
const unsaved = new Map<string, string>()

function subscribeStored(onChange: () => void) {
  listeners.add(onChange)
  window.addEventListener('storage', onChange)
  return () => {
    listeners.delete(onChange)
    window.removeEventListener('storage', onChange)
  }
}

function readStored(key: string) {
  try {
    return window.localStorage.getItem(key) ?? unsaved.get(key) ?? null
  } catch {
    return unsaved.get(key) ?? null
  }
}

/**
 * The density of a nested grid of `mediaType` artwork and a setter that
 * keeps the choice. `urlValue` (the detail URL's `density`) wins over the
 * stored choice.
 */
export function useNestedGridDensity(
  mediaType: 'album' | 'film' | 'subscription',
  urlValue: string | null = null,
) {
  const key = nestedGridDensityKey(mediaType)
  const stored = useSyncExternalStore(
    subscribeStored,
    () => readStored(key),
    () => null,
  )
  const fallback = parseGridDensity(stored, defaultGridDensity(usePhoneWidth()))
  const density = parseGridDensity(urlValue, fallback)
  function change(next: GridDensity) {
    unsaved.set(key, next)
    try {
      window.localStorage.setItem(key, next)
    } catch {
      // The choice holds for this page load.
    }
    for (const listener of listeners) listener()
  }
  return [density, change] satisfies [GridDensity, (next: GridDensity) => void]
}
