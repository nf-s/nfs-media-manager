'use client'

import { useSyncExternalStore } from 'react'

export const railSlotId = 'rail-section'
const railQuery = '(min-width: 701px)'

function subscribe(notify: () => void) {
  const media = window.matchMedia(railQuery)
  media.addEventListener('change', notify)
  return () => media.removeEventListener('change', notify)
}

function railSlot() {
  return window.matchMedia(railQuery).matches
    ? document.getElementById(railSlotId)
    : null
}

/** The navigation rail's section area, when the rail is shown beside the page. */
export function useRailSlot() {
  return useSyncExternalStore(subscribe, railSlot, () => null)
}
