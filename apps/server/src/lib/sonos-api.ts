import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import type { MediaPluginTestContext } from '@repo/media-plugin-sdk'
import {
  SONOS_SCOPE,
  SonosGroupStateSchema,
  SonosPlaybackMatchSchema,
  SonosRoomsSchema,
  type SonosCommand,
  type SonosContentInput,
  type SonosGroupState,
  type SonosRoom,
  type SonosRooms,
} from '@repo/schemas/sonos'

export type SonosRequest = MediaPluginTestContext['request']

export const SONOS_CONTROL_API = 'https://api.ws.sonos.com/control/api/v1'
export const SONOS_TOKEN_API = 'https://api.sonos.com/login/v3/oauth/access'

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
  positionMillis: z.number().optional(),
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
const ObjectIdSchema = z
  .object({
    serviceId: z.string().optional(),
    objectId: z.string().optional(),
    accountId: z.string().optional(),
  })
  .optional()
const MetadataSchema = z.object({
  container: z
    .object({
      name: z.string().optional(),
      service: NamedSchema,
      id: ObjectIdSchema,
    })
    .optional(),
  currentItem: z
    .object({
      track: z
        .object({
          name: z.string().optional(),
          artist: NamedSchema,
          album: NamedSchema,
          service: NamedSchema,
          imageUrl: z.string().optional(),
          durationMillis: z.number().optional(),
          id: ObjectIdSchema,
        })
        .optional(),
    })
    .optional(),
  nextItem: z.unknown().optional(),
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
  const response = await request(SONOS_TOKEN_API, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
    },
    body: body.toString(),
  })
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
  const response = await request(`${SONOS_CONTROL_API}${path}`, {
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

/** A music service object id as Sonos reports it, which may be URL-encoded. */
function decodedId(id: string | undefined) {
  if (!id) return null
  try {
    return decodeURIComponent(id)
  } catch {
    return id
  }
}

/** The Spotify track URI Sonos reports for a group, e.g. `spotify:track:…`. */
function trackUri(metadata: z.infer<typeof MetadataSchema>) {
  return decodedId(metadata.currentItem?.track?.id?.objectId)
}

/** The Sonos music service account a household plays Spotify with. */
export type SonosSpotifyAccount = { serviceId: string; accountId: string }
export type SonosObservedAccount = SonosSpotifyAccount & { household: string }
/** A Control API read with the Spotify accounts it saw along the way. */
export type SonosObserved<T> = {
  result: T
  accounts: SonosObservedAccount[]
}

/** The Spotify account in a group's metadata, when it plays or has loaded Spotify. */
function spotifyAccount(
  metadata: z.infer<typeof MetadataSchema>,
): SonosSpotifyAccount | null {
  for (const id of [metadata.currentItem?.track?.id, metadata.container?.id]) {
    if (
      id?.serviceId &&
      id.accountId &&
      decodedId(id.objectId)?.startsWith('spotify:')
    )
      return { serviceId: id.serviceId, accountId: id.accountId }
  }
  return null
}

/** Each household's groups, read in parallel and kept in Sonos's order. */
async function householdGroups(request: SonosRequest, token: string) {
  const { households } = HouseholdsSchema.parse(
    await controlJson(request, token, '/households'),
  )
  return Promise.all(
    households.map(async (household) => ({
      household,
      ...GroupsSchema.parse(
        await controlJson(
          request,
          token,
          `/households/${encodeURIComponent(household.id)}/groups`,
        ),
      ),
    })),
  )
}

/** The single item in a list, or null when there are none or several. */
function only<T>(items: T[]): T | null {
  return items.length === 1 ? (items[0] ?? null) : null
}

/**
 * Each room or group, what it plays and which controls Sonos accepts for it.
 * `known` lists the households whose Spotify account was seen before.
 */
export async function sonosRooms(
  request: SonosRequest,
  token: string,
  known: ReadonlySet<string>,
): Promise<SonosObserved<SonosRooms>> {
  const accounts: SonosObservedAccount[] = []
  const result = await Promise.all(
    (await householdGroups(request, token)).map(
      async ({ household, groups, players }) => {
        const names = new Map(players.map((player) => [player.id, player.name]))
        const read = await Promise.all(
          groups.map(async (group): Promise<Omit<SonosRoom, 'playable'>> => {
            const path = `/groups/${encodeURIComponent(group.id)}`
            const [playback, metadata] = await Promise.all([
              controlJson(request, token, `${path}/playback`).then((value) =>
                PlaybackSchema.parse(value),
              ),
              controlJson(request, token, `${path}/playbackMetadata`).then(
                (value) => MetadataSchema.parse(value),
              ),
            ])
            const account = spotifyAccount(metadata)
            if (account) accounts.push({ household: household.id, ...account })
            const state = playback.playbackState ?? group.playbackState
            const track = metadata.currentItem?.track
            const coordinatorFirst = [
              group.coordinatorId,
              ...group.playerIds.filter((id) => id !== group.coordinatorId),
            ]
            return {
              id: group.id,
              name: group.name,
              players: coordinatorFirst.flatMap((id) => {
                const name = names.get(id)
                return name === undefined ? [] : [name]
              }),
              state: state ? STATES[state] : null,
              service:
                track?.service?.name ??
                metadata.container?.service?.name ??
                null,
              track: track?.name ?? null,
              artist: track?.artist?.name ?? null,
              actions: controls(playback),
            }
          }),
        )
        const playable =
          known.has(household.id) ||
          accounts.some((account) => account.household === household.id)
        const rooms = read.map((room) => ({ ...room, playable }))
        return { id: household.id, name: household.name ?? null, rooms }
      },
    ),
  )
  return {
    result: SonosRoomsSchema.parse({ households: result }),
    accounts,
  }
}

/**
 * The group playing the given Spotify track. Several households can share a
 * Sonos account, so the group name Spotify reports decides between groups
 * playing the same track. Sonos metadata can lag behind Spotify, so when no
 * group plays the track, the only non-idle group with that name is used if it
 * is playing from Spotify. Null when no single group qualifies. `known` lists
 * the households whose Spotify account was seen before.
 */
export async function sonosPlaying(
  request: SonosRequest,
  token: string,
  playing: { trackUri: string; device: string },
  known: ReadonlySet<string>,
): Promise<SonosObserved<z.infer<typeof SonosPlaybackMatchSchema>>> {
  const active = (await householdGroups(request, token))
    .flatMap(({ household, groups }) =>
      groups.map((group) => ({ ...group, household: household.id })),
    )
    .filter((group) => group.playbackState !== 'PLAYBACK_STATE_IDLE')
  const candidates = await Promise.all(
    active.map(async (group) => {
      const path = `/groups/${encodeURIComponent(group.id)}`
      const metadata = MetadataSchema.parse(
        await controlJson(request, token, `${path}/playbackMetadata`),
      )
      return {
        id: group.id,
        name: group.name,
        household: group.household,
        path,
        uri: trackUri(metadata),
        account: spotifyAccount(metadata),
      }
    }),
  )
  const accounts = candidates.flatMap(({ household, account }) =>
    account ? [{ household, ...account }] : [],
  )
  const tracked = candidates.filter(
    (candidate) => candidate.uri === playing.trackUri,
  )
  const named = only(
    candidates.filter((candidate) => candidate.name === playing.device),
  )
  const match =
    only(tracked.filter((candidate) => candidate.name === playing.device)) ??
    only(tracked) ??
    (named?.uri?.startsWith('spotify:') ? named : null)
  if (!match)
    return { result: SonosPlaybackMatchSchema.parse({ group: null }), accounts }
  const [playback, volume] = await Promise.all([
    controlJson(request, token, `${match.path}/playback`).then((value) =>
      PlaybackSchema.parse(value),
    ),
    controlJson(request, token, `${match.path}/groupVolume`).then((value) =>
      VolumeSchema.parse(value),
    ),
  ])
  return {
    result: SonosPlaybackMatchSchema.parse({
      group: {
        id: match.id,
        name: match.name,
        household: match.household,
        playable:
          known.has(match.household) ||
          accounts.some((account) => account.household === match.household),
        actions: controls(playback),
        volume: volume.fixed ? null : volume.volume / 100,
      },
    }),
    accounts,
  }
}

/** What a group plays now, its position and, when asked, its volume. */
export async function sonosGroupState(
  request: SonosRequest,
  token: string,
  groupId: string,
  withVolume: boolean,
): Promise<SonosGroupState> {
  const path = `/groups/${encodeURIComponent(groupId)}`
  const [playback, metadata, volume] = await Promise.all([
    controlJson(request, token, `${path}/playback`).then((value) =>
      PlaybackSchema.parse(value),
    ),
    controlJson(request, token, `${path}/playbackMetadata`).then((value) =>
      MetadataSchema.parse(value),
    ),
    withVolume
      ? controlJson(request, token, `${path}/groupVolume`).then((value) =>
          VolumeSchema.parse(value),
        )
      : null,
  ])
  const track = metadata.currentItem?.track
  const uri = trackUri(metadata)
  const containerUri = decodedId(metadata.container?.id?.objectId)
  return SonosGroupStateSchema.parse({
    state: playback.playbackState ? STATES[playback.playbackState] : null,
    positionMs: Math.max(0, Math.round(playback.positionMillis ?? 0)),
    track:
      track && (track.name || track.id?.objectId)
        ? {
            uri: uri?.startsWith('spotify:track:') ? uri : null,
            name: track.name ?? null,
            artist: track.artist?.name ?? null,
            album: track.album?.name ?? null,
            artworkUrl: track.imageUrl ?? null,
            // Sonos can omit the duration briefly after a track change.
            durationMs:
              track.durationMillis === undefined
                ? null
                : Math.max(0, Math.round(track.durationMillis)),
          }
        : null,
    hasNext: Boolean(metadata.nextItem),
    containerUri:
      containerUri?.startsWith('spotify:album:') ||
      containerUri?.startsWith('spotify:playlist:')
        ? containerUri
        : null,
    actions: controls(playback),
    ...(volume ? { volume: volume.fixed ? null : volume.volume / 100 } : {}),
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

async function controlPost(
  request: SonosRequest,
  token: string,
  groupId: string,
  endpoint: string,
  body: object,
) {
  await request(
    `${SONOS_CONTROL_API}/groups/${encodeURIComponent(groupId)}/${endpoint}`,
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
  await controlPost(request, token, groupId, COMMANDS[command.action], body)
}

/**
 * Loads Spotify tracks or albums into a group's own queue with the household's
 * Spotify account. Requests are sent one after another because each changes
 * the queue the next one acts on. Without `playbackAction`, Sonos leaves a new
 * queue idle and pauses a playing group, so it is sent only to play.
 */
export async function sonosContent(
  request: SonosRequest,
  token: string,
  groupId: string,
  account: SonosSpotifyAccount,
  input: SonosContentInput,
) {
  const load = (
    uri: string,
    queueAction: 'REPLACE' | 'APPEND' | 'INSERT_NEXT',
    play: boolean,
  ) =>
    controlPost(request, token, groupId, 'playback/content', {
      type: uri.startsWith('spotify:album:') ? 'ALBUM' : 'TRACK',
      id: {
        serviceId: account.serviceId,
        objectId: uri,
        accountId: account.accountId,
      },
      ...(play ? { playbackAction: 'PLAY' } : {}),
      queueAction,
    })
  if (input.mode === 'append') {
    for (const uri of input.uris) await load(uri, 'APPEND', input.play)
    return
  }
  if (input.mode === 'next') {
    // Each item goes directly after the current track, so the last goes first.
    for (const uri of [...input.uris].reverse())
      await load(uri, 'INSERT_NEXT', input.play)
    return
  }
  const skip = input.skip ?? 0
  const positionMs = input.positionMs ?? 0
  // Skipping and seeking happen silently before playback starts.
  const playNow = input.play && skip === 0 && positionMs === 0
  for (const [index, uri] of input.uris.entries())
    await load(uri, index === 0 ? 'REPLACE' : 'APPEND', playNow)
  for (let count = 0; count < skip; count += 1)
    await sonosCommand(request, token, groupId, { action: 'next' })
  if (positionMs > 0)
    await sonosCommand(request, token, groupId, {
      action: 'seek',
      positionMs,
    })
  if (input.play && !playNow)
    await sonosCommand(request, token, groupId, { action: 'play' })
}
