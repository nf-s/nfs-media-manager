'use client'

import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useSyncExternalStore } from 'react'
import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { Check, LoaderCircle, Play, X } from 'lucide-react'
import { LastfmDisconnectResultSchema } from '@repo/schemas/lastfm'
import {
  SonosAccountStatusSchema,
  SonosDisconnectResultSchema,
  type SonosRoom,
} from '@repo/schemas/sonos'
import { Button } from '@repo/ui/components/ui/button'
import { useConfig } from './providers'
import {
  useLastfmScrobbling,
  usePlayback,
  usePlaybackControls,
  useSpotifyAccount,
  type PlaybackControls,
  type PlaybackView,
} from './playback-provider'
import { fetchApiData } from '@/utils/api'
import type { SonosRoomRef } from '@/utils/playback-engine'
import {
  playerPromptDismissed,
  setPlayerPromptDismissed,
  subscribePlayerPrompt,
} from '@/utils/player-prompt'
import { lastfmAuthorizationUrl } from '@/utils/scrobble-reporter'
import { sonosAuthorizationUrl } from '@/utils/sonos-authorize'
import { spotifyAuthorizationUrl } from '@/utils/spotify-authorize'

const STATES = {
  idle: 'Idle',
  buffering: 'Loading',
  paused: 'Paused',
  playing: 'Playing',
} as const
const SONOS_ROOMS_KEY = ['sonos-rooms']
const OUTCOMES: Record<string, { message: string; failed: boolean }> = {
  'spotify-error': {
    message: 'Spotify did not connect. Try again.',
    failed: true,
  },
  'sonos-connected': { message: 'Sonos connected.', failed: false },
  'sonos-error': { message: 'Sonos did not connect. Try again.', failed: true },
  'lastfm-connected': { message: 'Last.fm connected.', failed: false },
  'lastfm-error': {
    message: 'Last.fm did not connect. Try again.',
    failed: true,
  },
}

/** Marks a device or room that is reached through the Sonos connection. */
export function SonosMark() {
  return (
    <span className="sonos-mark" aria-hidden="true">
      SONOS
    </span>
  )
}

function useSonosAccount() {
  const { apiBaseUrl } = useConfig()
  return useQuery({
    queryKey: ['sonos-account'],
    queryFn: () =>
      fetchApiData(
        apiBaseUrl,
        '/api/v1/sonos/status',
        SonosAccountStatusSchema,
      ),
  })
}

function roomName(room: SonosRoom) {
  return room.players.length > 1 ? room.players.join(' + ') : room.name
}

function roomState(room: SonosRoom, current: 'chosen' | 'controlled' | null) {
  const playing = [room.track, room.artist].filter(Boolean).join(' – ')
  return [
    current === 'chosen'
      ? 'Playing here'
      : current === 'controlled'
        ? 'Controlled here'
        : room.state
          ? STATES[room.state]
          : null,
    room.state === 'idle' ? null : room.service,
    room.state === 'idle' ? null : playing || null,
  ]
    .filter(Boolean)
    .join(' · ')
}

export function sonosRoomsQuery(
  connected: boolean,
  loadSonosRooms: PlaybackControls['loadSonosRooms'],
) {
  return queryOptions({
    queryKey: SONOS_ROOMS_KEY,
    enabled: connected,
    staleTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: loadSonosRooms,
  })
}

/**
 * The account's Sonos rooms. A room Sonos can start Spotify content on is
 * chosen like a device. An open list requests a refresh through the page
 * driving playback, with the previous rooms kept in view while it refreshes.
 */
export function SonosRooms({
  view,
  onChoose,
}: {
  view: PlaybackView
  onChoose: (room: SonosRoomRef) => void
}) {
  const { loadSonosRooms } = usePlaybackControls()
  const account = useSonosAccount()
  const rooms = useQuery(
    sonosRoomsQuery(account.data?.connected === true, loadSonosRooms),
  )
  if (!account.data?.connected) return null
  const { target } = view
  const groups =
    rooms.data?.households.flatMap((household) =>
      household.rooms.map((room) => ({ room, household: household.id })),
    ) ?? []
  return (
    <section className="device-section" aria-label="Sonos rooms">
      <h3>Sonos rooms</h3>
      {groups.length > 0 && (
        <ul>
          {groups.map(({ room, household }) => {
            const current =
              target.kind === 'room' && target.room.id === room.id
                ? 'chosen'
                : target.kind === 'sonos' && target.group.id === room.id
                  ? 'controlled'
                  : null
            const row = (
              <>
                <SonosMark />
                <span className="device-room-text">
                  <strong>{roomName(room)}</strong>
                  <span>{roomState(room, current)}</span>
                </span>
                {current && <Check size={14} aria-hidden="true" />}
              </>
            )
            return room.playable ? (
              <li key={room.id}>
                <button
                  type="button"
                  className="device-room"
                  aria-pressed={current === 'chosen'}
                  data-current={current !== null}
                  onClick={() =>
                    onChoose({ id: room.id, name: roomName(room), household })
                  }
                >
                  {row}
                </button>
              </li>
            ) : (
              <li
                key={room.id}
                className="device-room"
                data-current={current !== null}
              >
                {row}
              </li>
            )
          })}
        </ul>
      )}
      {rooms.isFetching && groups.length === 0 && (
        <p role="status" className="device-status">
          <LoaderCircle
            size={12}
            aria-hidden="true"
            className="motion-safe:animate-spin"
          />
          Loading Sonos rooms…
        </p>
      )}
      {view.findingSonos && target.kind === 'restricted' && (
        <p role="status" className="device-status">
          <LoaderCircle
            size={12}
            aria-hidden="true"
            className="motion-safe:animate-spin"
          />
          Finding {target.name} on Sonos…
        </p>
      )}
      {rooms.isSuccess && groups.length === 0 && (
        <p className="quiet">No Sonos rooms on this account.</p>
      )}
      {rooms.isError && (
        <p role="alert">
          Sonos rooms could not be loaded.{' '}
          <button
            type="button"
            className="underline"
            onClick={() => void rooms.refetch()}
          >
            Retry
          </button>
        </p>
      )}
      {groups.some(({ room }) => !room.playable) && (
        <p className="quiet">
          A room can be chosen after Spotify has played on it once. Start
          something on it from the Spotify app.
        </p>
      )}
    </section>
  )
}

/** Spotify playback, Sonos and Last.fm scrobbling connections, with their status. */
export function PlayerConnections() {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const sonos = useSonosAccount()
  const spotify = useSpotifyAccount()
  const playbackOff = useMutation({
    mutationFn: () => spotifyAuthorizationUrl(apiBaseUrl, { playback: false }),
    onSuccess: (url) => window.location.assign(url),
  })
  // Asking for playback again adds the play history to the consent.
  const allowHistory = useMutation({
    mutationFn: () => spotifyAuthorizationUrl(apiBaseUrl, { playback: true }),
    onSuccess: (url) => window.location.assign(url),
  })
  const connect = useMutation({
    mutationFn: () => sonosAuthorizationUrl(apiBaseUrl),
    onSuccess: (url) => window.location.assign(url),
  })
  const disconnect = useMutation({
    mutationFn: () =>
      fetchApiData(
        apiBaseUrl,
        '/api/v1/sonos/account',
        SonosDisconnectResultSchema,
        { method: 'DELETE' },
      ),
    onSuccess: async () => {
      client.removeQueries({ queryKey: SONOS_ROOMS_KEY })
      await client.invalidateQueries({ queryKey: ['sonos-account'] })
    },
  })
  const lastfm = useLastfmScrobbling()
  const connectLastfm = useMutation({
    mutationFn: () => lastfmAuthorizationUrl(apiBaseUrl),
    onSuccess: (url) => window.location.assign(url),
  })
  const disconnectLastfm = useMutation({
    mutationFn: () =>
      fetchApiData(
        apiBaseUrl,
        '/api/v1/lastfm/scrobbling/account',
        LastfmDisconnectResultSchema,
        { method: 'DELETE' },
      ),
    onSuccess: () =>
      client.invalidateQueries({ queryKey: ['lastfm-scrobbling'] }),
  })
  const status = sonos.data
  const scrobbling = lastfm.data
  const withoutHistory =
    spotify.data?.playback === true && !spotify.data.playbackHistory
  const failure =
    playbackOff.error ??
    allowHistory.error ??
    connect.error ??
    disconnect.error ??
    connectLastfm.error ??
    disconnectLastfm.error
  return (
    <section className="device-section" aria-label="Connections">
      <h3>Connections</h3>
      <dl className="player-connections">
        <div>
          <dt>Spotify</dt>
          <dd>Connected</dd>
          <Button
            type="button"
            variant="ghost"
            disabled={playbackOff.isPending}
            onClick={() => playbackOff.mutate()}
          >
            Turn off playback
          </Button>
        </div>
        {withoutHistory && (
          <div>
            <dt>Play history</dt>
            <dd>Not allowed</dd>
            <Button
              variant="primary"
              type="button"
              disabled={allowHistory.isPending}
              onClick={() => allowHistory.mutate()}
            >
              Allow
            </Button>
          </div>
        )}
        <div>
          <dt>Sonos</dt>
          <dd>
            {sonos.isPending
              ? 'Checking…'
              : !status
                ? 'Status unavailable'
                : status.connected
                  ? 'Connected'
                  : status.configured
                    ? 'Not connected'
                    : 'Not set up'}
          </dd>
          {status?.connected && (
            <Button
              type="button"
              variant="ghost"
              disabled={disconnect.isPending}
              onClick={() => disconnect.mutate()}
            >
              Disconnect
            </Button>
          )}
          {status?.configured && !status.connected && (
            <Button
              variant="primary"
              type="button"
              disabled={connect.isPending}
              onClick={() => connect.mutate()}
            >
              Connect Sonos
            </Button>
          )}
          {status && !status.configured && (
            <Link className="underline" href="/providers/sonos?tab=settings">
              Add credentials
            </Link>
          )}
        </div>
        <div>
          <dt>Last.fm</dt>
          <dd>
            {lastfm.isPending
              ? 'Checking…'
              : !scrobbling
                ? 'Status unavailable'
                : scrobbling.connected
                  ? 'Connected'
                  : scrobbling.configured
                    ? 'Not connected'
                    : 'Not set up'}
          </dd>
          {scrobbling?.connected && (
            <Button
              type="button"
              variant="ghost"
              disabled={disconnectLastfm.isPending}
              onClick={() => disconnectLastfm.mutate()}
            >
              Disconnect
            </Button>
          )}
          {scrobbling?.configured && !scrobbling.connected && (
            <Button
              variant="primary"
              type="button"
              disabled={connectLastfm.isPending}
              onClick={() => connectLastfm.mutate()}
            >
              Connect Last.fm
            </Button>
          )}
          {scrobbling && !scrobbling.configured && (
            <Link className="underline" href="/providers/lastfm?tab=settings">
              Add credentials
            </Link>
          )}
        </div>
      </dl>
      {scrobbling && (
        <p className="quiet">
          {scrobbling.connected
            ? `Tracks played on Sonos rooms from here are scrobbled${
                scrobbling.account ? ` to ${scrobbling.account}` : ''
              }.`
            : 'With Last.fm connected, tracks played on Sonos rooms from here are scrobbled.'}
        </p>
      )}
      {withoutHistory && (
        <p className="quiet">
          With play history, the queue moves on past what Spotify played while
          this app was closed.
        </p>
      )}
      {failure && <p role="alert">{failure.message}</p>}
    </section>
  )
}

/** Shown in place of the player until Spotify playback is connected. */
export function ConnectPrompt({ configured }: { configured: boolean }) {
  const { apiBaseUrl } = useConfig()
  const dismissed = useSyncExternalStore(
    subscribePlayerPrompt,
    playerPromptDismissed,
    () => false,
  )
  const connect = useMutation({
    mutationFn: () => spotifyAuthorizationUrl(apiBaseUrl, { playback: true }),
    onSuccess: (url) => window.location.assign(url),
  })
  if (dismissed) return null
  return (
    <section className="player-dock" aria-label="Player">
      <ConnectionOutcome />
      {connect.isError && (
        <div className="player-alert" role="alert">
          <span>{connect.error.message}</span>
        </div>
      )}
      <div className="player-row" data-state="prompt">
        <div className="player-now">
          <span className="player-text">
            <strong>Spotify playback is not connected</strong>
            <span>
              {configured
                ? 'Connect to play albums and tracks here. Requires Spotify Premium.'
                : 'Save Spotify credentials in Providers, then connect here.'}
            </span>
          </span>
        </div>
        <div className="player-tools">
          {configured ? (
            <Button
              variant="primary"
              type="button"
              disabled={connect.isPending}
              onClick={() => connect.mutate()}
            >
              Connect Spotify
            </Button>
          ) : (
            <Link className="underline" href="/providers/spotify?tab=settings">
              Spotify credentials
            </Link>
          )}
          <button
            type="button"
            className="player-tool"
            aria-label="Dismiss"
            title="Dismiss"
            onClick={() => setPlayerPromptDismissed(true)}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      </div>
    </section>
  )
}

/** Brings back a dismissed prompt to connect Spotify playback. */
export function PlayerPromptRestore() {
  const { connection } = usePlayback()
  const dismissed = useSyncExternalStore(
    subscribePlayerPrompt,
    playerPromptDismissed,
    () => false,
  )
  if (connection === 'loading' || connection === 'connected' || !dismissed)
    return null
  return (
    <Button
      size="md"
      type="button"
      className="gap-1.5"
      aria-label="Show player"
      title="Show player"
      onClick={() => setPlayerPromptDismissed(false)}
    >
      <Play size={14} aria-hidden="true" />
      <span className="hidden min-[701px]:inline">Player</span>
    </Button>
  )
}

/** The result of a Spotify, Sonos or Last.fm sign-in that returned to the app. */
export function ConnectionOutcome() {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const outcome = OUTCOMES[params.get('player') ?? '']
  if (!outcome) return null
  const rest = new URLSearchParams(params)
  rest.delete('player')
  return (
    <div
      className="player-alert"
      role={outcome.failed ? 'alert' : 'status'}
      data-tone={outcome.failed ? 'error' : 'info'}
    >
      <span>{outcome.message}</span>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() =>
          router.replace(rest.size ? `${pathname}?${rest}` : pathname)
        }
      >
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  )
}
