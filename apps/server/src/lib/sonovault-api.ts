import { z } from 'zod'
import type {
  MediaPluginTestContext,
  MediaProviderPlugin,
} from '@repo/media-plugin-sdk'
import {
  SONOVAULT_BULK_LIMIT,
  SONOVAULT_DEFAULT_CREDIT_RESERVE,
  SONOVAULT_DEFAULT_MONTHLY_CREDITS,
  SONOVAULT_DEFAULT_REQUESTS_PER_MINUTE,
} from '@repo/schemas/sonovault'

/**
 * The Sonovault API: its payload schemas and client calls, shared by every
 * Sonovault stage. Later stages import these rather than writing their own.
 * Specification: https://sonovault.now/openapi.json
 */

export type SonovaultRequest = MediaPluginTestContext['request']

export const SONOVAULT_API_BASE = 'https://api.sonovault.now'
/** Requests start at least this far apart, whatever the plan allows (SONO-02). */
export const SONOVAULT_MIN_SPACING_MS = 1100

const name = z.string().max(2000)
const date = z.string().max(40).nullable()

export const SonovaultArtistRefSchema = z.object({
  id: z.number().int(),
  name,
})
export const SonovaultLabelRefSchema = z.object({
  id: z.number().int(),
  name,
})

/** One measured key in all three notations, with the tool that measured it. */
export const SonovaultTrackKeySchema = z.object({
  key_alphanumeric: z.string().max(10),
  key_musical: z.string().max(10),
  key_open: z.string().max(10),
  source: z.string().max(100),
})

export const SonovaultTrackArtistSchema = SonovaultArtistRefSchema.extend({
  is_primary: z.boolean(),
  is_remixer: z.boolean(),
})

/** A release as embedded in a track object. */
export const SonovaultTrackReleaseSchema = z.object({
  id: z.number().int(),
  title: name,
  artist: SonovaultArtistRefSchema,
  label: SonovaultLabelRefSchema.nullable(),
  release_date: date,
})

/** Fields a track shares with a release's track. */
const trackFields = {
  id: z.number().int(),
  title: name,
  duration: z.number().int().nonnegative().nullable(),
  isrc: z.string().max(40).nullable(),
  bpm: z.number().nonnegative().max(1000).nullable(),
  key_alphanumeric: z.string().max(10).nullable(),
  key_musical: z.string().max(10).nullable(),
  key_open: z.string().max(10).nullable(),
  keys: z.array(SonovaultTrackKeySchema).max(50),
  artists: z.array(SonovaultTrackArtistSchema).max(200),
  genre: z.array(z.string().max(200)).max(50),
  subgenre: z.array(z.string().max(200)).max(50),
}

/** The track shape of resolve, search and lookups (OpenAPI `Track`). */
export const SonovaultTrackSchema = z.object({
  ...trackFields,
  releases: z.array(SonovaultTrackReleaseSchema).max(50),
})
export type SonovaultTrack = z.infer<typeof SonovaultTrackSchema>

export const SonovaultLinkSourceSchema = z.enum([
  'spotify',
  'beatport',
  'discogs',
  'musicbrainz',
  'applemusic',
  'tidal',
  'youtube',
])
export type SonovaultLinkSource = z.infer<typeof SonovaultLinkSourceSchema>

/** A track's ID on another service (OpenAPI `PlatformLink`). */
export const SonovaultLinkSchema = z.object({
  source: SonovaultLinkSourceSchema,
  external_id: z.string().min(1).max(500),
  url: z.string().max(2000).nullable(),
})
export type SonovaultLink = z.infer<typeof SonovaultLinkSchema>

export const SonovaultResolveStatusSchema = z.enum([
  'matched',
  'not_found',
  'skipped_no_credits',
])

/** An artist-and-title input line, as sent and as echoed back. */
export const SonovaultTrackNameInputSchema = z.object({
  artist: z.string().max(2000),
  title: z.string().max(2000),
})

/** One line of a bulk resolve response (OpenAPI `ResolveResult`). */
export const SonovaultResolveResultSchema = z.object({
  /** The input as sent: a string, or the artist and title of a `track_name` line. */
  input: z.union([z.string().max(2000), SonovaultTrackNameInputSchema]),
  status: SonovaultResolveStatusSchema,
  track: SonovaultTrackSchema.nullable(),
  links: z.array(SonovaultLinkSchema).max(50),
})
export type SonovaultResolveResult = z.infer<
  typeof SonovaultResolveResultSchema
>

export const SonovaultBulkResolveResponseSchema = z.object({
  results: z.array(SonovaultResolveResultSchema).max(SONOVAULT_BULK_LIMIT),
  partial: z.boolean(),
  processed: z.number().int().nonnegative(),
  credits_used: z.number().int().nonnegative(),
  credits_remaining: z.number().int().nonnegative(),
  message: z.string().max(2000).nullable(),
})
export type SonovaultBulkResolveResponse = z.infer<
  typeof SonovaultBulkResolveResponseSchema
>

/** A track as embedded in a release, with its position (OpenAPI `ReleaseTrack`). */
export const SonovaultReleaseTrackSchema = z.object({
  ...trackFields,
  disc_number: z.number().int().nullable(),
  track_number: z.number().int().nullable(),
})

export type SonovaultReleaseTrack = z.infer<typeof SonovaultReleaseTrackSchema>

/**
 * A library track's own Sonovault record as Sonovault returned it, kept on
 * its lookup row (SONO-05): its result line from a bulk lookup, or its entry
 * on an album's confirmed release.
 */
export const SonovaultStoredRecordSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('resolve'),
    track: SonovaultTrackSchema,
    links: z.array(SonovaultLinkSchema).max(50),
  }),
  z.object({
    kind: z.literal('release'),
    releaseId: z.number().int().positive(),
    track: SonovaultReleaseTrackSchema,
  }),
])
export type SonovaultStoredRecord = z.infer<typeof SonovaultStoredRecordSchema>

/** One provider's listing of a release (OpenAPI `ReleaseEdition`). */
export const SonovaultReleaseEditionSchema = z.object({
  id: z.number().int(),
  source: z.enum([
    'spotify',
    'discogs',
    'musicbrainz',
    'beatport',
    'applemusic',
  ]),
  external_id: z.string().min(1).max(500),
  group_external_id: z.string().max(500).nullable(),
  title: name.nullable(),
  edition_kind: z
    .enum([
      'album',
      'single',
      'ep',
      'compilation',
      'live',
      'remix',
      'soundtrack',
      'other',
    ])
    .nullable(),
  format: z
    .enum(['cd', 'vinyl', 'cassette', 'digital', 'dvd', 'mixed', 'other'])
    .nullable(),
  official: z.boolean().nullable(),
  release_date: date,
  date_precision: z.enum(['day', 'month', 'year']).nullable(),
  barcode: z.string().max(100).nullable(),
  country: z.string().max(200).nullable(),
  medium_count: z.number().int().nullable(),
  track_count: z.number().int().nullable(),
  tracks_on_row: z.number().int(),
  label: SonovaultLabelRefSchema.nullable(),
  catalog_no: z.string().max(500).nullable(),
})

/** `GET /v1/releases/{id}`. */
export const SonovaultReleaseSchema = z.object({
  id: z.number().int(),
  title: name,
  artist: SonovaultArtistRefSchema,
  label: SonovaultLabelRefSchema.nullable(),
  release_date: date,
  catalog_no: z.string().max(500).nullable(),
  musicbrainz_release_ids: z.array(z.string().max(100)).max(500),
  musicbrainz_release_group_ids: z.array(z.string().max(100)).max(100),
  tracks: z.array(SonovaultReleaseTrackSchema).max(2000),
  editions: z.array(SonovaultReleaseEditionSchema).max(50),
  edition: z.number().int().nullable(),
  digital_upc: z.string().max(40).nullable(),
})
export type SonovaultRelease = z.infer<typeof SonovaultReleaseSchema>

export const SonovaultBarcodeResponseSchema = z.object({
  upc: z.string().regex(/^\d{8,14}$/),
  results: z.array(z.object({ id: z.number().int().positive() })).max(25),
})

/** `GET /v1/releases/search`: list entries carry no catalogue number or UPC. */
export const SonovaultReleaseSearchResponseSchema = z.object({
  results: z
    .array(
      z.object({
        id: z.number().int(),
        title: name,
        artist: SonovaultArtistRefSchema.optional(),
        label: SonovaultLabelRefSchema.nullable(),
        release_date: date,
      }),
    )
    .max(100),
  next_cursor: z.string().max(500).nullable(),
})

/** Every input type the bulk call takes. Artist-and-title pairs are objects. */
export const SonovaultResolveInputTypeSchema = z.enum([
  'isrc',
  'sonovault_id',
  'spotify_id',
  'applemusic_id',
  'tidal_id',
  'beatport_id',
  'discogs_id',
  'musicbrainz_id',
  'track_name',
])
export type SonovaultResolveInputType = z.infer<
  typeof SonovaultResolveInputTypeSchema
>
const ResolveItemsSchema = z.union([
  z.array(z.string().trim().min(1).max(500)).min(1).max(SONOVAULT_BULK_LIMIT),
  z
    .array(
      z.object({
        artist: z.string().trim().min(1).max(500),
        title: z.string().trim().min(1).max(500),
      }),
    )
    .min(1)
    .max(SONOVAULT_BULK_LIMIT),
])
export type SonovaultResolveItems = z.infer<typeof ResolveItemsSchema>

const positiveSetting = (
  secrets: Record<string, string>,
  key: string,
  fallback: number,
  label: string,
  minimum: number,
) => {
  const value = secrets[key]?.trim()
  if (!value) return fallback
  const parsed = z.coerce
    .number()
    .int()
    .min(minimum)
    .max(10_000_000)
    .safeParse(value)
  if (!parsed.success)
    throw new Error(`Sonovault ${label} must be a whole number`)
  return parsed.data
}

/** The API key and plan limits from Providers → Sonovault → Settings. */
export function sonovaultSettings(secrets: Record<string, string>) {
  const apiKey = secrets['apiKey']?.trim()
  if (!apiKey) throw new Error('The Sonovault API key is missing')
  return {
    apiKey,
    requestsPerMinute: positiveSetting(
      secrets,
      'requestsPerMinute',
      SONOVAULT_DEFAULT_REQUESTS_PER_MINUTE,
      'requests per minute',
      1,
    ),
    monthlyCredits: positiveSetting(
      secrets,
      'monthlyCredits',
      SONOVAULT_DEFAULT_MONTHLY_CREDITS,
      'monthly credits',
      1,
    ),
    creditReserve: positiveSetting(
      secrets,
      'creditReserve',
      SONOVAULT_DEFAULT_CREDIT_RESERVE,
      'credit reserve',
      0,
    ),
  }
}
export type SonovaultSettings = ReturnType<typeof sonovaultSettings>

/**
 * The plugin with its request spacing set from the plan's requests per
 * minute: never closer than 1.1 seconds.
 */
export function sonovaultGatedPlugin(
  plugin: MediaProviderPlugin,
  settings: Pick<SonovaultSettings, 'requestsPerMinute'>,
): MediaProviderPlugin {
  const minTimeMs = Math.max(
    SONOVAULT_MIN_SPACING_MS,
    Math.ceil(60000 / settings.requestsPerMinute),
  )
  return {
    ...plugin,
    manifest: {
      ...plugin.manifest,
      rateLimit: { ...plugin.manifest.rateLimit, minTimeMs },
    },
  }
}

async function sonovaultJson(
  request: SonovaultRequest,
  apiKey: string,
  path: string,
  init: {
    method?: 'GET' | 'POST'
    params?: [string, string][]
    body?: unknown
    notFoundOn404?: boolean
  } = {},
): Promise<unknown> {
  if (!path.startsWith('/v1/')) throw new Error('Invalid Sonovault path')
  const url = new URL(`${SONOVAULT_API_BASE}${path}`)
  for (const [key, value] of init.params ?? [])
    url.searchParams.append(key, value)
  const response = await request(
    url,
    {
      method: init.method ?? 'GET',
      headers: {
        Accept: 'application/json',
        'x-api-key': apiKey,
        ...(init.body === undefined
          ? {}
          : { 'Content-Type': 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    },
    init.notFoundOn404 ? { notFoundOn404: true } : undefined,
  )
  if (!response.ok)
    throw new Error(`Sonovault request failed (HTTP ${response.status})`)
  try {
    return await response.json()
  } catch {
    throw new Error('Sonovault returned an invalid response')
  }
}

/** Find release IDs by exact barcode. A missing barcode is a catalog miss. */
export async function findSonovaultReleasesByBarcode(
  request: SonovaultRequest,
  apiKey: string,
  barcode: string,
) {
  const code = z
    .string()
    .regex(/^\d{8,14}$/)
    .parse(barcode)
  return SonovaultBarcodeResponseSchema.parse(
    await sonovaultJson(request, apiKey, `/v1/releases/upc/${code}`, {
      notFoundOn404: true,
    }),
  )
}

/**
 * `POST /v1/tracks/resolve`: up to 100 inputs of one type, answered in input
 * order. One credit is charged per input line. Returns the raw payload with
 * its parsed form, so a caller can store exactly what was received.
 */
export async function resolveSonovaultTracks(
  request: SonovaultRequest,
  apiKey: string,
  inputType: SonovaultResolveInputType,
  items: SonovaultResolveItems,
) {
  const type = SonovaultResolveInputTypeSchema.parse(inputType)
  const parsedItems = ResolveItemsSchema.parse(items)
  const pairs = typeof parsedItems[0] === 'object'
  if (pairs !== (type === 'track_name'))
    throw new Error(
      'Sonovault artist-and-title inputs need input type track_name',
    )
  const raw = await sonovaultJson(request, apiKey, '/v1/tracks/resolve', {
    method: 'POST',
    body: { input_type: type, items: parsedItems },
  })
  const parsed = SonovaultBulkResolveResponseSchema.parse(raw)
  if (parsed.results.length !== parsedItems.length)
    throw new Error('Sonovault answered a different number of lines')
  return parsed
}

/** `GET /v1/releases/{id}`, in one edition's numbering when `edition` is set. */
export async function getSonovaultRelease(
  request: SonovaultRequest,
  apiKey: string,
  releaseId: number,
  edition?: number,
) {
  const id = z.number().int().positive().parse(releaseId)
  return SonovaultReleaseSchema.parse(
    await sonovaultJson(request, apiKey, `/v1/releases/${id}`, {
      params:
        edition === undefined
          ? []
          : [['edition', String(z.number().int().positive().parse(edition))]],
    }),
  )
}

/** `GET /v1/releases/search` by title, optionally filtered by artist. */
export async function searchSonovaultReleases(
  request: SonovaultRequest,
  apiKey: string,
  input: { title: string; artist?: string; limit?: number; cursor?: string },
) {
  const query = z
    .object({
      title: z.string().trim().min(1).max(500),
      artist: z.string().trim().min(1).max(500).optional(),
      limit: z.number().int().min(1).max(100).optional(),
      cursor: z.string().min(1).max(500).optional(),
    })
    .parse(input)
  const params: [string, string][] = [['title', query.title]]
  if (query.artist) params.push(['artist', query.artist])
  if (query.limit) params.push(['limit', String(query.limit)])
  if (query.cursor) params.push(['cursor', query.cursor])
  return SonovaultReleaseSearchResponseSchema.parse(
    await sonovaultJson(request, apiKey, '/v1/releases/search', { params }),
  )
}

/** `GET /v1/genres`: a small read used to test the key. */
export async function testSonovaultKey(
  request: SonovaultRequest,
  apiKey: string,
) {
  await sonovaultJson(request, apiKey, '/v1/genres')
}

/** The reference type a link is stored under (SONO-05). */
export const sonovaultLinkReferenceTypes = {
  spotify: 'spotify-track',
  applemusic: 'applemusic-track',
  tidal: 'tidal-track',
  beatport: 'beatport-track',
  musicbrainz: 'musicbrainz-recording',
  discogs: 'discogs-release-track',
  youtube: 'youtube-video',
} as const satisfies Record<SonovaultLinkSource, string>

/** An https link to the service page, or null. */
export function sonovaultLinkUrl(link: SonovaultLink): string | null {
  if (!link.url) return null
  try {
    const url = new URL(link.url)
    return url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}
