'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  SpotifyAccountStatusSchema,
  SpotifyPlaybackTokenSchema,
} from '@repo/schemas/spotify'
import { useConfig } from './providers'
import { fetchApiData } from '@/utils/api'
import {
  createPlaybackEngine,
  idlePlaybackState,
  type PlaybackEngine,
  type PlaybackState,
} from '@/utils/playback-engine'
import { createPlayerApi } from '@/utils/spotify-player-api'
import { loadSpotifySdk } from '@/utils/spotify-sdk'

export type PlaybackView = PlaybackState & {
  /** Playback is connected in Providers. Without it the app only links to Spotify. */
  enabled: boolean
}
export type PlaybackControls = Pick<
  PlaybackEngine,
  | 'play'
  | 'enqueue'
  | 'playFromQueue'
  | 'removeFromQueue'
  | 'moveInQueue'
  | 'clearQueue'
  | 'toggle'
  | 'next'
  | 'previous'
  | 'seek'
  | 'setVolume'
  | 'refreshDevices'
  | 'selectDevice'
  | 'clearFailure'
>

const PLAYER_NAME = 'Media Manager'
const VOLUME_KEY = 'player:volume'
const DEFAULT_VOLUME = 0.8
const TOKEN_MARGIN_MS = 60_000

const disabledView: PlaybackView = { ...idlePlaybackState, enabled: false }
const disabledControls: PlaybackControls = {
  play: () => undefined,
  enqueue: () => undefined,
  playFromQueue: () => undefined,
  removeFromQueue: () => undefined,
  moveInQueue: () => undefined,
  clearQueue: () => undefined,
  toggle: () => undefined,
  next: () => undefined,
  previous: () => undefined,
  seek: () => undefined,
  setVolume: () => undefined,
  refreshDevices: async () => undefined,
  selectDevice: async () => undefined,
  clearFailure: () => undefined,
}

export const PlaybackViewContext = createContext<PlaybackView>(disabledView)
export const PlaybackControlsContext =
  createContext<PlaybackControls>(disabledControls)

/** What is playing and queued. Outside the provider, playback reads as off. */
export function usePlayback() {
  return useContext(PlaybackViewContext)
}

export function usePlaybackControls() {
  return useContext(PlaybackControlsContext)
}

function savedVolume() {
  try {
    const value = Number.parseFloat(
      window.localStorage.getItem(VOLUME_KEY) ?? '',
    )
    return value >= 0 && value <= 1 ? value : DEFAULT_VOLUME
  } catch {
    return DEFAULT_VOLUME
  }
}

function saveVolume(volume: number) {
  try {
    window.localStorage.setItem(VOLUME_KEY, String(volume))
  } catch {
    /* The volume still applies when browser storage is unavailable. */
  }
}

function createEngine(apiBaseUrl: string) {
  // The access token is held in memory only and never written to storage.
  let cached: { accessToken: string; expiresAt: number } | null = null
  let pending: Promise<string> | null = null
  function token(refresh = false) {
    if (!refresh && cached && cached.expiresAt - Date.now() > TOKEN_MARGIN_MS)
      return Promise.resolve(cached.accessToken)
    pending ??= fetchApiData(
      apiBaseUrl,
      '/api/v1/spotify/playback/token',
      SpotifyPlaybackTokenSchema,
      { method: 'POST' },
    )
      .then((result) => {
        cached = {
          accessToken: result.accessToken,
          expiresAt: Date.parse(result.expiresAt),
        }
        return result.accessToken
      })
      .finally(() => {
        pending = null
      })
    return pending
  }
  return createPlaybackEngine({
    api: createPlayerApi(token),
    token,
    loadSdk: loadSpotifySdk,
    playerName: PLAYER_NAME,
    initialVolume: savedVolume(),
    onLocalVolume: saveVolume,
    visible: () => document.visibilityState === 'visible',
  })
}

const noSubscription = () => () => undefined
const idleState = () => idlePlaybackState

export default function PlaybackProvider({
  children,
}: {
  children: React.ReactNode
}) {
  const { apiBaseUrl } = useConfig()
  const account = useQuery({
    queryKey: ['spotify-account'],
    queryFn: () =>
      fetchApiData(
        apiBaseUrl,
        '/api/v1/spotify/status',
        SpotifyAccountStatusSchema,
      ),
  })
  const enabled = account.data?.playback === true
  const [engine, setEngine] = useState<PlaybackEngine | null>(null)
  useEffect(() => {
    if (!enabled) return
    const created = createEngine(apiBaseUrl)
    created.prepare()
    created.watch()
    setEngine(created)
    const refresh = () => {
      if (document.visibilityState === 'visible') created.refresh()
    }
    document.addEventListener('visibilitychange', refresh)
    return () => {
      document.removeEventListener('visibilitychange', refresh)
      created.dispose()
      setEngine(null)
    }
  }, [enabled, apiBaseUrl])
  const subscribe = useCallback(
    (listener: () => void) =>
      engine ? engine.subscribe(listener) : noSubscription(),
    [engine],
  )
  const state = useSyncExternalStore(
    subscribe,
    engine ? engine.getState : idleState,
    idleState,
  )
  const view = useMemo(
    () => ({ ...state, enabled: engine !== null }),
    [state, engine],
  )
  return (
    <PlaybackControlsContext.Provider value={engine ?? disabledControls}>
      <PlaybackViewContext.Provider value={view}>
        {children}
      </PlaybackViewContext.Provider>
    </PlaybackControlsContext.Provider>
  )
}
