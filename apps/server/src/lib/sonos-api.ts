import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import type { MediaPluginTestContext } from '@repo/media-plugin-sdk'
import {
  SONOS_SCOPE,
  SonosRoomsSchema,
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
        })
        .optional(),
    })
    .optional(),
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
      const actions = playback.availablePlaybackActions
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
        actions: {
          pause: actions.canPause ?? false,
          play: actions.canPlay ?? false,
          next: actions.canSkip ?? false,
          previous: actions.canSkipBack ?? actions.canSkipToPrevious ?? false,
          seek: actions.canSeek ?? false,
        },
      })
    }
    result.push({ id: household.id, name: household.name ?? null, rooms })
  }
  return SonosRoomsSchema.parse({ households: result })
}
