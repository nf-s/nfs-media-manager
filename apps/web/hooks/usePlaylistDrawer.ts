'use client'

import { useEffect, useRef } from 'react'
import { useSearchParams } from 'next/navigation'
import {
  parsePlaylistTab,
  playlistDrawerParams,
  type PlaylistTab,
} from '@/utils/playlist-links'

type Updates = Record<string, string | null>

function updateUrl(updates: Updates, push: boolean) {
  const params = new URLSearchParams(window.location.search)
  for (const [key, value] of Object.entries(updates)) {
    if (value === null) params.delete(key)
    else params.set(key, value)
  }
  const url = `${window.location.pathname}${params.size ? `?${params}` : ''}`
  if (push) window.history.pushState(null, '', url)
  else window.history.replaceState(null, '', url)
}

/**
 * The playlist drawer's state in the `playlist` and `tab` URL parameters, so
 * back, forward and reload keep it. Opening adds a history entry; closing a
 * drawer opened here goes back to it, as the track drawer does.
 */
export function usePlaylistDrawer({
  replaces = [],
  parameter = 'playlist',
}: {
  /** Parameters of another drawer that opening this one closes. */
  replaces?: string[]
  parameter?: 'playlist' | 'collection'
} = {}) {
  const searchParams = useSearchParams()
  const playlistId = searchParams.get(parameter)
  const tab = parsePlaylistTab(searchParams.get('tab'))
  const openedHere = useRef(false)
  const trigger = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!playlistId && trigger.current?.isConnected)
      trigger.current.focus({ preventScroll: true })
  }, [playlistId])

  return {
    playlistId,
    tab,
    open(id: string, opener?: HTMLElement) {
      trigger.current = opener ?? null
      openedHere.current = true
      const closed: Updates = {}
      for (const key of replaces) closed[key] = null
      updateUrl(
        {
          ...closed,
          ...(parameter === 'playlist'
            ? playlistDrawerParams(id)
            : { [parameter]: id, tab: null }),
        },
        true,
      )
    },
    close() {
      if (openedHere.current) {
        openedHere.current = false
        window.history.back()
      } else updateUrl({ [parameter]: null, tab: null }, false)
    },
    setTab(next: PlaylistTab) {
      updateUrl({ tab: next === 'tracks' ? null : next }, false)
    },
    /** Call when the URL leaves the drawer another way, so closing does not go back. */
    forget() {
      openedHere.current = false
    },
  }
}
