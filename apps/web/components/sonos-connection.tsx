'use client'

import { useSearchParams } from 'next/navigation'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  SonosAccountStatusSchema,
  SonosDisconnectResultSchema,
  SonosRoomsSchema,
  type SonosRoom,
} from '@repo/schemas/sonos'
import { Button } from '@repo/ui/components/ui/button'
import { useConfig } from './providers'
import { fetchApiData } from '@/utils/api'
import {
  sonosAuthorizationUrl,
  sonosCallbackUrl,
} from '@/utils/sonos-authorize'

const STATES = {
  idle: 'Idle',
  buffering: 'Loading',
  paused: 'Paused',
  playing: 'Playing',
} as const

function roomName(room: SonosRoom) {
  return room.players.length > 1 ? room.players.join(' + ') : room.name
}

function roomSummary(room: SonosRoom) {
  const playing = [room.track, room.artist].filter(Boolean).join(' – ')
  const controls = (['pause', 'play', 'next', 'previous', 'seek'] as const)
    .filter((action) => room.actions[action])
    .join(', ')
  return [
    room.state ? STATES[room.state] : 'Unknown',
    room.service,
    playing || null,
    controls ? `Controls: ${controls}` : 'No controls accepted',
  ]
    .filter(Boolean)
    .join(' · ')
}

/** Connects a Sonos account and lists its rooms with the controls Sonos accepts. */
export default function SonosConnection() {
  const { apiBaseUrl, appUrl } = useConfig()
  const queryClient = useQueryClient()
  const outcome = useSearchParams().get('sonos')
  const account = useQuery({
    queryKey: ['sonos-account'],
    staleTime: 0,
    queryFn: () =>
      fetchApiData(
        apiBaseUrl,
        '/api/v1/sonos/status',
        SonosAccountStatusSchema,
      ),
  })
  const status = account.data
  const rooms = useQuery({
    queryKey: ['sonos-rooms'],
    enabled: status?.connected === true,
    staleTime: 0,
    retry: false,
    queryFn: () =>
      fetchApiData(apiBaseUrl, '/api/v1/sonos/rooms', SonosRoomsSchema),
  })
  const authorize = useMutation({
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
      queryClient.removeQueries({ queryKey: ['sonos-rooms'] })
      await queryClient.invalidateQueries({ queryKey: ['sonos-account'] })
    },
  })
  const callback = sonosCallbackUrl(apiBaseUrl, appUrl)
  const households = rooms.data?.households ?? []
  return (
    <section className="provider-settings-group">
      <h2>Account</h2>
      <p>Control Spotify playback on Sonos rooms from the player.</p>
      {status && !status.configured && (
        <p className="muted">
          Save the Sonos integration key, secret and redirect URI first.
          {callback
            ? ` Register ${callback} as the redirect URI on the integration key.`
            : ' Sonos requires an HTTPS redirect URI, so connect from the deployed app.'}
        </p>
      )}
      {status?.configured && (
        <div>
          {status.connected ? (
            <Button
              type="button"
              variant="outline"
              disabled={disconnect.isPending}
              onClick={() => disconnect.mutate()}
            >
              Disconnect Sonos
            </Button>
          ) : (
            <Button
              type="button"
              disabled={authorize.isPending}
              onClick={() => authorize.mutate()}
            >
              Connect Sonos
            </Button>
          )}
        </div>
      )}
      {status?.connected && (
        <>
          <h3>Rooms</h3>
          {rooms.isPending && <p className="muted">Loading rooms…</p>}
          {households.map((household) => (
            <dl className="provider-config-grid" key={household.id}>
              {household.rooms.map((room) => (
                <div key={room.id}>
                  <dt>{roomName(room)}</dt>
                  <dd>{roomSummary(room)}</dd>
                </div>
              ))}
            </dl>
          ))}
          {rooms.isSuccess && households.length === 0 && (
            <p className="muted">No Sonos households on this account.</p>
          )}
          {rooms.isError && (
            <p role="alert">
              {rooms.error.message || 'Rooms could not be loaded.'}
            </p>
          )}
          <div>
            <Button
              type="button"
              variant="outline"
              disabled={rooms.isFetching}
              onClick={() => void rooms.refetch()}
            >
              Refresh rooms
            </Button>
          </div>
        </>
      )}
      {account.isError && <p role="alert">Sonos status could not be loaded.</p>}
      {authorize.isError && <p role="alert">{authorize.error.message}</p>}
      {disconnect.isError && <p role="alert">{disconnect.error.message}</p>}
      {outcome === 'connected' && <p role="status">Sonos connected.</p>}
      {outcome === 'error' && (
        <p role="alert">Sonos did not connect. Try again.</p>
      )}
    </section>
  )
}
