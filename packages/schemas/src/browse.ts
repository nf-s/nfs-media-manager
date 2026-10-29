import { z } from 'zod'
import type { AlbumListItem, FilmListItem } from './media'
import { isSpotifyAudioFeatureKey } from './audio-features'

export const RatingDisplaySchema = z.object({
  provider: z.string().min(1),
  compact: z.boolean().optional(),
  shortLabel: z.string().min(1).max(20).optional(),
  scale: z.number().finite().positive(),
  votesKey: z
    .string()
    .regex(/^[a-zA-Z][a-zA-Z0-9_.-]*$/)
    .optional(),
  iconUrl: z
    .string()
    .max(32768)
    .refine(
      (value) =>
        /^data:image\/(?:png|webp|gif|x-icon);base64,[A-Za-z0-9+/]+={0,2}$/.test(
          value,
        ) ||
        (z.string().url().safeParse(value).success &&
          value.startsWith('https://')),
      'Rating icons must be HTTPS URLs or embedded raster images',
    )
    .optional(),
})

export const BrowseFieldSchema = z.object({
  key: z
    .string()
    .regex(/^[a-zA-Z][a-zA-Z0-9_.-]*$/)
    .max(120),
  label: z.string().min(1),
  type: z.enum(['text', 'number', 'date']),
  format: z
    .enum([
      'number',
      'percent',
      'rating5',
      'rating10',
      'seconds',
      'minutes',
      'money',
      'db',
      'bpm',
    ])
    .optional(),
  filterable: z.boolean().default(true),
  rating: RatingDisplaySchema.optional(),
})
export type BrowseField = z.infer<typeof BrowseFieldSchema>
export const BrowseValueSchema = z.union([
  z.string(),
  z.number(),
  z.array(z.string()),
  z.null(),
])
export const BrowseValuesSchema = z.record(z.string(), BrowseValueSchema)
export type BrowseValues = z.infer<typeof BrowseValuesSchema>

const text = (key: string, label: string): BrowseField => ({
  key,
  label,
  type: 'text',
  filterable: true,
})
const number = (
  key: string,
  label: string,
  format: BrowseField['format'] = 'number',
): BrowseField => ({ key, label, type: 'number', format, filterable: true })
const date = (key: string, label: string): BrowseField => ({
  key,
  label,
  type: 'date',
  filterable: true,
})
const rating = (
  key: string,
  label: string,
  provider: string,
  scale: number,
  votesKey?: string,
  format: BrowseField['format'] = 'number',
): BrowseField => ({
  ...number(key, label, format),
  rating: { provider, scale, votesKey },
})

export const albumBrowseFields: BrowseField[] = [
  text('title', 'Title'),
  text('artist', 'Artists'),
  text('genre', 'Tags'),
  text('country', 'Countries'),
  text('playlist', 'Playlists'),
  text('collection', 'Collections'),
  text('source', 'Source'),
  text('provider', 'Provider'),
  date('releaseDate', 'Released'),
  date('dateAdded', 'Added'),
  number('durationSec', 'Duration', 'seconds'),
  number('scrobbles', 'Scrobbles'),
  rating('ratingRymValue', 'RYM rating', 'rym', 5, 'ratingRymVotes', 'rating5'),
  number('ratingRymVotes', 'RYM votes'),
  rating(
    'ratingDiscogsValue',
    'Discogs rating',
    'discogs',
    5,
    'ratingDiscogsVotes',
    'rating5',
  ),
  number('ratingDiscogsVotes', 'Discogs votes'),
  rating(
    'ratingMetacriticValue',
    'Metacritic rating',
    'metacritic',
    100,
    'ratingMetacriticVotes',
  ),
  number('ratingMetacriticVotes', 'Metacritic votes'),
  number('popularityDiscogs', 'Discogs popularity'),
  number('popularitySpotify', 'Spotify popularity'),
  number('popularityLastFm', 'Last.fm listeners'),
  number('trackCount', 'Tracks'),
]
export const filmBrowseFields: BrowseField[] = [
  { ...text('summary', 'Description'), filterable: false },
  text('title', 'Title'),
  text('director', 'Directors'),
  text('actor', 'Actors'),
  text('writer', 'Writers'),
  text('genre', 'Tags'),
  text('country', 'Countries'),
  text('language', 'Languages'),
  text('productionCompany', 'Production companies'),
  text('collection', 'Collections'),
  text('playlist', 'Playlists'),
  text('source', 'Source'),
  text('watched', 'Watched'),
  text('identification', 'Identification'),
  text('provider', 'Provider'),
  date('releaseDate', 'Released'),
  date('dateAdded', 'Added'),
  number('ratingImdbPersonal', 'My rating', 'rating10'),
  date('ratingImdbPersonalDate', 'Rated on'),
  rating(
    'ratingImdbValue',
    'IMDb rating',
    'imdb',
    10,
    'ratingImdbVotes',
    'rating10',
  ),
  number('ratingImdbVotes', 'IMDb votes'),
  rating('ratingMetascore', 'Metascore', 'metacritic', 100),
  rating(
    'ratingTmdbValue',
    'TMDb rating',
    'tmdb',
    10,
    'ratingTmdbVotes',
    'rating10',
  ),
  number('ratingTmdbVotes', 'TMDb votes'),
  number('popularityTmdb', 'TMDb popularity'),
  rating('ratingRt', 'Rotten Tomatoes', 'rottentomatoes', 100),
  rating(
    'ratingMetacriticUser',
    'Metacritic users',
    'metacriticuser',
    10,
    'ratingMetacriticUserVotes',
    'rating10',
  ),
  number('ratingMetacriticUserVotes', 'Metacritic user votes'),
  rating('ratingTrakt', 'Trakt', 'trakt', 100, 'ratingTraktVotes'),
  number('ratingTraktVotes', 'Trakt votes'),
  rating(
    'ratingLetterboxd',
    'Letterboxd',
    'letterboxd',
    5,
    'ratingLetterboxdVotes',
    'rating5',
  ),
  number('ratingLetterboxdVotes', 'Letterboxd votes'),
  rating(
    'ratingRtAudience',
    'Rotten Tomatoes audience',
    'rottentomatoes-audience',
    100,
    'ratingRtAudienceVotes',
  ),
  number('ratingRtAudienceVotes', 'Rotten Tomatoes audience votes'),
  number('runtimeMinutes', 'Runtime', 'minutes'),
  number('budget', 'Budget', 'money'),
  number('boxOffice', 'Box office', 'money'),
  { ...text('awards', 'Awards'), filterable: false },
  date('updatedAt', 'Updated'),
]

export function canonicalBrowseKey(key: string): string {
  return key === 'keyword' || key === 'tag' ? 'genre' : key
}

export const BrowseKeySchema = BrowseFieldSchema.shape.key
  .refine(
    (key) => !isSpotifyAudioFeatureKey(key),
    'Spotify audio features are no longer supported',
  )
  .transform(canonicalBrowseKey)
export const BrowseFilterSchema = z.object({
  field: BrowseKeySchema,
  value: z.string().min(1).max(1000),
  mode: z.enum(['any', 'required', 'exclude']).optional(),
})
export type BrowseFilter = z.infer<typeof BrowseFilterSchema>
export function sameBrowseFilter(
  left: BrowseFilter,
  right: BrowseFilter,
): boolean {
  const field = canonicalBrowseKey(left.field)
  if (field !== canonicalBrowseKey(right.field)) return false
  const normalize = (value: string) =>
    value.normalize('NFC').replace(/\s+/gu, ' ').trim().toLowerCase()
  return field === 'genre'
    ? normalize(left.value) === normalize(right.value)
    : left.value === right.value
}
export const BrowseRangeSchema = z
  .object({
    field: BrowseKeySchema,
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
    includeMissing: z.boolean().default(false),
  })
  .refine(
    (value) =>
      value.min === undefined ||
      value.max === undefined ||
      value.min <= value.max,
    'Minimum must not exceed maximum',
  )
export type BrowseRange = z.infer<typeof BrowseRangeSchema>
export const BrowseRangesParamSchema = z.preprocess((value) => {
  if (!value) return []
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}, z.array(BrowseRangeSchema).max(40))

export function getBrowseValues(
  item: AlbumListItem | FilmListItem,
): BrowseValues {
  const parsed = BrowseValuesSchema.safeParse(item.metadata?.browse)
  const values: BrowseValues = parsed.success ? parsed.data : {}
  delete values.keyword
  if (item.mediaType === 'album') {
    for (const key of Object.keys(values)) {
      if (isSpotifyAudioFeatureKey(key)) delete values[key]
    }
  }
  return {
    ...values,
    title: item.title,
    summary: item.summary,
    releaseDate: item.releaseDate ? Date.parse(item.releaseDate) : null,
    updatedAt: Date.parse(item.updatedAt),
    source:
      item.sourceLabel ?? (item.mediaType === 'film' ? item.sourceKind : null),
    artist: item.credits.filter((c) => c.role === 'artist').map((c) => c.name),
    director: item.credits
      .filter((c) => c.role === 'director')
      .map((c) => c.name),
    actor: item.credits.filter((c) => c.role === 'actor').map((c) => c.name),
    writer: item.credits.filter((c) => c.role === 'writer').map((c) => c.name),
    genre: [
      ...new Map(
        item.tags
          .filter((tag) => tag.name.trim())
          .map((tag) => [
            tag.name
              .normalize('NFC')
              .replace(/\s+/gu, ' ')
              .trim()
              .toLowerCase(),
            tag.name.normalize('NFC').replace(/\s+/gu, ' ').trim(),
          ]),
      ).values(),
    ],
    playlist: item.playlists
      .filter((p) => p.kind === 'playlist')
      .map((p) => p.name),
    collection: item.playlists
      .filter((p) => p.kind === 'collection')
      .map((p) => p.name),
    provider: [...new Set(item.providerReferences.map((p) => p.provider))],
    ...(item.mediaType === 'album'
      ? {
          dateAdded: item.dateAdded ? Date.parse(item.dateAdded) : null,
          durationSec: item.durationSec,
          trackCount: item.trackCount,
        }
      : {
          dateAdded: Date.parse(item.dateAdded ?? item.createdAt),
          runtimeMinutes: item.runtimeMinutes,
          watched: item.watched ? 'Yes' : 'No',
          identification: filmIdentificationStatus(item.providerReferences),
          budget: item.budget,
          boxOffice: item.boxOffice,
        }),
  }
}

export function filmIdentificationStatus(
  references: Array<{ referenceType: string; externalId: string }>,
): 'Identified' | 'Needs ID' {
  return references.some(
    (ref) =>
      (ref.referenceType === 'imdb' && /^tt\d+$/.test(ref.externalId)) ||
      (ref.referenceType === 'tmdb' && /^\d+$/.test(ref.externalId)),
  )
    ? 'Identified'
    : 'Needs ID'
}

export function formatBrowseValue(
  field: BrowseField,
  value: BrowseValues[string] | undefined,
): string {
  if (value === null || value === undefined) return '-'
  if (Array.isArray(value)) return value.join(', ')
  if (typeof value !== 'number') return value
  if (field.type === 'date') {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? '-' : date.toISOString().slice(0, 10)
  }
  const formatted = new Intl.NumberFormat('en', {
    maximumFractionDigits: 2,
  }).format(value)
  switch (field.format) {
    case 'percent':
      return `${(value * 100).toFixed(1)}%`
    case 'rating5':
      return `${formatted}/5`
    case 'rating10':
      return `${formatted}/10`
    case 'seconds':
      return `${Math.floor(value / 60)}m ${Math.round(value % 60)}s`
    case 'minutes':
      return `${formatted}m`
    case 'money':
      return `$${formatted}`
    case 'db':
      return `${formatted} dB`
    case 'bpm':
      return `${formatted} BPM`
    default:
      return formatted
  }
}
