import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import type { MediaPluginTestContext } from '@repo/media-plugin-sdk'
import {
  SONOS_SCOPE,
  SonosPlaybackMatchSchema,
  SonosRoomsSchema,
  type SonosCommand,
  type SonosRoom,
  type SonosRooms,
} from '@repo/schemas/sonos'

export type SonosRequest = MediaPluginTestContext['request']

const CONTROL_API = 'https://api.ws.sonos.com/control/api/v1'

const TokenSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().refine((value) => value.toLowerCase() === 'bearer'),
  expires_in: z.number().int().positive(),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().optional(),
})
const HouseholdsSchema = z.object({
  households: z
    .array(z.object({ id: z.string().min(1), name: z.string().optional() }))
    .default([]),
})
const StateSchema = z
  .enum([
    'PLAYBACK_STATE_IDLE',
    'PLAYBACK_STATE_BUFFERING',
    'PLAYBACK_STATE_PAUSED',
    'PLAYBACK_STATE_PLAYING',
  ])
  .optional()
  .catch(undefined)
const GroupsSchema = z.object({
  groups: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string(),
        coordinatorId: z.string(),
        playbackState: StateSchema,
        playerIds: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  players: z
    .array(z.object({ id: z.string().min(1), name: z.string() }))
    .default([]),
})
const PlaybackSchema = z.object({
  playbackState: StateSchema,
  availablePlaybackActions: z
    .object({
      canPlay: z.boolean().optional(),
      canPause: z.boolean().optional(),
      canSkip: z.boolean().optional(),
      canSkipBack: z.boolean().optional(),
      canSkipToPrevious: z.boolean().optional(),
      canSeek: z.boolean().optional(),
    })
    .default({}),
})
const NamedSchema = z.object({ name: z.string().optional() }).optional()
const MetadataSchema = z.object({
  container: z
    .object({ name: z.string().optional(), service: NamedSchema })
    .optional(),
  currentItem: z
    .object({
      track: z
        .object({
          name: z.string().optional(),
          artist: NamedSchema,
          service: NamedSchema,
          id: z.object({ objectId: z.string().optional() }).optional(),
        })
        .optional(),
    })
    .optional(),
})

const VolumeSchema = z.object({
  volume: z.number().int().min(0).max(100),
  fixed: z.boolean().optional(),
})

const STATES = {
  PLAYBACK_STATE_IDLE: 'idle',
  PLAYBACK_STATE_BUFFERING: 'buffering',
  PLAYBACK_STATE_PAUSED: 'paused',
  PLAYBACK_STATE_PLAYING: 'playing',
} as const

/** Sonos only sends its sign-in result to a public HTTPS address. */
export function sonosRedirectUri(value: string): string {
  const url = new URL(value)
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    url.pathname !== '/api/v1/sonos/callback'
  ) {
    throw new Error('Use the exact HTTPS Sonos callback URI')
  }
  return url.toString()
}

export function sonosAuthorization(clientId: string, redirectUri: string) {
  const state = randomBytes(32).toString('base64url')
  const url = new URL('https://api.sonos.com/login/v3/oauth')
  url.search = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    state,
    scope: SONOS_SCOPE,
    redirect_uri: sonosRedirectUri(redirectUri),
  }).toString()
  return { state, url: url.toString() }
}

export async function sonosToken(
  request: SonosRequest,
  client: { clientId: string; clientSecret: string },
  body: URLSearchParams,
) {
  const credentials = Buffer.from(
    `${client.clientId}:${client.clientSecret}`,
  ).toString('base64')
  const response = await request(
    'https://api.sonos.com/login/v3/oauth/access',
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
      },
      body: body.toString(),
    },
  )
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new Error('Sonos returned an invalid token response')
  }
  const parsed = TokenSchema.safeParse(payload)
  if (!parsed.success)
    throw new Error('Sonos returned an invalid token response')
  return parsed.data
}

async function controlJson(
  request: SonosRequest,
  token: string,
  path: string,
): Promise<unknown> {
  const response = await request(`${CONTROL_API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  return response.json()
}

function controls(playback: z.infer<typeof PlaybackSchema>) {
  const actions = playback.availablePlaybackActions
  return {
    pause: actions.canPause ?? false,
    play: actions.canPlay ?? false,
    next: actions.canSkip ?? false,
    previous: actions.canSkipBack ?? actions.canSkipToPrevious ?? false,
    seek: actions.canSeek ?? false,
  }
}

/** The Spotify track URI Sonos reports for a group, e.g. `spotify:track:…`. */
function trackUri(metadata: z.infer<typeof MetadataSchema>) {
  const id = metadata.currentItem?.track?.id?.objectId
  if (!id) return null
  try {
    return decodeURIComponent(id)
  } catch {
    return id
  }
}

/** Each room or group, what it plays and which controls Sonos accepts for it. */
export async function sonosRooms(
  request: SonosRequest,
  token: string,
): Promise<SonosRooms> {
  const { households } = HouseholdsSchema.parse(
    await controlJson(request, token, '/households'),
  )
  const result = []
  for (const household of households) {
    const { groups, players } = GroupsSchema.parse(
      await controlJson(
        request,
        token,
        `/households/${encodeURIComponent(household.id)}/groups`,
      ),
    )
    const names = new Map(players.map((player) => [player.id, player.name]))
    const rooms: SonosRoom[] = []
    for (const group of groups) {
      const path = `/groups/${encodeURIComponent(group.id)}`
      const [playback, metadata] = await Promise.all([
        controlJson(request, token, `${path}/playback`).then((value) =>
          PlaybackSchema.parse(value),
        ),
        controlJson(request, token, `${path}/playbackMetadata`).then((value) =>
          MetadataSchema.parse(value),
        ),
      ])
      const state = playback.playbackState ?? group.playbackState
      const track = metadata.currentItem?.track
      const coordinatorFirst = [
        group.coordinatorId,
        ...group.playerIds.filter((id) => id !== group.coordinatorId),
      ]
      rooms.push({
        id: group.id,
        name: group.name,
        players: coordinatorFirst.flatMap((id) => {
          const name = names.get(id)
          return name === undefined ? [] : [name]
        }),
        state: state ? STATES[state] : null,
        service:
          track?.service?.name ?? metadata.container?.service?.name ?? null,
        track: track?.name ?? null,
        artist: track?.artist?.name ?? null,
        actions: controls(playback),
      })
    }
    result.push({ id: household.id, name: household.name ?? null, rooms })
  }
  return SonosRoomsSchema.parse({ households: result })
}

/**
 * The group playing the given Spotify track. Several households can share a
 * Sonos account, so the track must match and the group name Spotify reports
 * decides between groups playing the same track.
 */
export async function sonosPlaying(
  request: SonosRequest,
  token: string,
  playing: { trackUri: string; device: string },
) {
  const { households } = HouseholdsSchema.parse(
    await controlJson(request, token, '/households'),
  )
  const matches = []
  for (const household of households) {
    const { groups } = GroupsSchema.parse(
      await controlJson(
        request,
        token,
        `/households/${encodeURIComponent(household.id)}/groups`,
      ),
    )
    for (const group of groups) {
      if (group.playbackState === 'PLAYBACK_STATE_IDLE') continue
      const path = `/groups/${encodeURIComponent(group.id)}`
      const metadata = MetadataSchema.parse(
        await controlJson(request, token, `${path}/playbackMetadata`),
      )
      if (trackUri(metadata) === playing.trackUri)
        matches.push({ id: group.id, name: group.name, path })
    }
  }
  const named = matches.filter((match) => match.name === playing.device)
  const match =
    named.length === 1 ? named[0] : matches.length === 1 ? matches[0] : null
  if (!match) return SonosPlaybackMatchSchema.parse({ group: null })
  const [playback, volume] = await Promise.all([
    controlJson(request, token, `${match.path}/playback`).then((value) =>
      PlaybackSchema.parse(value),
    ),
    controlJson(request, token, `${match.path}/groupVolume`).then((value) =>
      VolumeSchema.parse(value),
    ),
  ])
  return SonosPlaybackMatchSchema.parse({
    group: {
      id: match.id,
      name: match.name,
      actions: controls(playback),
      volume: volume.fixed ? null : volume.volume / 100,
    },
  })
}

const COMMANDS = {
  play: 'playback/play',
  pause: 'playback/pause',
  next: 'playback/skipToNextTrack',
  previous: 'playback/skipToPreviousTrack',
  seek: 'playback/seek',
  volume: 'groupVolume',
} as const

/** Sends one transport or volume command to a group. */
export async function sonosCommand(
  request: SonosRequest,
  token: string,
  groupId: string,
  command: SonosCommand,
) {
  const body =
    command.action === 'seek'
      ? { positionMillis: command.positionMs }
      : command.action === 'volume'
        ? { volume: Math.round(command.volume * 100) }
        : {}
  await request(
    `${CONTROL_API}/groups/${encodeURIComponent(groupId)}/${COMMANDS[command.action]}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
  )
}
