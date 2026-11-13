import { createHash, randomBytes } from 'node:crypto'
import { z } from 'zod'
import {
  PluginResultSchema,
  type MediaPluginTestContext,
} from '@repo/media-plugin-sdk'

export const SPOTIFY_SCOPE = 'user-library-read'
// Web Playback SDK scopes, plus the player Web API state and control scopes.
export const SPOTIFY_PLAYBACK_SCOPES: readonly string[] = [
  'streaming',
  'user-read-email',
  'user-read-private',
  'user-read-playback-state',
  'user-modify-playback-state',
]
// Reading the account's playlists; requested with every new connection.
export const SPOTIFY_PLAYLIST_SCOPES: readonly string[] = [
  'playlist-read-private',
  'playlist-read-collaborative',
]
// Adding items to the account's playlists; requested only when asked for.
export const SPOTIFY_PLAYLIST_CHANGE_SCOPES: readonly string[] = [
  'playlist-modify-private',
  'playlist-modify-public',
]
// POST /playlists/{id}/items accepts at most this many URIs per request.
export const SPOTIFY_PLAYLIST_ADD_LIMIT = 100
export const SpotifyIdSchema = z.string().regex(/^[A-Za-z0-9]{22}$/)
export const UpcSchema = z.string().regex(/^\d{8,14}$/)
const HttpsUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password
  })
const ArtistSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
})
const ReleaseDateSchema = z
  .string()
  .regex(/^\d{4}(?:-\d{2}(?:-\d{2})?)?$/)
  .refine((value) => {
    const day =
      value.length === 4
        ? `${value}-01-01`
        : value.length === 7
          ? `${value}-01`
          : value
    const timestamp = Date.parse(`${day}T00:00:00.000Z`)
    return (
      Number.isFinite(timestamp) &&
      new Date(timestamp).toISOString().slice(0, 10) === day
    )
  }, 'Invalid Spotify release date')
export const SpotifyTrackSchema = z.object({
  id: SpotifyIdSchema.nullable(),
  name: z.string().min(1),
  disc_number: z.number().int().positive(),
  track_number: z.number().int().positive(),
  duration_ms: z.number().int().nonnegative(),
  artists: z.array(ArtistSchema),
})
export const SpotifyTracksPageSchema = z.object({
  items: z.array(SpotifyTrackSchema).max(500),
  offset: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  next: z.string().nullable(),
})
export const SpotifyAlbumSchema = z.object({
  id: SpotifyIdSchema,
  name: z.string().min(1),
  artists: z.array(ArtistSchema).min(1),
  images: z.array(z.object({ url: HttpsUrlSchema })).default([]),
  release_date: ReleaseDateSchema.optional(),
  release_date_precision: z.enum(['year', 'month', 'day']).optional(),
  total_tracks: z.number().int().nonnegative().optional(),
  external_ids: z
    .object({ upc: UpcSchema.optional(), ean: UpcSchema.optional() })
    .optional(),
  genres: z.array(z.string()).optional(),
  popularity: z.number().min(0).max(100).optional(),
  label: z.string().optional(),
  tracks: SpotifyTracksPageSchema.optional(),
})
export const SpotifySavedPageSchema = z.object({
  items: z
    .array(
      z.object({
        added_at: z.string().datetime({ offset: true }),
        album: SpotifyAlbumSchema,
      }),
    )
    .max(50),
  total: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  next: z.string().nullable(),
})
const LooseImagesSchema = z
  .array(z.object({ url: z.string() }))
  .nullable()
  .optional()
export const SpotifyProfileSchema = z.object({ id: z.string().min(1) })
export const SpotifyPlaylistSchema = z.object({
  id: SpotifyIdSchema,
  name: z.string(),
  description: z.string().nullable().optional(),
  collaborative: z.boolean().optional(),
  snapshot_id: z.string().optional(),
  images: LooseImagesSchema,
  owner: z
    .object({
      id: z.string(),
      display_name: z.string().nullable().optional(),
    })
    .optional(),
  // `tracks` is the name this object had before February 2026.
  items: z.object({ total: z.number().int().nonnegative() }).optional(),
  tracks: z.object({ total: z.number().int().nonnegative() }).optional(),
})
export const SpotifyPlaylistsPageSchema = z.object({
  items: z.array(SpotifyPlaylistSchema.nullable()).max(50),
  total: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  next: z.string().nullable(),
})
/** One entry of a playlist or of the saved tracks. */
const SpotifyTrackEntrySchema = z.object({
  added_at: z.string().nullable().optional(),
  is_local: z.boolean().optional(),
  // Playlist entries carry `item`; saved tracks and older responses, `track`.
  item: z.unknown().optional(),
  track: z.unknown().optional(),
})
export const SpotifyTrackEntriesPageSchema = z.object({
  items: z.array(SpotifyTrackEntrySchema).max(100),
  total: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  next: z.string().nullable(),
})
const SpotifyEntryKindSchema = z.object({
  type: z.string().optional(),
  id: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
})
const SpotifyLibraryTrackSchema = z.object({
  id: SpotifyIdSchema,
  name: z.string().min(1),
  duration_ms: z.number().int().nonnegative(),
  artists: z.array(ArtistSchema).min(1),
  album: z
    .object({
      id: z.string().nullable().optional(),
      name: z.string().nullable().optional(),
      images: LooseImagesSchema,
      release_date: z.string().nullable().optional(),
    })
    .optional(),
  external_ids: z.object({ isrc: z.string().optional() }).optional(),
})
export type SpotifyLibraryTrack = {
  spotifyTrackId: string
  title: string
  artists: string[]
  durationSec: number
  albumName: string | null
  spotifyAlbumId: string | null
  artworkUrl: string | null
  releaseDate: string | null
  isrc: string | null
  addedAt: string | null
}
// GET /me/shows and GET /shows/{id}/episodes return at most 50 per request.
export const SPOTIFY_PODCAST_PAGE_SIZE = 50
const SpotifyShowSchema = z.object({
  id: SpotifyIdSchema,
  name: z.string(),
  description: z.string().nullable().optional(),
  images: LooseImagesSchema,
  total_episodes: z.number().int().nonnegative(),
})
/** A page of the account's saved podcasts; Spotify may return null entries. */
export const SpotifySavedShowsPageSchema = z.object({
  items: z
    .array(
      z
        .object({
          added_at: z.string().nullable().optional(),
          show: SpotifyShowSchema.nullable().optional(),
        })
        .nullable(),
    )
    .max(SPOTIFY_PODCAST_PAGE_SIZE),
  total: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  next: z.string().nullable(),
})
const SpotifyEpisodeSchema = z.object({
  id: SpotifyIdSchema,
  name: z.string(),
  description: z.string().nullable().optional(),
  duration_ms: z.number().int().nonnegative(),
  release_date: ReleaseDateSchema,
  release_date_precision: z.enum(['year', 'month', 'day']),
  images: LooseImagesSchema,
})
/** A page of one show's episodes; Spotify may return null entries. */
export const SpotifyEpisodesPageSchema = z.object({
  items: z
    .array(SpotifyEpisodeSchema.nullable())
    .max(SPOTIFY_PODCAST_PAGE_SIZE),
  total: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  next: z.string().nullable(),
})
export type SpotifyShow = {
  id: string
  title: string
  description: string | null
  thumbnailUrl: string | null
  itemTotal: number
}
export type SpotifyEpisode = {
  id: string
  title: string
  description: string
  durationSec: number
  publishedAt: Date
  publishedPrecision: 'year' | 'month' | 'day'
  artworkUrl: string | null
}
export const SpotifyTokenSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().refine((value) => value.toLowerCase() === 'bearer'),
  expires_in: z.number().int().positive().max(86400),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().optional(),
})
export type SpotifyRequest = MediaPluginTestContext['request']

export function spotifyAlbumId(value: string): string | null {
  const direct = SpotifyIdSchema.safeParse(value)
  if (direct.success) return direct.data
  const uri = /^spotify:album:([A-Za-z0-9]{22})$/.exec(value)
  if (uri?.[1]) return uri[1]
  try {
    const url = new URL(value)
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'open.spotify.com' ||
      url.port ||
      url.username ||
      url.password
    )
      return null
    return /^\/album\/([A-Za-z0-9]{22})\/?$/.exec(url.pathname)?.[1] ?? null
  } catch {
    return null
  }
}

export function spotifyRedirectUri(value: string): string {
  const url = new URL(value)
  const loopback = url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.hostname === 'localhost' ||
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    url.pathname !== '/api/v1/spotify/callback'
  ) {
    throw new Error(
      'Use the exact HTTPS Spotify callback URI (HTTP only on a loopback IP)',
    )
  }
  return url.toString()
}

export function spotifyAuthorization(
  clientId: string,
  redirectUri: string,
  scopes: readonly string[] = [SPOTIFY_SCOPE],
) {
  const state = randomBytes(32).toString('base64url')
  const verifier = randomBytes(64).toString('base64url')
  const url = new URL('https://accounts.spotify.com/authorize')
  url.search = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: spotifyRedirectUri(redirectUri),
    scope: scopes.join(' '),
    state,
    code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
  }).toString()
  return { state, verifier, url: url.toString() }
}

export async function spotifyToken(
  request: SpotifyRequest,
  body: URLSearchParams,
  credentials?: { clientId: string; clientSecret: string },
) {
  const response = await request('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(credentials
        ? {
            Authorization: `Basic ${Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString('base64')}`,
          }
        : {}),
    },
    body: body.toString(),
  })
  if (!response.ok)
    throw new Error(`Spotify token request failed (HTTP ${response.status})`)
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new Error('Spotify returned an invalid token response')
  }
  const parsed = SpotifyTokenSchema.safeParse(payload)
  if (!parsed.success)
    throw new Error('Spotify returned an invalid token response')
  return parsed.data
}

export async function spotifyJson(
  request: SpotifyRequest,
  token: string,
  path: string,
  params: Record<string, string> = {},
  options?: { notFoundOn404?: boolean },
): Promise<unknown> {
  const url = new URL(`https://api.spotify.com/v1/${path}`)
  url.search = new URLSearchParams(params).toString()
  const response = await request(
    url,
    { headers: { Authorization: `Bearer ${token}` } },
    options,
  )
  if (!response.ok)
    throw new Error(`Spotify request failed (HTTP ${response.status})`)
  return response.json()
}

/** The response to a playlist change: the playlist's new version. */
export const SpotifySnapshotSchema = z.object({
  snapshot_id: z.string().min(1),
})

export async function spotifyPostJson(
  request: SpotifyRequest,
  token: string,
  path: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const response = await request(`https://api.spotify.com/v1/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  if (!response.ok)
    throw new Error(`Spotify request failed (HTTP ${response.status})`)
  return response.json()
}

/**
 * The track URIs of an album that a playlist does not hold yet, in album
 * order and without repeats, split into requests Spotify accepts.
 */
export function spotifyTrackAdditions(
  albumTrackIds: readonly string[],
  present: ReadonlySet<string>,
  batchSize = SPOTIFY_PLAYLIST_ADD_LIMIT,
): string[][] {
  const missing = [...new Set(albumTrackIds)].filter((id) => !present.has(id))
  const batches: string[][] = []
  for (let start = 0; start < missing.length; start += batchSize)
    batches.push(
      missing
        .slice(start, start + batchSize)
        .map((id) => `spotify:track:${id}`),
    )
  return batches
}

export function spotifyArtworkUrl(
  images: z.infer<typeof LooseImagesSchema>,
): string | null {
  const url = HttpsUrlSchema.safeParse(images?.[0]?.url)
  return url.success ? url.data : null
}

// PostgreSQL text cannot hold a NUL character.
const withoutNul = (value: string) => value.replaceAll('\u0000', '')

/** A saved podcast as stored; null for an entry without a show. */
export function normalizeSpotifyShow(
  entry: z.infer<typeof SpotifySavedShowsPageSchema>['items'][number],
): SpotifyShow | null {
  const show = entry?.show
  if (!show) return null
  return {
    id: show.id,
    title: withoutNul(show.name).trim() || 'Untitled podcast',
    description: withoutNul(show.description ?? '').trim() || null,
    thumbnailUrl: spotifyArtworkUrl(show.images),
    itemTotal: show.total_episodes,
  }
}

type ReleasePrecision = SpotifyEpisode['publishedPrecision']
const precisionRank: Record<ReleasePrecision, number> = {
  year: 0,
  month: 1,
  day: 2,
}

/**
 * An episode as stored. The release date becomes midnight UTC of its first
 * day, with the precision Spotify reports; a date shorter than that precision
 * keeps its own.
 */
export function normalizeSpotifyEpisode(
  episode: z.infer<typeof SpotifyEpisodeSchema>,
): SpotifyEpisode {
  const date = episode.release_date
  const written: ReleasePrecision =
    date.length === 4 ? 'year' : date.length === 7 ? 'month' : 'day'
  const declared = episode.release_date_precision
  const publishedPrecision =
    precisionRank[declared] <= precisionRank[written] ? declared : written
  const day =
    publishedPrecision === 'year'
      ? `${date.slice(0, 4)}-01-01`
      : publishedPrecision === 'month'
        ? `${date.slice(0, 7)}-01`
        : date
  return {
    id: episode.id,
    title: withoutNul(episode.name).trim() || 'Untitled episode',
    description: withoutNul(episode.description ?? '').trim(),
    durationSec: Math.round(episode.duration_ms / 1000),
    publishedAt: new Date(`${day}T00:00:00.000Z`),
    publishedPrecision,
    artworkUrl: spotifyArtworkUrl(episode.images),
  }
}

/**
 * Reads one playlist or saved-track entry. `skipped` is a local file, an
 * episode or a track Spotify no longer has; `invalid` is a track in a form
 * this application does not recognise.
 */
export function normalizeSpotifyTrackEntry(
  entry: z.infer<typeof SpotifyTrackEntrySchema>,
):
  | { track: SpotifyLibraryTrack }
  | { track: null; reason: 'skipped' | 'invalid' } {
  const value = entry.item ?? entry.track
  const kind = SpotifyEntryKindSchema.safeParse(value)
  if (
    entry.is_local ||
    !kind.success ||
    (kind.data.type !== undefined && kind.data.type !== 'track') ||
    !kind.data.id ||
    !kind.data.name
  )
    return { track: null, reason: 'skipped' }
  const parsed = SpotifyLibraryTrackSchema.safeParse(value)
  if (!parsed.success) return { track: null, reason: 'invalid' }
  const data = parsed.data
  const albumId = SpotifyIdSchema.safeParse(data.album?.id)
  const releaseDate = ReleaseDateSchema.safeParse(data.album?.release_date)
  const addedAt = z
    .string()
    .datetime({ offset: true })
    .safeParse(entry.added_at)
  return {
    track: {
      spotifyTrackId: data.id,
      title: data.name,
      artists: [...new Set(data.artists.map((artist) => artist.name))],
      durationSec: Math.round(data.duration_ms / 1000),
      albumName: data.album?.name || null,
      spotifyAlbumId: albumId.success ? albumId.data : null,
      artworkUrl: spotifyArtworkUrl(data.album?.images),
      // Spotify reports year 0000 when it has no release date.
      releaseDate:
        releaseDate.success && !releaseDate.data.startsWith('0000')
          ? releaseDate.data
          : null,
      isrc: data.external_ids?.isrc?.trim().toUpperCase() || null,
      // Spotify reports the Unix epoch for entries older than the field.
      addedAt:
        addedAt.success && Date.parse(addedAt.data) > 0 ? addedAt.data : null,
    },
  }
}

export function normalizeSpotifyAlbum(value: unknown, addedAt?: string) {
  const data = SpotifyAlbumSchema.parse(value)
  const url = `https://open.spotify.com/album/${data.id}`
  const complete =
    data.tracks?.offset === 0 &&
    data.tracks.next === null &&
    data.tracks.items.length === data.tracks.total &&
    (data.total_tracks === undefined || data.total_tracks === data.tracks.total)
  const tracks = complete
    ? [...(data.tracks?.items ?? [])].sort(
        (a, b) =>
          a.disc_number - b.disc_number || a.track_number - b.track_number,
      )
    : []
  return PluginResultSchema.parse({
    payload: data,
    normalized: {
      mediaPatch: {
        title: data.name,
        artworkUrl: data.images[0]?.url,
        releaseDate: data.release_date,
        metadata: {
          spotifyReleaseDatePrecision: data.release_date_precision ?? null,
        },
      },
      albumPatch: {
        spotifyUrl: url,
        ...(addedAt
          ? { dateAdded: z.string().datetime({ offset: true }).parse(addedAt) }
          : {}),
        ...(complete
          ? {
              durationSec: Math.round(
                tracks.reduce((sum, track) => sum + track.duration_ms, 0) /
                  1000,
              ),
            }
          : {}),
        metadata: {
          browse: {
            ...(data.popularity === undefined
              ? {}
              : { popularitySpotify: data.popularity }),
          },
        },
      },
      references: [
        { referenceType: 'album', externalId: data.id, isPrimary: true },
        ...(data.external_ids?.upc
          ? [{ referenceType: 'upc', externalId: data.external_ids.upc }]
          : []),
      ],
      links: [{ provider: 'spotify', label: 'Spotify', url }],
      credits: data.artists.map((artist, billingOrder) => ({
        name: artist.name,
        role: 'artist',
        billingOrder,
      })),
      tags: (data.genres ?? []).map((name) => ({ name, kind: 'genre' })),
      tracks: tracks.map((track, index) => ({
        externalId: track.id ?? undefined,
        title: track.name,
        position: index + 1,
        durationSec: Math.round(track.duration_ms / 1000),
      })),
    },
  })
}
