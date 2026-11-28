import { z } from 'zod'
import { CatalogScopeQuerySchema } from './catalog'
import type { AlbumListItem, FilmListItem } from './media'
import { isSpotifyAudioFeatureKey } from './audio-features'
import { musicDisplayTags } from './music-tags'
import { formatTagName } from './tags'
import { formatMusicalKey, keyDisplayNotation } from './musical-keys'

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

/** Where a Tags filter reads tags: the track's own, its album's, its artists'. */
export const TagLevelSchema = z.enum(['track', 'album', 'artist'])
export type TagLevel = z.infer<typeof TagLevelSchema>
export const tagLevelOrder = TagLevelSchema.options
/**
 * A Tags filter location other than Auto: distinct levels, in the order
 * track, album, artist. Auto, the default, is no value.
 */
export const TagLevelsSchema = z
  .array(TagLevelSchema)
  .min(1)
  .max(tagLevelOrder.length)
  .refine(
    (levels) => new Set(levels).size === levels.length,
    'Each tag level once',
  )
  .transform((levels) =>
    tagLevelOrder.filter((level) => levels.includes(level)),
  )
export type TagLevels = z.infer<typeof TagLevelsSchema>
/** The `tagLevels` URL parameter: `track,album`; left out for Auto. */
export const TagLevelsParamSchema = z.preprocess(
  (value) =>
    typeof value === 'string'
      ? value.length
        ? value.split(',')
        : undefined
      : value,
  TagLevelsSchema.optional(),
)
export function formatTagLevelsParam(levels: TagLevels | undefined) {
  return levels?.join(',') ?? null
}

export const BrowseFacetQuerySchema = z.object({
  ...CatalogScopeQuerySchema.shape,
  q: z.string().max(200).trim().optional(),
  limitPerField: z.coerce.number().int().min(1).max(50).default(25),
  tagLevels: TagLevelsParamSchema,
})
export type BrowseFacetQuery = z.infer<typeof BrowseFacetQuerySchema>
/** Albums and Films: suggestions count archived items when the list includes them. */
export const ArchivableBrowseFacetQuerySchema = BrowseFacetQuerySchema.extend({
  includeArchived: z.enum(['true', 'false']).optional(),
})
export type ArchivableBrowseFacetQuery = z.infer<
  typeof ArchivableBrowseFacetQuerySchema
>

export const BrowsePageSliceSchema = <T extends z.ZodTypeAny>(itemSchema: T) =>
  z.object({
    items: z.array(itemSchema),
    page: z.number().int().positive(),
    size: z.number().int().positive(),
    hasMore: z.boolean(),
  })

export const BrowseCountSchema = z.object({
  totalCount: z.number().int().nonnegative(),
  /** The count after Clear filters: the same library and archived state without search, filters, ranges or limits. */
  unfilteredCount: z.number().int().nonnegative().optional(),
})

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

/** Albums Edition: whether an album is an edition of another album. */
export const albumEditionLabels = {
  edition: 'Edition of another album',
  notEdition: 'Not an edition',
}

export const albumBrowseFields: BrowseField[] = [
  text('title', 'Title'),
  text('artist', 'Artists'),
  text('genre', 'Tags'),
  text('albumTag', 'Album tags'),
  text('artistTag', 'Artist tags'),
  text('country', 'Countries'),
  text('playlist', 'Playlists'),
  text('collection', 'Collections'),
  text('source', 'Source'),
  text('provider', 'Provider'),
  text('edition', 'Edition'),
  date('releaseDate', 'Released'),
  date('dateAdded', 'Added'),
  number('durationSec', 'Duration', 'seconds'),
  number('scrobbles', 'Scrobbles'),
  date('lastListenedAt', 'Last listened'),
  number('scrobblesLast1y', 'Scrobbles, last year'),
  number('scrobblesLast5y', 'Scrobbles, last 5 years'),
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
export const trackBrowseFields: BrowseField[] = [
  text('title', 'Title'),
  text('source', 'Source'),
  text('spotifyMatch', 'Spotify match'),
  text('provider', 'Provider'),
  text('artist', 'Artists'),
  text('album', 'Album'),
  text('playlist', 'Playlists'),
  text('genre', 'Tags'),
  text('trackTag', 'Track tags'),
  text('albumTag', 'Album tags'),
  text('artistTag', 'Artist tags'),
  text('albumLink', 'Library album'),
  // Yes when the track has tags of its own in Browse (has_own_tags).
  text('hasTrackTags', 'Has track tags'),
  date('releaseDate', 'Released'),
  date('dateAdded', 'Added'),
  number('durationSec', 'Duration', 'seconds'),
  number('bpm', 'Tempo', 'bpm'),
  text('musicalKey', 'Key'),
  number('scrobbles', 'Scrobbles'),
  date('lastListenedAt', 'Last listened'),
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

/** Whether a field's values are tag names, matched whatever their case. */
export function isTagBrowseField(key: string): boolean {
  return ['genre', 'trackTag', 'albumTag', 'artistTag'].includes(
    canonicalBrowseKey(key),
  )
}

/** A filter value as the interface shows it: a tag in its display form, a key in the chosen notation. */
export function formatBrowseFilterValue(field: string, value: string): string {
  if (field === 'musicalKey')
    return formatMusicalKey(value, keyDisplayNotation())
  return isTagBrowseField(field) ? formatTagName(value) : value
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

/** The libraries that have playlists made in the app. Artists have none. */
export const LibraryPlaylistLibrarySchema = z.enum([
  'albums',
  'tracks',
  'films',
  'subscriptions',
  'mixes',
])
export type LibraryPlaylistLibrary = z.infer<
  typeof LibraryPlaylistLibrarySchema
>

/** A playlist holds entries; a smart playlist lists what its view matches. */
export const LibraryPlaylistTypeSchema = z.enum(['playlist', 'smart'])
export type LibraryPlaylistType = z.infer<typeof LibraryPlaylistTypeSchema>

/**
 * A saved view: Browse URL parameter names and their URL values, such as
 * `filters` as its JSON string. Validated against the library's Browse query.
 */
export const LibraryPlaylistViewSchema = z
  .record(z.string().min(1).max(64), z.string().max(20_000))
  .refine((view) => Object.keys(view).length <= 40, 'Too many parameters')
export type LibraryPlaylistView = z.infer<typeof LibraryPlaylistViewSchema>

/**
 * PL-18: the Browse filter on a library playlist of the library, by its ID.
 * Every library accepts it; it is not a field, so it has no column,
 * suggestions or search, and AI search does not offer it.
 */
export const LIBRARY_PLAYLIST_FILTER_FIELD = 'libraryPlaylist'

/** Providers explicitly included in the current Browse selection, in chip order. */
export function selectedBrowseProviders(filters: readonly BrowseFilter[]) {
  return [
    ...new Set(
      filters
        .filter(
          (filter) => filter.field === 'provider' && filter.mode !== 'exclude',
        )
        .map((filter) => filter.value.toLowerCase()),
    ),
  ]
}

export function sameBrowseFilter(
  left: BrowseFilter,
  right: BrowseFilter,
): boolean {
  const field = canonicalBrowseKey(left.field)
  if (field !== canonicalBrowseKey(right.field)) return false
  const normalize = (value: string) =>
    value.normalize('NFC').replace(/\s+/gu, ' ').trim().toLowerCase()
  return isTagBrowseField(field)
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
    genre:
      item.mediaType === 'album'
        ? musicDisplayTags(
            item.tags.map((tag) => tag.name),
            item.artistTags,
          ).map((tag) => tag.name)
        : [
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
          edition: item.editionOfId
            ? albumEditionLabels.edition
            : albumEditionLabels.notEdition,
          albumTag: item.tags.map((tag) => tag.name),
          artistTag: item.artistTags,
          dateAdded: item.dateAdded ? Date.parse(item.dateAdded) : null,
          durationSec: item.durationSec,
          trackCount: item.trackCount,
          listeningScrobbles: item.listeningScrobbles ?? null,
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
  if (Array.isArray(value))
    return value
      .map((entry) => formatBrowseFilterValue(field.key, entry))
      .join(', ')
  if (typeof value !== 'number')
    return formatBrowseFilterValue(field.key, value)
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
