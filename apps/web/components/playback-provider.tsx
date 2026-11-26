'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import { LastfmScrobblingStatusSchema } from '@repo/schemas/lastfm'
import {
  SpotifyAccountStatusSchema,
  SpotifyPlaybackTokenSchema,
} from '@repo/schemas/spotify'
import { useConfig } from './providers'
import { fetchApiData } from '@/utils/api'
import {
  createPlaybackEngine,
  idlePlaybackState,
  type PlaybackState,
  type SonosRoomRef,
} from '@/utils/playback-engine'
import { restorePlaybackSource } from '@/utils/playback-source'
import { recordPlaybackCatalog } from '@/utils/playback-catalog'
import {
  createPlaybackDiagnostics,
  type PlaybackEvent,
} from '@/utils/playback-diagnostics'
import {
  createPlaybackSync,
  createSessionApi,
  type PlaybackSync,
} from '@/utils/playback-sync'
import {
  markDriving,
  playerBrowserId,
  playerClientId,
  playerClientName,
  takeDriving,
} from '@/utils/player-client'
import {
  createScrobbleReporter,
  sendScrobbles,
  type ScrobbleReporter,
} from '@/utils/scrobble-reporter'
import { createPlayerApi } from '@/utils/spotify-player-api'
import { createSonosControlApi } from '@/utils/sonos-player-api'
import { loadSpotifySdk } from '@/utils/spotify-sdk'

/** Whether Spotify lets this app play: its credentials are saved and playback access granted. */
export type PlaybackConnection =
  | 'loading'
  | 'unconfigured'
  | 'disconnected'
  | 'connected'
export type PlaybackView = PlaybackState & {
  /** The player is ready. Without it the app only links to Spotify. */
  enabled: boolean
  connection: PlaybackConnection
}
export type PlaybackControls = Pick<
  PlaybackSync,
  | 'activate'
  | 'play'
  | 'enqueue'
  | 'playFromQueue'
  | 'removeFromQueue'
  | 'moveInQueue'
  | 'clearQueue'
  | 'playUpcoming'
  | 'removeUpcoming'
  | 'moveUpcoming'
  | 'queueUpcoming'
  | 'toggleShuffle'
  | 'toggle'
  | 'next'
  | 'previous'
  | 'seek'
  | 'setVolume'
  | 'loadSonosRooms'
  | 'refreshDevices'
  | 'selectDevice'
  | 'clearFailure'
>

const PLAYER_NAME = 'Media Manager'
const VOLUME_KEY = 'player:volume'
const SHUFFLE_KEY = 'player:shuffle'
const ROOM_KEY = 'player:room'
const RoomSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  household: z.string().min(1),
})
const DEFAULT_VOLUME = 0.8
const TOKEN_MARGIN_MS = 60_000

const disabledView: PlaybackView = {
  ...idlePlaybackState,
  enabled: false,
  connection: 'loading',
}
const disabledControls: PlaybackControls = {
  activate: () => undefined,
  play: () => undefined,
  enqueue: () => undefined,
  playFromQueue: () => undefined,
  removeFromQueue: () => undefined,
  moveInQueue: () => undefined,
  clearQueue: () => undefined,
  playUpcoming: () => undefined,
  removeUpcoming: () => undefined,
  moveUpcoming: () => undefined,
  queueUpcoming: () => undefined,
  toggleShuffle: () => undefined,
  toggle: () => undefined,
  next: () => undefined,
  previous: () => undefined,
  seek: () => undefined,
  setVolume: () => undefined,
  loadSonosRooms: () => Promise.reject(new Error('Playback is unavailable.')),
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

/** A local Play button needs an audio element it can unlock within the tap. */
export function usePlaybackForPlayButton(): PlaybackView {
  const view = usePlayback()
  return view.localPlayerLoading && view.target.kind === 'local'
    ? { ...view, enabled: false }
    : view
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

function savedShuffle() {
  try {
    return window.localStorage.getItem(SHUFFLE_KEY) === 'on'
  } catch {
    return false
  }
}

function saveShuffle(shuffle: boolean) {
  try {
    window.localStorage.setItem(SHUFFLE_KEY, shuffle ? 'on' : 'off')
  } catch {
    /* Shuffle still applies when browser storage is unavailable. */
  }
}

/** The Sonos room chosen as the device, so a reload keeps showing it. */
function savedRoom(): SonosRoomRef | null {
  try {
    const parsed = RoomSchema.safeParse(
      JSON.parse(window.localStorage.getItem(ROOM_KEY) ?? 'null'),
    )
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

function saveRoom(room: SonosRoomRef | null) {
  try {
    if (room) window.localStorage.setItem(ROOM_KEY, JSON.stringify(room))
    else window.localStorage.removeItem(ROOM_KEY)
  } catch {
    /* The room still plays when browser storage is unavailable. */
  }
}

/** Whether plays are scrobbled now, and where they are handed in. */
type Scrobbling = { enabled: () => boolean; reporter: ScrobbleReporter }

function createEngine(
  apiBaseUrl: string,
  scrobbling: Scrobbling,
  sonos: ReturnType<typeof createSonosControlApi>,
  recordDiagnostic: (event: PlaybackEvent) => void,
) {
  const seenCatalog = new Set<string>()
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
    recordDiagnostic,
    api: createPlayerApi(token, fetch, (operation, items) => {
      const unique = new Map(
        items.map((item) => [`${operation}:${JSON.stringify(item)}`, item]),
      )
      const pending = [...unique]
        .filter(([key]) => !seenCatalog.has(key))
        .slice(0, 50)
      if (!pending.length) return
      for (const [key] of pending) seenCatalog.add(key)
      while (seenCatalog.size > 500) {
        const oldest = seenCatalog.values().next().value
        if (oldest) seenCatalog.delete(oldest)
      }
      void recordPlaybackCatalog(
        apiBaseUrl,
        operation,
        pending.map(([, item]) => item),
      ).catch(() => {
        for (const [key] of pending) seenCatalog.delete(key)
      })
    }),
    token,
    loadSdk: loadSpotifySdk,
    playerName: PLAYER_NAME,
    initialVolume: savedVolume(),
    onLocalVolume: saveVolume,
    initialShuffle: savedShuffle(),
    onShuffle: saveShuffle,
    visible: () => document.visibilityState === 'visible',
    sonos,
    initialRoom: savedRoom(),
    onRoom: saveRoom,
    browserId: playerBrowserId(),
    restoreSource: (saved) => restorePlaybackSource(apiBaseUrl, saved),
    scrobbles: {
      enabled: scrobbling.enabled,
      report: scrobbling.reporter.report,
    },
  })
}

/** The engine with the account's shared session around it. */
function createPlayer(apiBaseUrl: string, scrobbling: Scrobbling) {
  const clientId = playerClientId()
  const sonos = createSonosControlApi(apiBaseUrl, clientId)
  const diagnostics = createPlaybackDiagnostics(
    apiBaseUrl,
    window.navigator.userAgent,
  )
  const engine = createEngine(apiBaseUrl, scrobbling, sonos, diagnostics.record)
  const sync = createPlaybackSync({
    engine,
    api: createSessionApi(apiBaseUrl),
    clientId,
    readSonosRooms: sonos.rooms,
    clientName: playerClientName(window.navigator.userAgent),
    resuming: takeDriving(Date.now()),
    visible: () => document.visibilityState === 'visible',
  })
  return { engine, sync, diagnostics }
}

/** The Spotify connection and what it may do; shared by everything that asks. */
export function useSpotifyAccount() {
  const { apiBaseUrl } = useConfig()
  return useQuery({
    queryKey: ['spotify-account'],
    queryFn: ({ signal }) =>
      fetchApiData(
        apiBaseUrl,
        '/api/v1/spotify/status',
        SpotifyAccountStatusSchema,
        { signal },
      ),
  })
}

/** The Last.fm sign-in that scrobbles what this app plays on Sonos rooms. */
export function useLastfmScrobbling(enabled = true) {
  const { apiBaseUrl } = useConfig()
  return useQuery({
    queryKey: ['lastfm-scrobbling'],
    enabled,
    queryFn: ({ signal }) =>
      fetchApiData(
        apiBaseUrl,
        '/api/v1/lastfm/scrobbling',
        LastfmScrobblingStatusSchema,
        { signal },
      ),
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
  const account = useSpotifyAccount()
  const enabled = account.data?.playback === true
  const client = useQueryClient()
  const lastfm = useLastfmScrobbling(enabled)
  const scrobbling = useRef(false)
  useEffect(() => {
    scrobbling.current = lastfm.data?.connected === true
  }, [lastfm.data?.connected])
  const [player, setPlayer] = useState<PlaybackSync | null>(null)
  useEffect(() => {
    if (!enabled) return
    const reporter = createScrobbleReporter({
      send: sendScrobbles(apiBaseUrl),
      onDisconnected: () =>
        void client.invalidateQueries({ queryKey: ['lastfm-scrobbling'] }),
    })
    const { engine, sync, diagnostics } = createPlayer(apiBaseUrl, {
      enabled: () => scrobbling.current,
      reporter,
    })
    engine.prepare()
    engine.watch()
    sync.start()
    setPlayer(sync)
    const refresh = () => {
      if (document.visibilityState !== 'visible') {
        diagnostics.flushOnExit()
        return
      }
      engine.refresh()
      sync.refresh()
    }
    const close = () => {
      diagnostics.flushOnExit()
      if (sync.close()) markDriving(Date.now())
    }
    document.addEventListener('visibilitychange', refresh)
    window.addEventListener('pagehide', close)
    return () => {
      document.removeEventListener('visibilitychange', refresh)
      window.removeEventListener('pagehide', close)
      sync.close()
      sync.dispose()
      engine.dispose()
      diagnostics.dispose()
      reporter.dispose()
      setPlayer(null)
    }
  }, [enabled, apiBaseUrl, client])
  const subscribe = useCallback(
    (listener: () => void) =>
      player ? player.subscribe(listener) : noSubscription(),
    [player],
  )
  const state = useSyncExternalStore(
    subscribe,
    player ? player.getState : idleState,
    idleState,
  )
  const status = account.data
  const connection: PlaybackConnection = !status
    ? 'loading'
    : status.playback
      ? 'connected'
      : status.configured
        ? 'disconnected'
        : 'unconfigured'
  const view = useMemo(
    () => ({ ...state, enabled: player !== null, connection }),
    [state, player, connection],
  )
  return (
    <PlaybackControlsContext.Provider value={player ?? disabledControls}>
      <PlaybackViewContext.Provider value={view}>
        {children}
      </PlaybackViewContext.Provider>
    </PlaybackControlsContext.Provider>
  )
}
