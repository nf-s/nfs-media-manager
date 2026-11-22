import { z } from 'zod'
import type { MediaPluginTestContext } from '@repo/media-plugin-sdk'
import {
  TIDAL_FILTER_LIMIT,
  TidalCountryCodeSchema,
  TidalIdSchema,
  TidalKeyScaleSchema,
  TidalKeySchema,
  type TidalTrackCandidate,
  type TidalTrackData,
} from '@repo/schemas/tidal'

export type TidalRequest = MediaPluginTestContext['request']

export const TIDAL_API_BASE = 'https://openapi.tidal.com/v2'
export const TIDAL_TOKEN_URL = 'https://auth.tidal.com/v1/oauth2/token'
/** The country TIDAL answers for when Providers sets none. */
export const TIDAL_DEFAULT_COUNTRY = 'AU'
/** Album track lists longer than this are refused, as Spotify's are. */
export const TIDAL_ALBUM_TRACK_LIMIT = 500
/** A new token is requested this long before the cached one expires. */
const TOKEN_EXPIRY_MARGIN_MS = 5 * 60 * 1000

const TidalTokenSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().refine((value) => value.toLowerCase() === 'bearer'),
  expires_in: z.number().int().positive().max(86400),
})

const tokenCache = new Map<string, { token: string; expiresAt: number }>()

/** Clears cached tokens; for tests. */
export function clearTidalTokenCache() {
  tokenCache.clear()
}

export function tidalCountry(secrets: Record<string, string>): string {
  const country = secrets['countryCode']?.trim()
  if (!country) return TIDAL_DEFAULT_COUNTRY
  const parsed = TidalCountryCodeSchema.safeParse(country)
  if (!parsed.success)
    throw new Error('TIDAL country must be a two-letter uppercase country code')
  return parsed.data
}

/**
 * A client-credentials token, cached in this process until shortly before it
 * expires. It is used only for requests made by the server.
 */
export async function tidalToken(
  secrets: Record<string, string>,
  request: TidalRequest,
  now = Date.now(),
): Promise<string> {
  const clientId = secrets['clientId']?.trim()
  const clientSecret = secrets['clientSecret']?.trim()
  if (!clientId || !clientSecret)
    throw new Error('TIDAL client credentials are missing')
  const cacheKey = `${clientId}:${clientSecret}`
  const cached = tokenCache.get(cacheKey)
  if (cached && cached.expiresAt > now) return cached.token
  const response = await request(TIDAL_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
    },
    body: new URLSearchParams({ grant_type: 'client_credentials' }).toString(),
  })
  if (!response.ok)
    throw new Error(`TIDAL token request failed (HTTP ${response.status})`)
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new Error('TIDAL returned an invalid token response')
  }
  const parsed = TidalTokenSchema.safeParse(payload)
  if (!parsed.success)
    throw new Error('TIDAL returned an invalid token response')
  tokenCache.set(cacheKey, {
    token: parsed.data.access_token,
    expiresAt: now + parsed.data.expires_in * 1000 - TOKEN_EXPIRY_MARGIN_MS,
  })
  return parsed.data.access_token
}

/** One GET of the TIDAL API; repeated keys are sent as repeated parameters. */
export async function tidalJson(
  request: TidalRequest,
  token: string,
  path: string,
  params: ReadonlyArray<readonly [string, string]>,
): Promise<unknown> {
  if (!path.startsWith('/')) throw new Error('Invalid TIDAL path')
  const url = new URL(`${TIDAL_API_BASE}${path}`)
  for (const [key, value] of params) url.searchParams.append(key, value)
  const response = await request(url, {
    headers: {
      Accept: 'application/vnd.api+json',
      Authorization: `Bearer ${token}`,
    },
  })
  if (!response.ok)
    throw new Error(`TIDAL request failed (HTTP ${response.status})`)
  try {
    return await response.json()
  } catch {
    throw new Error('TIDAL returned an invalid response')
  }
}

/** Seconds in an ISO 8601 duration such as `PT4M28S`, or null. */
export function tidalDurationSec(value: string | undefined): number | null {
  if (!value) return null
  const match =
    /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(value)
  if (!match || value === 'P' || value === 'PT') return null
  const [, days, hours, minutes, seconds] = match
  return Math.round(
    Number(days ?? 0) * 86400 +
      Number(hours ?? 0) * 3600 +
      Number(minutes ?? 0) * 60 +
      Number(seconds ?? 0),
  )
}

const text = z.string().trim().min(1).max(500)
const ExternalLinkSchema = z.object({
  href: z.string().min(1).max(2000),
  meta: z.object({ type: z.string() }).passthrough().optional(),
})
const LinksSchema = z
  .object({
    self: z.string().optional(),
    next: z.string().optional(),
    meta: z.object({ nextCursor: z.string().optional() }).optional(),
  })
  .passthrough()

const ItemIdentifierSchema = z.object({
  id: TidalIdSchema,
  type: z.string(),
  meta: z
    .object({
      trackNumber: z.number().int().positive(),
      volumeNumber: z.number().int().positive(),
    })
    .passthrough()
    .optional(),
})

export const TidalTrackResourceSchema = z.object({
  id: TidalIdSchema,
  type: z.literal('tracks'),
  attributes: z
    .object({
      title: text,
      version: z.string().max(255).nullable().optional(),
      isrc: z.string().max(40).nullable().optional(),
      duration: z.string().max(40).optional(),
      bpm: z.number().nullable().optional(),
      key: z.string().nullable().optional(),
      keyScale: z.string().nullable().optional(),
      popularity: z.number().min(0).max(1).nullable().optional(),
      availability: z.array(z.string()).nullable().optional(),
      externalLinks: z.array(ExternalLinkSchema).max(20).optional(),
    })
    .passthrough(),
  relationships: z
    .object({
      albums: z
        .object({ data: z.array(ItemIdentifierSchema).max(100).optional() })
        .passthrough()
        .optional(),
    })
    .passthrough()
    .optional(),
})
export type TidalTrackResource = z.infer<typeof TidalTrackResourceSchema>

export const TidalAlbumResourceSchema = z.object({
  id: TidalIdSchema,
  type: z.literal('albums'),
  attributes: z
    .object({
      title: text,
      barcodeId: z.string().max(40).nullable().optional(),
      albumType: z.enum(['ALBUM', 'EP', 'SINGLE']).nullable().optional(),
      numberOfItems: z.number().int().nonnegative().optional(),
      numberOfVolumes: z.number().int().nonnegative().optional(),
      releaseDate: z.string().max(40).nullable().optional(),
      duration: z.string().max(40).optional(),
      popularity: z.number().min(0).max(1).nullable().optional(),
      externalLinks: z.array(ExternalLinkSchema).max(20).optional(),
    })
    .passthrough(),
  relationships: z
    .object({
      items: z
        .object({
          data: z.array(ItemIdentifierSchema).max(100).optional(),
          links: LinksSchema.optional(),
        })
        .passthrough()
        .optional(),
    })
    .passthrough()
    .optional(),
})
export type TidalAlbumResource = z.infer<typeof TidalAlbumResourceSchema>

/** Included resources of types this app does not read are kept as they are. */
const IncludedSchema = z
  .array(
    z.union([
      TidalTrackResourceSchema,
      TidalAlbumResourceSchema,
      z.object({ id: z.string(), type: z.string() }).passthrough(),
    ]),
  )
  .max(1000)
  .default([])

/** `GET /albums?filter[barcodeId]=…&include=items` */
export const TidalAlbumsDocumentSchema = z.object({
  data: z.array(TidalAlbumResourceSchema).max(TIDAL_FILTER_LIMIT),
  included: IncludedSchema,
  links: LinksSchema.optional(),
})

/** `GET /albums/{id}/relationships/items?include=items` */
export const TidalAlbumItemsDocumentSchema = z.object({
  data: z.array(ItemIdentifierSchema).max(100),
  included: IncludedSchema,
  links: LinksSchema.optional(),
})

/** `GET /tracks?filter[isrc]=…&include=albums` */
export const TidalTracksDocumentSchema = z.object({
  data: z.array(TidalTrackResourceSchema).max(100),
  included: IncludedSchema,
  links: LinksSchema.optional(),
})

export function includedTracks(
  included: z.infer<typeof IncludedSchema>,
): Map<string, TidalTrackResource> {
  const tracks = new Map<string, TidalTrackResource>()
  for (const resource of included) {
    const track = TidalTrackResourceSchema.safeParse(resource)
    if (track.success) tracks.set(track.data.id, track.data)
  }
  return tracks
}

export function includedAlbums(
  included: z.infer<typeof IncludedSchema>,
): Map<string, TidalAlbumResource> {
  const albums = new Map<string, TidalAlbumResource>()
  for (const resource of included) {
    const album = TidalAlbumResourceSchema.safeParse(resource)
    if (album.success) albums.set(album.data.id, album.data)
  }
  return albums
}

/** The cursor of a relationship's next page, read from the server's link. */
export function nextPageCursor(
  links: z.infer<typeof LinksSchema> | undefined,
): string | null {
  if (links?.meta?.nextCursor) return links.meta.nextCursor
  if (!links?.next) return null
  const cursor = new URL(links.next, TIDAL_API_BASE).searchParams.get(
    'page[cursor]',
  )
  return cursor || null
}

const sharingUrl = (kind: 'album' | 'track', id: string) =>
  `https://tidal.com/browse/${kind}/${id}`

/** The album's or track's own TIDAL page. */
export function tidalUrl(
  kind: 'album' | 'track',
  resource: Pick<TidalAlbumResource | TidalTrackResource, 'id' | 'attributes'>,
): string {
  const link = resource.attributes.externalLinks?.find(
    (entry) => entry.meta?.type === 'TIDAL_SHARING',
  )?.href
  const expected = new RegExp(`^https://tidal\\.com/(?:browse/)?${kind}/\\d+`)
  return link && expected.test(link) ? link : sharingUrl(kind, resource.id)
}

/** What a library track keeps from a TIDAL track. */
export function tidalTrackData(track: TidalTrackResource): TidalTrackData {
  const { attributes } = track
  const key = TidalKeySchema.exclude(['UNKNOWN']).safeParse(attributes.key)
  const keyScale = TidalKeyScaleSchema.exclude(['UNKNOWN']).safeParse(
    attributes.keyScale,
  )
  const bpm = attributes.bpm
  return {
    url: tidalUrl('track', track),
    version: attributes.version?.trim() || null,
    durationSec: tidalDurationSec(attributes.duration),
    ...(typeof bpm === 'number' && bpm > 0 && bpm <= 1000 ? { bpm } : {}),
    ...(key.success ? { key: key.data } : {}),
    ...(keyScale.success ? { keyScale: keyScale.data } : {}),
    popularity: attributes.popularity ?? null,
  }
}

/** A track from an ISRC lookup, with the albums TIDAL included for it. */
export function tidalTrackCandidate(
  track: TidalTrackResource,
  albums: Map<string, TidalAlbumResource>,
): TidalTrackCandidate {
  return {
    ...tidalTrackData(track),
    tidalTrackId: track.id,
    title: track.attributes.title,
    isrc: track.attributes.isrc ?? null,
    streamable: track.attributes.availability?.includes('STREAM') ?? false,
    albums: (track.relationships?.albums?.data ?? [])
      .flatMap((reference) => {
        const album = albums.get(reference.id)
        return album
          ? [
              {
                tidalAlbumId: album.id,
                title: album.attributes.title,
                albumType: album.attributes.albumType ?? null,
                barcodeId: album.attributes.barcodeId ?? null,
                releaseDate: album.attributes.releaseDate ?? null,
              },
            ]
          : []
      })
      .slice(0, 20),
  }
}
