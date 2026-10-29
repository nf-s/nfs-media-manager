import { createHash, randomBytes } from 'node:crypto'
import { z } from 'zod'
import {
  PluginResultSchema,
  type MediaPluginTestContext,
} from '@repo/media-plugin-sdk'

export const SPOTIFY_SCOPE = 'user-library-read'
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
export const SpotifyTokenSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().refine((value) => value.toLowerCase() === 'bearer'),
  expires_in: z.number().int().positive().max(86400),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().optional(),
})
export type SpotifyAlbum = z.infer<typeof SpotifyAlbumSchema>
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

export function spotifyAuthorization(clientId: string, redirectUri: string) {
  const state = randomBytes(32).toString('base64url')
  const verifier = randomBytes(64).toString('base64url')
  const url = new URL('https://accounts.spotify.com/authorize')
  url.search = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: spotifyRedirectUri(redirectUri),
    scope: SPOTIFY_SCOPE,
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
): Promise<unknown> {
  const url = new URL(`https://api.spotify.com/v1/${path}`)
  url.search = new URLSearchParams(params).toString()
  const response = await request(url, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!response.ok)
    throw new Error(`Spotify request failed (HTTP ${response.status})`)
  return response.json()
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
