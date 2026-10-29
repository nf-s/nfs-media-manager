import { z } from 'zod'
import {
  JsonValueSchema,
  type PluginResult,
  type PluginTag,
  type JsonValue,
  type PluginLink,
} from '@repo/media-plugin-sdk'
import { isJsonRecord } from '@/lib/provider-normalizers'

const MdblistMovieSchema = z.object({
  type: z.literal('movie'),
  ids: z
    .object({
      imdb: z
        .string()
        .regex(/^tt\d+$/)
        .nullable()
        .optional(),
      tmdb: z.number().int().positive().nullable().optional(),
      trakt: z.number().int().positive().nullable().optional(),
    })
    .optional(),
  imdb_id: z
    .string()
    .regex(/^tt\d+$/)
    .nullable()
    .optional(),
  imdbid: z
    .string()
    .regex(/^tt\d+$/)
    .nullable()
    .optional(),
  tmdbid: z.number().int().positive().nullable().optional(),
  // Maintainer API examples define keyword objects; missing data must not clear tags.
  keywords: z.array(
    z.object({ id: z.number().int().positive(), name: z.string() }),
  ),
  ratings: z
    .array(
      z.object({
        source: z.string(),
        value: z.number().finite().nullable().optional(),
        score: z.number().finite().min(0).max(100).nullable().optional(),
        votes: z.number().int().nonnegative().nullable().optional(),
        url: z.union([z.string(), z.number()]).nullable().optional(),
      }),
    )
    .optional(),
})

const ratingSources: Record<
  string,
  {
    key: string
    provider: string
    label: string
    scale: number
    valueScale: number
    origin: string
    path: string
  }
> = {
  metacriticuser: {
    key: 'ratingMetacriticUser',
    provider: 'metacriticuser',
    label: 'Metacritic users',
    scale: 10,
    valueScale: 10,
    origin: 'https://www.metacritic.com',
    path: '/movie/',
  },
  trakt: {
    key: 'ratingTrakt',
    provider: 'trakt',
    label: 'Trakt',
    scale: 100,
    valueScale: 100,
    origin: 'https://trakt.tv',
    path: '/movies/',
  },
  letterboxd: {
    key: 'ratingLetterboxd',
    provider: 'letterboxd',
    label: 'Letterboxd',
    scale: 5,
    valueScale: 5,
    origin: 'https://letterboxd.com',
    path: '/film/',
  },
  popcorn: {
    key: 'ratingRtAudience',
    provider: 'rottentomatoes-audience',
    label: 'Rotten Tomatoes audience',
    scale: 100,
    valueScale: 100,
    origin: 'https://www.rottentomatoes.com',
    path: '/m/',
  },
}

function ratingLink(
  raw: string | number | null | undefined,
  spec: { origin: string; path: string },
): string | undefined {
  if (typeof raw !== 'string' || !raw.trim() || raw.startsWith('//'))
    return undefined
  const parsed = z.string().url().safeParse(raw)
  if (!parsed.success && !/^\/?[a-zA-Z0-9/_-]+\/?$/.test(raw)) return undefined
  const url = parsed.success
    ? new URL(parsed.data)
    : new URL(
        raw.startsWith(spec.path)
          ? raw
          : `${spec.path}${raw.replace(/^\//, '')}`,
        spec.origin,
      )
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hostname.replace(/^www\./, '') !==
      new URL(spec.origin).hostname.replace(/^www\./, '') ||
    !url.pathname.startsWith(spec.path)
  )
    return undefined
  return url.toString()
}

// Exact custom tokens documented at https://docs.mdblist.com/docs/keywords.
const mdblistCustomKeywords = new Set([
  '4k-blu-ray',
  'dolby-vision',
  'dolby-vision-cp',
  'dolby-atmos',
  'has-trailer',
  'bollywood',
  'imdb-tv-movie',
  'imdb-video-game',
  'imdb-short',
  'imdb-tv-special',
  'imdb-video',
  'imdb-tv-mini-series',
  'hallmark',
  'certified-fresh',
  'rotten',
  'fresh',
  'one-actor',
  'two-actors',
  'three-actors',
  'metacritic-must-see',
  'belongs-to-collection',
  'first-in-collection',
  'collection-follow-up',
  'anime-dub',
  'certified-hot',
  'christmas-movie',
  'roger-ebert-thumbs-down',
  'bottom-100',
  'bottom-250',
  'best-picture-winner',
  'best-picture-nominated',
  'oscar-winner',
  'oscar-nominated',
  'oscar-best-director-winner',
  'oscar-best-director-nominee',
  'emmy-award-winner',
  'emmy-award-nominated',
  'golden-globe-winner',
  'golden-globe-nominated',
  'festival-sundance-winner',
  'festival-cannes-winner',
  'festival-venice-winner',
  'festival-toronto-winner',
  'festival-berlin-winner',
  'national-film-preservation-board-winner',
  'razzie-winner',
  'razzie-nominee',
])

function normalizeKeyword(rawName: string, id: number): PluginTag | null {
  const token = rawName.trim()
  const prefix = /^(imdb|tmdb|trakt|mdblist)\.([^.]+)$/i.exec(token)
  const source =
    prefix?.[1]?.toLowerCase() ??
    (mdblistCustomKeywords.has(token.toLowerCase()) ? 'mdblist' : 'unknown')
  const name = (prefix?.[2] ?? token)
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (!name || name === 'N/A' || /^(imdb|tmdb|trakt|mdblist)\.$/i.test(token))
    return null

  return { name, kind: 'keyword', source, rawName, sourceId: `mdblist:${id}` }
}

export function normalizeMdblistPayload(
  value: unknown,
  expectedIds: { imdb?: string; tmdb?: string } = {},
): PluginResult {
  const payload = JsonValueSchema.parse(value)

  if (!isJsonRecord(payload)) {
    throw new Error('MDBList returned a non-object payload.')
  }
  if (
    'error' in payload &&
    payload['error'] !== null &&
    payload['error'] !== false
  ) {
    throw new Error('MDBList returned a service error.')
  }

  const parsed = MdblistMovieSchema.safeParse(payload)
  if (!parsed.success) {
    throw new Error('MDBList returned an invalid movie or keyword payload.')
  }
  const imdbIds = [
    parsed.data.ids?.imdb,
    parsed.data.imdb_id,
    parsed.data.imdbid,
  ].filter((id) => id !== undefined && id !== null)
  const tmdbIds = [parsed.data.ids?.tmdb, parsed.data.tmdbid]
    .filter((id) => id !== undefined && id !== null)
    .map(String)
  for (const [expected, ids] of [
    [expectedIds.imdb, imdbIds],
    [expectedIds.tmdb, tmdbIds],
  ] satisfies Array<[string | undefined, string[]]>) {
    if (expected && (!ids.length || ids.some((id) => id !== expected))) {
      throw new Error(
        'MDBList returned a different or missing lookup identifier.',
      )
    }
  }

  const browse: Record<string, JsonValue> = {}
  const links: PluginLink[] = []
  for (const rating of parsed.data.ratings ?? []) {
    const source = ['tomatoesaudience', 'audience'].includes(rating.source)
      ? 'popcorn'
      : rating.source
    const spec = ratingSources[source]
    if (!spec) continue
    const value =
      rating.score != null
        ? (rating.score * spec.scale) / 100
        : rating.value != null &&
            rating.value >= 0 &&
            rating.value <= spec.valueScale
          ? (rating.value * spec.scale) / spec.valueScale
          : null
    browse[spec.key] = value === null ? null : Math.round(value * 100) / 100
    browse[`${spec.key}Votes`] = rating.votes ?? null
    const sibling =
      source === 'metacriticuser'
        ? 'metacritic'
        : source === 'popcorn'
          ? 'tomatoes'
          : undefined
    const href =
      ratingLink(rating.url, spec) ??
      ratingLink(
        parsed.data.ratings?.find((entry) => entry.source === sibling)?.url,
        spec,
      ) ??
      (source === 'trakt' && parsed.data.ids?.trakt
        ? `${spec.origin}/movies/${parsed.data.ids.trakt}`
        : undefined)
    if (href)
      links.push({ provider: spec.provider, label: spec.label, url: href })
  }

  return {
    payload,
    normalized: {
      ...(Object.keys(browse).length
        ? { mediaPatch: { metadata: { browse } } }
        : {}),
      tags: parsed.data.keywords.flatMap(({ name, id }) => {
        const tag = normalizeKeyword(name, id)
        return tag ? [tag] : []
      }),
      references: [],
      links,
      credits: [],
      tracks: [],
      playlists: [],
    },
  }
}
