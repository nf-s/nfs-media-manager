import { z } from 'zod'
import {
  PlaybackCatalogItemSchema,
  type PlaybackCatalogInput,
  type PlaybackCatalogItem,
} from '@repo/schemas/playback'
import type { PlaybackSnapshot, PlayedTrack } from './playback'
import { playbackCatalogArtwork, playbackSpotifyId } from './playback-catalog'
import { spotifyTrackUri } from './album-links'

const DeviceSchema = z.object({
  id: z.string().nullable(),
  is_active: z.boolean(),
  is_restricted: z.boolean().optional(),
  name: z.string(),
  type: z.string(),
  volume_percent: z.number().min(0).max(100).nullable().optional(),
  supports_volume: z.boolean().optional(),
})
const DevicesSchema = z.object({ devices: z.array(DeviceSchema) })
export const SpotifyLinkedTrackSchema = z
  .object({ id: z.string().nullish(), uri: z.string().min(1).nullish() })
  .nullish()
  .transform((track) => track?.uri ?? spotifyTrackUri(track?.id) ?? null)
const SpotifyPlaybackEntitySchema = z.object({
  id: z.string().nullish(),
  uri: z.string().nullish(),
})
export const SpotifyPlaybackArtistSchema = SpotifyPlaybackEntitySchema.extend({
  name: z.string(),
})
export const SpotifyPlaybackAlbumSchema = SpotifyPlaybackEntitySchema.extend({
  name: z.string(),
  images: z.array(z.object({ url: z.string() })).default([]),
})

export function spotifyPlaybackEntityUri(
  kind: 'album' | 'artist',
  item: z.infer<typeof SpotifyPlaybackEntitySchema> | undefined,
) {
  if (item?.uri) return item.uri
  const candidate = `spotify:${kind}:${item?.id ?? ''}`
  return playbackSpotifyId(kind, candidate) ? candidate : null
}

const TrackSchema = z.object({
  uri: z.string(),
  name: z.string(),
  duration_ms: z.number().nonnegative(),
  track_number: z.number().int().optional(),
  disc_number: z.number().int().optional(),
  artists: z.array(SpotifyPlaybackArtistSchema).default([]),
  linked_from: SpotifyLinkedTrackSchema,
  is_local: z.boolean().optional(),
  is_playable: z.boolean().optional(),
  album: SpotifyPlaybackAlbumSchema.optional(),
})
const StateSchema = z.object({
  device: DeviceSchema,
  context: z.object({ uri: z.string() }).nullable().optional(),
  progress_ms: z.number().nonnegative().nullable(),
  is_playing: z.boolean(),
  item: z.unknown(),
})
const ObservedTrackSchema = TrackSchema.pick({
  uri: true,
  name: true,
  artists: true,
  album: true,
  duration_ms: true,
  is_local: true,
}).extend({ duration_ms: TrackSchema.shape.duration_ms.optional() })

function catalogTrack(value: unknown): PlaybackCatalogItem | null {
  const parsed = ObservedTrackSchema.safeParse(value)
  if (!parsed.success) return null
  const track = parsed.data
  if (track.is_local) return null
  const item = PlaybackCatalogItemSchema.safeParse({
    kind: 'track',
    spotifyId: playbackSpotifyId('track', track.uri),
    title: track.name,
    artworkUrl: playbackCatalogArtwork(track.album?.images[0]?.url),
    durationSec: track.duration_ms
      ? Math.round(track.duration_ms / 1000)
      : undefined,
    album: track.album
      ? {
          title: track.album.name,
          spotifyId: playbackSpotifyId(
            'album',
            spotifyPlaybackEntityUri('album', track.album),
          ),
        }
      : undefined,
    artists: track.artists.map((artist) => ({
      name: artist.name,
      spotifyId: playbackSpotifyId(
        'artist',
        spotifyPlaybackEntityUri('artist', artist),
      ),
    })),
  })
  return item.success ? item.data : null
}

const QueueItemSchema = z
  .object({
    uri: z.string().min(1),
    linked_from: SpotifyLinkedTrackSchema,
  })
  .passthrough()
  .transform(({ uri, linked_from, ...item }) => ({
    uri,
    linkedFromUri: linked_from,
    catalog: catalogTrack({ ...item, uri }),
  }))
const QueueSchema = z.object({
  currently_playing: QueueItemSchema.nullable(),
  queue: z.array(QueueItemSchema),
})
const AlbumTracksSchema = z.object({
  items: z.array(
    z.object({
      uri: z.string(),
      is_playable: z.boolean().optional(),
      linked_from: z.object({ uri: z.string().optional() }).optional(),
    }),
  ),
  next: z.string().nullable().optional(),
})
const HistorySchema = z.object({
  items: z.array(
    z.object({
      track: z.object({ uri: z.string(), name: z.string() }).passthrough(),
      played_at: z.string(),
    }),
  ),
})
/** The most play history entries Spotify returns for one request. */
const HISTORY_LIMIT = 50
const ALBUM_PAGE = 50
const ALBUM_PAGES = 10
const ErrorSchema = z.object({
  error: z.object({
    message: z.string().optional(),
    reason: z.string().optional(),
  }),
})

export type PlaybackDevice = {
  id: string
  name: string
  type: string
  active: boolean
  restricted: boolean
  /** 0 to 1, or null when the device does not report or accept a volume. */
  volume: number | null
}

/** A device Spotify reports but does not let apps control; it has no usable ID. */
export type RestrictedDevice = { name: string; type: string }

export class PlaybackApiError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string | null,
  ) {
    super(`Spotify player request failed (HTTP ${status})`)
    this.name = 'PlaybackApiError'
  }
}

export function httpsUrl(value: string | null | undefined): string | null {
  if (!value) return null
  try {
    return new URL(value).protocol === 'https:' ? value : null
  } catch {
    return null
  }
}

function device(value: z.infer<typeof DeviceSchema>): PlaybackDevice | null {
  if (!value.id) return null
  return {
    id: value.id,
    name: value.name,
    type: value.type.toLowerCase(),
    active: value.is_active,
    restricted: value.is_restricted ?? false,
    volume:
      value.supports_volume === false ||
      value.volume_percent === null ||
      value.volume_percent === undefined
        ? null
        : value.volume_percent / 100,
  }
}

/** What Spotify knows about a track, in the shape a playback snapshot shows it. */
export type TrackDetails = Pick<
  PlaybackSnapshot,
  | 'trackUri'
  | 'linkedFromUri'
  | 'isLocal'
  | 'trackName'
  | 'artists'
  | 'albumName'
  | 'albumUri'
  | 'artistLinks'
  | 'artworkUrl'
  | 'durationMs'
  | 'trackNumber'
  | 'discNumber'
>

function trackDetails(track: z.infer<typeof TrackSchema>): TrackDetails {
  return {
    trackUri: track.uri,
    linkedFromUri: track.linked_from,
    ...(track.is_local ? { isLocal: true } : {}),
    trackName: track.name,
    artists: track.artists.map((artist) => artist.name).join(', '),
    albumName: track.album?.name ?? '',
    albumUri: spotifyPlaybackEntityUri('album', track.album),
    artistLinks: track.artists.map((artist) => ({
      name: artist.name,
      uri: spotifyPlaybackEntityUri('artist', artist),
    })),
    artworkUrl: httpsUrl(track.album?.images[0]?.url),
    durationMs: track.duration_ms,
    trackNumber: track.track_number ?? null,
    discNumber: track.disc_number ?? null,
  }
}

/** Normalises Spotify's playback state response; exported for tests. */
export function remotePlayback(
  value: unknown,
  at: number,
): {
  /** The device playback is on, when apps can control it. */
  device: PlaybackDevice | null
  /** The device playback is on, when apps can only observe it. */
  restricted: RestrictedDevice | null
  snapshot: PlaybackSnapshot | null
} {
  const state = StateSchema.parse(value)
  const track = TrackSchema.safeParse(state.item)
  const reported = device(state.device)
  const controllable = reported !== null && !reported.restricted
  return {
    device: controllable ? reported : null,
    restricted: controllable
      ? null
      : { name: state.device.name, type: state.device.type.toLowerCase() },
    snapshot: track.success
      ? {
          ...trackDetails(track.data),
          positionMs: state.progress_ms ?? 0,
          paused: !state.is_playing,
          contextUri: state.context?.uri ?? null,
          hasNext: null,
          at,
        }
      : null,
  }
}

type TokenSource = (refresh?: boolean) => Promise<string>
type Query = Record<string, string | number | undefined>

/**
 * Spotify's player endpoints, called from the browser with the short-lived
 * access token. These are user-initiated playback controls and do not pass
 * through the server's provider request gate.
 */
export function createPlayerApi(
  token: TokenSource,
  fetcher: typeof fetch = fetch,
  observe?: (
    operation: PlaybackCatalogInput['operation'],
    items: PlaybackCatalogItem[],
  ) => void,
) {
  async function send(
    method: 'GET' | 'PUT' | 'POST',
    path: string,
    query: Query = {},
    body?: unknown,
  ): Promise<Response> {
    const url = new URL(
      path.startsWith('/albums/') || path.startsWith('/tracks/')
        ? `https://api.spotify.com/v1${path}`
        : `https://api.spotify.com/v1/me/player${path}`,
    )
    for (const [key, value] of Object.entries(query))
      if (value !== undefined) url.searchParams.set(key, String(value))
    const request = async (refresh: boolean) =>
      fetcher(url, {
        method,
        headers: {
          Authorization: `Bearer ${await token(refresh)}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    let response = await request(false)
    // The cached token may have been replaced; ask the server once more.
    if (response.status === 401) response = await request(true)
    if (response.ok) return response
    let payload: unknown = null
    try {
      payload = await response.json()
    } catch {
      /* Spotify sends some failures without a body. */
    }
    const parsed = ErrorSchema.safeParse(payload)
    throw new PlaybackApiError(
      response.status,
      parsed.success ? (parsed.data.error.reason ?? null) : null,
    )
  }
  /** Set once Spotify has refused the play history to this connection. */
  let historyRefused = false
  /** A track as Spotify serves it in the account's market. */
  async function readTrack(trackUri: string) {
    const id = /^spotify:track:([A-Za-z0-9]{22})$/.exec(trackUri)?.[1]
    if (!id) throw new PlaybackApiError(404, null)
    const response = await send('GET', `/tracks/${id}`, {
      market: 'from_token',
    })
    return TrackSchema.parse(await response.json())
  }
  return {
    async devices(): Promise<PlaybackDevice[]> {
      const response = await send('GET', '/devices')
      return DevicesSchema.parse(await response.json()).devices.flatMap(
        (entry) => {
          const parsed = device(entry)
          return parsed ? [parsed] : []
        },
      )
    },
    async state() {
      const response = await send('GET', '')
      const at = Date.now()
      if (response.status === 204)
        return { device: null, restricted: null, snapshot: null }
      return remotePlayback(await response.json(), at)
    },
    async play(deviceId: string, body: unknown) {
      await send('PUT', '/play', { device_id: deviceId }, body)
    },
    async enqueue(deviceId: string, trackUri: string) {
      await send('POST', '/queue', { device_id: deviceId, uri: trackUri })
    },
    async queue() {
      const response = await send('GET', '/queue')
      const { currently_playing: current, queue: upcoming } = QueueSchema.parse(
        await response.json(),
      )
      const items = [current, ...upcoming].flatMap((row) =>
        row?.catalog ? [row.catalog] : [],
      )
      if (items.length) observe?.('playback-queue', items)
      const playable = ({
        uri,
        linkedFromUri,
      }: NonNullable<typeof current>) => ({ uri, linkedFromUri })
      return {
        current: current ? playable(current) : null,
        upcoming: upcoming.map(playable),
      }
    },
    async transfer(deviceId: string, play: boolean) {
      await send('PUT', '', {}, { device_ids: [deviceId], play })
    },
    async resume(deviceId: string) {
      await send('PUT', '/play', { device_id: deviceId })
    },
    async pause(deviceId: string) {
      await send('PUT', '/pause', { device_id: deviceId })
    },
    async next(deviceId: string) {
      await send('POST', '/next', { device_id: deviceId })
    },
    async previous(deviceId: string) {
      await send('POST', '/previous', { device_id: deviceId })
    },
    async seek(deviceId: string, positionMs: number) {
      await send('PUT', '/seek', {
        device_id: deviceId,
        position_ms: Math.max(0, Math.round(positionMs)),
      })
    },
    async volume(deviceId: string, volume: number) {
      await send('PUT', '/volume', {
        device_id: deviceId,
        volume_percent: Math.round(Math.min(1, Math.max(0, volume)) * 100),
      })
    },
    /**
     * Spotify's details of a track, for a player that reports only the track's
     * URI.
     */
    async track(trackUri: string): Promise<TrackDetails> {
      return trackDetails(await readTrack(trackUri))
    },
    /**
     * The recording Spotify plays for a track in the account's market, which
     * can be another one than was asked for; null when it plays none there.
     */
    async recording(
      trackUri: string,
    ): Promise<{ uri: string; name: string } | null> {
      const { uri, name, is_playable: playable } = await readTrack(trackUri)
      return playable === false ? null : { uri, name }
    },
    /**
     * The tracks the account played after a time, on any device; null when
     * the connection was not given permission to read the play history,
     * which Spotify grants separately from playback.
     */
    async played(since: number): Promise<PlayedTrack[] | null> {
      if (historyRefused) return null
      let response: Response
      try {
        response = await send('GET', '/recently-played', {
          limit: HISTORY_LIMIT,
          after: Math.max(0, Math.floor(since)),
        })
      } catch (error) {
        if (!(error instanceof PlaybackApiError) || error.status !== 403)
          throw error
        historyRefused = true
        return null
      }
      const { items } = HistorySchema.parse(await response.json())
      const catalog = items.flatMap(({ track }) => {
        const item = catalogTrack(track)
        return item ? [item] : []
      })
      if (catalog.length) observe?.('playback-recovery', catalog)
      return items.flatMap(({ track, played_at: at }) => {
        const playedAt = Date.parse(at)
        return Number.isNaN(playedAt)
          ? []
          : [{ uri: track.uri, name: track.name, playedAt }]
      })
    },
    /**
     * How many playable tracks come before a track on its album, for a
     * player that can only start an album from its first track.
     */
    async albumTrackIndex(albumUri: string, trackUri: string) {
      const id = /^spotify:album:([A-Za-z0-9]{22})$/.exec(albumUri)?.[1]
      if (!id) throw new PlaybackApiError(404, null)
      let before = 0
      for (let page = 0; page < ALBUM_PAGES; page += 1) {
        const response = await send('GET', `/albums/${id}/tracks`, {
          market: 'from_token',
          limit: ALBUM_PAGE,
          offset: page * ALBUM_PAGE,
        })
        const { items, next } = AlbumTracksSchema.parse(await response.json())
        for (const item of items) {
          if (item.uri === trackUri || item.linked_from?.uri === trackUri)
            return before
          if (item.is_playable !== false) before += 1
        }
        if (!next) break
      }
      throw new PlaybackApiError(404, null)
    },
  }
}

export type PlayerApi = ReturnType<typeof createPlayerApi>
