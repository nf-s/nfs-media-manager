'use client'

import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useSyncExternalStore } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, LoaderCircle, Play, X } from 'lucide-react'
import {
  SonosAccountStatusSchema,
  SonosDisconnectResultSchema,
  SonosRoomsSchema,
  type SonosRoom,
} from '@repo/schemas/sonos'
import { Button } from '@repo/ui/components/ui/button'
import { useConfig } from './providers'
import { usePlayback, type PlaybackView } from './playback-provider'
import { fetchApiData } from '@/utils/api'
import {
  playerPromptDismissed,
  setPlayerPromptDismissed,
  subscribePlayerPrompt,
} from '@/utils/player-prompt'
import { sonosAuthorizationUrl } from '@/utils/sonos-authorize'
import { spotifyAuthorizationUrl } from '@/utils/spotify-authorize'

const STATES = {
  idle: 'Idle',
  buffering: 'Loading',
  paused: 'Paused',
  playing: 'Playing',
} as const
const OUTCOMES: Record<string, { message: string; failed: boolean }> = {
  'spotify-error': {
    message: 'Spotify did not connect. Try again.',
    failed: true,
  },
  'sonos-connected': { message: 'Sonos connected.', failed: false },
  'sonos-error': { message: 'Sonos did not connect. Try again.', failed: true },
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

function roomState(room: SonosRoom, controlled: boolean) {
  const playing = [room.track, room.artist].filter(Boolean).join(' – ')
  return [
    controlled ? 'Controlled here' : room.state ? STATES[room.state] : null,
    room.state === 'idle' ? null : room.service,
    room.state === 'idle' ? null : playing || null,
  ]
    .filter(Boolean)
    .join(' · ')
}

/**
 * The account's Sonos rooms and which one the player controls. Mounted while
 * the device list is open, so each opening reads the rooms once.
 */
export function SonosRooms({ view }: { view: PlaybackView }) {
  const { apiBaseUrl } = useConfig()
  const account = useSonosAccount()
  const rooms = useQuery({
    queryKey: ['sonos-rooms'],
    enabled: account.data?.connected === true,
    staleTime: 0,
    retry: false,
    queryFn: () =>
      fetchApiData(apiBaseUrl, '/api/v1/sonos/rooms', SonosRoomsSchema),
  })
  if (!account.data?.connected) return null
  const { target } = view
  const groups = rooms.data?.households.flatMap(({ rooms }) => rooms) ?? []
  return (
    <section className="device-section" aria-label="Sonos rooms">
      <h3>Sonos rooms</h3>
      {groups.length > 0 && (
        <ul>
          {groups.map((room) => {
            const controlled =
              target.kind === 'sonos' && target.group.id === room.id
            return (
              <li
                key={room.id}
                className="device-room"
                data-current={controlled}
              >
                <SonosMark />
                <span className="device-room-text">
                  <strong>{roomName(room)}</strong>
                  <span>{roomState(room, controlled)}</span>
                </span>
                {controlled && <Check size={14} aria-hidden="true" />}
              </li>
            )
          })}
        </ul>
      )}
      {rooms.isFetching && (
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
      <p className="quiet">
        A room is controlled here once Spotify plays on it. Spotify does not let
        this app start playback on a room, so start it from the Spotify app.
      </p>
    </section>
  )
}

/** Spotify playback and Sonos account connections, with their status. */
export function PlayerConnections() {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const sonos = useSonosAccount()
  const playbackOff = useMutation({
    mutationFn: () => spotifyAuthorizationUrl(apiBaseUrl, { playback: false }),
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
      client.removeQueries({ queryKey: ['sonos-rooms'] })
      await client.invalidateQueries({ queryKey: ['sonos-account'] })
    },
  })
  const status = sonos.data
  const failure = playbackOff.error ?? connect.error ?? disconnect.error
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
            size="sm"
            disabled={playbackOff.isPending}
            onClick={() => playbackOff.mutate()}
          >
            Turn off playback
          </Button>
        </div>
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
              size="sm"
              disabled={disconnect.isPending}
              onClick={() => disconnect.mutate()}
            >
              Disconnect
            </Button>
          )}
          {status?.configured && !status.connected && (
            <Button
              type="button"
              size="sm"
              disabled={connect.isPending}
              onClick={() => connect.mutate()}
            >
              Connect Sonos
            </Button>
          )}
          {status && !status.configured && (
            <Link
              className="underline"
              href="/providers?provider=sonos&section=credentials"
            >
              Add credentials
            </Link>
          )}
        </div>
      </dl>
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
              type="button"
              size="sm"
              disabled={connect.isPending}
              onClick={() => connect.mutate()}
            >
              Connect Spotify
            </Button>
          ) : (
            <Link
              className="underline"
              href="/providers?provider=spotify&mediaType=album&section=credentials"
            >
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
      type="button"
      variant="outline"
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

/** The result of a Spotify or Sonos sign-in that returned to the app. */
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
