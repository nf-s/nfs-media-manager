import { z } from 'zod'
import { SourceNavigationLinkSchema } from './tags'
import { AlbumProviderDetailsSchema } from './album-provider-details'
import {
  BrowseFilterSchema,
  BrowseKeySchema,
  BrowseRangesParamSchema,
  albumBrowseFields,
  filmBrowseFields,
} from './browse'
import {
  CreditSchema,
  DirectionSchema,
  ExternalLinkSchema,
  JsonValueSchema,
  MediaTypeSchema,
  PaginationQuerySchema,
  PlaylistMembershipSchema,
  ProviderReferenceSchema,
  ProviderReferenceOverrideSchema,
  TagSchema,
} from './common'

export { MediaTypeSchema } from './common'

export const AlbumSortSchema = BrowseKeySchema
export const FilmSortSchema = BrowseKeySchema
export const AlbumBrowseFilterFieldSchema = BrowseKeySchema
export const FilmBrowseFilterFieldSchema = BrowseKeySchema
export const AlbumBrowseFilterSchema = BrowseFilterSchema
export const FilmBrowseFilterSchema = BrowseFilterSchema

function createSerializedArrayQuerySchema<T>(itemSchema: z.ZodType<T>) {
  return z.preprocess((value) => {
    if (typeof value !== 'string' || value.length === 0) {
      return []
    }

    try {
      return JSON.parse(value)
    } catch {
      return value
    }
  }, z.array(itemSchema).max(100))
}

export const AlbumBrowseFiltersParamSchema = createSerializedArrayQuerySchema(
  AlbumBrowseFilterSchema,
)

export const FilmBrowseFiltersParamSchema = createSerializedArrayQuerySchema(
  FilmBrowseFilterSchema,
)

export const AlbumFilterOptionSchema = AlbumBrowseFilterSchema.extend({
  label: z.string(),
  count: z.number().int().positive(),
})

export const FilmFilterOptionSchema = FilmBrowseFilterSchema.extend({
  label: z.string(),
  count: z.number().int().positive(),
})

export const AlbumQuerySchema = PaginationQuerySchema.extend({
  includeArchived: z.enum(['true', 'false']).optional(),
  limitResults: z.coerce.number().int().min(1).max(10000).optional(),
  q: z.string().optional(),
  tag: z.string().optional(),
  filters: AlbumBrowseFiltersParamSchema,
  ranges: BrowseRangesParamSchema,
  sortBy: AlbumSortSchema.default('dateAdded'),
  direction: DirectionSchema.default('desc'),
})

export const FilmQuerySchema = PaginationQuerySchema.extend({
  includeArchived: z.enum(['true', 'false']).optional(),
  limitResults: z.coerce.number().int().min(1).max(10000).optional(),
  q: z.string().optional(),
  tag: z.string().optional(),
  sourceKind: z.string().optional(),
  filters: FilmBrowseFiltersParamSchema,
  ranges: BrowseRangesParamSchema,
  sortBy: FilmSortSchema.default('releaseDate'),
  direction: DirectionSchema.default('desc'),
})

const MediaBaseSchema = z.object({
  id: z.string(),
  mediaType: MediaTypeSchema,
  slug: z.string(),
  title: z.string(),
  originalTitle: z.string().nullable(),
  summary: z.string().nullable(),
  artworkUrl: z.string().url().nullable(),
  releaseDate: z.string().nullable(),
  sourceLabel: z.string().nullable(),
  metadata: z.record(z.string(), JsonValueSchema).nullable(),
  tags: z.array(TagSchema),
  credits: z.array(CreditSchema),
  links: z.array(ExternalLinkSchema),
  providerReferences: z.array(ProviderReferenceSchema),
  playlists: z.array(PlaylistMembershipSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export const TrackSchema = z.object({
  externalId: z.string().nullable(),
  title: z.string(),
  position: z.number().int().positive(),
  durationSec: z.number().int().nonnegative().nullable(),
})

export const AlbumListItemSchema = MediaBaseSchema.extend({
  mediaType: z.literal('album'),
  dateAdded: z.string().nullable(),
  durationSec: z.number().int().nonnegative().nullable(),
  spotifyUrl: z.string().url().nullable(),
  trackCount: z.number().int().nonnegative(),
})

export const AlbumDetailSchema = AlbumListItemSchema.extend({
  tracks: z.array(TrackSchema),
  collectionSources: z.array(SourceNavigationLinkSchema).optional(),
  providerDetails: z.array(AlbumProviderDetailsSchema).optional(),
})

export const FilmListItemSchema = MediaBaseSchema.extend({
  mediaType: z.literal('film'),
  dateAdded: z.string().optional(),
  dateAddedSource: z.string().optional(),
  runtimeMinutes: z.number().int().nonnegative().nullable(),
  watched: z.boolean(),
  sourceKind: z.string().nullable(),
  budget: z.number().int().nonnegative().nullable(),
  boxOffice: z.number().int().nonnegative().nullable(),
})

export const FilmDetailSchema = FilmListItemSchema.extend({
  collectionSources: z.array(SourceNavigationLinkSchema).optional(),
})

export const MediaHistoryEventSchema = z.object({
  id: z.string(),
  jobId: z.string().nullable().optional(),
  type: z.enum(['snapshot', 'override', 'job']),
  provider: z.string().nullable(),
  title: z.string(),
  description: z.string().nullable(),
  createdAt: z.string(),
  data: JsonValueSchema.nullable(),
})

export const MediaHistorySchema = z.object({
  mediaItemId: z.string(),
  events: z.array(MediaHistoryEventSchema),
})

export const AlbumPatchSchema = z.object({
  title: z.string().min(1).optional(),
  originalTitle: z.string().min(1).nullable().optional(),
  summary: z.string().min(1).nullable().optional(),
  artworkUrl: z.string().url().nullable().optional(),
  releaseDate: z.string().nullable().optional(),
  sourceLabel: z.string().min(1).nullable().optional(),
  dateAdded: z.string().nullable().optional(),
  durationSec: z.number().int().nonnegative().nullable().optional(),
  spotifyUrl: z.string().url().nullable().optional(),
  referenceOverrides: z.array(ProviderReferenceOverrideSchema).optional(),
  note: z.string().optional(),
})

export const FilmPatchSchema = z.object({
  dateAdded: z.string().date().or(z.string().datetime()).nullable().optional(),
  title: z.string().min(1).optional(),
  originalTitle: z.string().min(1).nullable().optional(),
  summary: z.string().min(1).nullable().optional(),
  artworkUrl: z.string().url().nullable().optional(),
  releaseDate: z.string().nullable().optional(),
  sourceLabel: z.string().min(1).nullable().optional(),
  runtimeMinutes: z.number().int().nonnegative().nullable().optional(),
  watched: z.boolean().optional(),
  sourceKind: z.string().min(1).nullable().optional(),
  budget: z.number().int().nonnegative().nullable().optional(),
  boxOffice: z.number().int().nonnegative().nullable().optional(),
  referenceOverrides: z.array(ProviderReferenceOverrideSchema).optional(),
  note: z.string().optional(),
})

export const MediaRescrapeSchema = z.object({
  provider: z.string().min(1),
})

export type AlbumQuery = z.infer<typeof AlbumQuerySchema>
export type FilmQuery = z.infer<typeof FilmQuerySchema>
export type AlbumBrowseFilterField = z.infer<
  typeof AlbumBrowseFilterFieldSchema
>
export type FilmBrowseFilterField = z.infer<typeof FilmBrowseFilterFieldSchema>
export type AlbumBrowseFilter = z.infer<typeof AlbumBrowseFilterSchema>
export type FilmBrowseFilter = z.infer<typeof FilmBrowseFilterSchema>
export type AlbumFilterOption = z.infer<typeof AlbumFilterOptionSchema>
export type FilmFilterOption = z.infer<typeof FilmFilterOptionSchema>
export type AlbumListItem = z.infer<typeof AlbumListItemSchema>
export type AlbumDetail = z.infer<typeof AlbumDetailSchema>
export type FilmListItem = z.infer<typeof FilmListItemSchema>
export type FilmDetail = z.infer<typeof FilmDetailSchema>
export type MediaHistory = z.infer<typeof MediaHistorySchema>
export type AlbumPatchInput = z.infer<typeof AlbumPatchSchema>
export type FilmPatchInput = z.infer<typeof FilmPatchSchema>

export const albumBrowseFilterFieldLabels: Record<string, string> =
  Object.fromEntries(albumBrowseFields.map((field) => [field.key, field.label]))
export const filmBrowseFilterFieldLabels: Record<string, string> =
  Object.fromEntries(filmBrowseFields.map((field) => [field.key, field.label]))
export const filmSourceKindLabels: Record<string, string> = {
  file: 'File',
  bluray: 'Blu-ray',
  'imdb-rating': 'IMDb Rating',
  'imdb-watchlist': 'IMDb Watchlist',
}
export function formatFilmSourceKindValue(value: string): string {
  return filmSourceKindLabels[value] ?? value
}
export function buildAlbumBrowseFilterLabel(filter: AlbumBrowseFilter): string {
  return `${albumBrowseFilterFieldLabels[filter.field] ?? filter.field}: ${filter.value}`
}
export function buildFilmBrowseFilterLabel(filter: FilmBrowseFilter): string {
  return `${filmBrowseFilterFieldLabels[filter.field] ?? filter.field}: ${filter.field === 'source' ? formatFilmSourceKindValue(filter.value) : filter.value}`
}

export function serializeAlbumBrowseFilters(
  filters: AlbumBrowseFilter[],
): string | undefined {
  return filters.length > 0 ? JSON.stringify(filters) : undefined
}

export function serializeFilmBrowseFilters(
  filters: FilmBrowseFilter[],
): string | undefined {
  return filters.length > 0 ? JSON.stringify(filters) : undefined
}

export function parseAlbumBrowseFiltersParam(
  value: string | null | undefined,
): AlbumBrowseFilter[] {
  const result = AlbumBrowseFiltersParamSchema.safeParse(value)

  return result.success ? result.data : []
}

export function parseFilmBrowseFiltersParam(
  value: string | null | undefined,
): FilmBrowseFilter[] {
  const result = FilmBrowseFiltersParamSchema.safeParse(value)

  return result.success ? result.data : []
}

export type AlbumOverrideFormValues = {
  title: string
  originalTitle: string
  summary: string
  artworkUrl: string
  releaseDate: string
  sourceLabel: string
  dateAdded: string
  durationSec: string
  spotifyUrl: string
  note: string
  referenceProvider: string
  referenceType: string
  referenceExternalId: string
}

export type FilmOverrideFormValues = {
  title: string
  originalTitle: string
  summary: string
  artworkUrl: string
  releaseDate: string
  sourceLabel: string
  runtimeMinutes: string
  watched: boolean
  sourceKind: string
  budget: string
  boxOffice: string
  note: string
  referenceProvider: string
  referenceType: string
  referenceExternalId: string
}

type ReferenceComparable = {
  providerReferences: Array<{
    provider: string
    referenceType: string
    externalId: string
  }>
}

type NullableIntegerField =
  | { kind: 'clear' }
  | { kind: 'skip' }
  | { kind: 'value'; value: number }

function normalizeRequiredText(value: string): string | undefined {
  const trimmedValue = value.trim()

  return trimmedValue.length > 0 ? trimmedValue : undefined
}

function normalizeNullableText(value: string): string | null {
  const trimmedValue = value.trim()

  return trimmedValue.length > 0 ? trimmedValue : null
}

function normalizeNullableInteger(value: string): NullableIntegerField {
  const trimmedValue = value.trim()

  if (trimmedValue.length === 0) {
    return { kind: 'clear' }
  }

  const parsedValue = Number(trimmedValue)

  if (Number.isInteger(parsedValue) && parsedValue >= 0) {
    return { kind: 'value', value: parsedValue }
  }

  return { kind: 'skip' }
}

function buildReferenceOverrides(
  detail: ReferenceComparable,
  values: {
    referenceProvider: string
    referenceType: string
    referenceExternalId: string
  },
): AlbumPatchInput['referenceOverrides'] {
  const provider = values.referenceProvider.trim()
  const referenceType = values.referenceType.trim()
  const externalId = values.referenceExternalId.trim()

  if (
    provider.length === 0 ||
    referenceType.length === 0 ||
    externalId.length === 0
  ) {
    return undefined
  }

  const alreadyPresent = detail.providerReferences.some(
    (reference) =>
      reference.provider === provider &&
      reference.referenceType === referenceType &&
      reference.externalId === externalId,
  )

  if (alreadyPresent) {
    return undefined
  }

  return [
    {
      provider,
      referenceType,
      externalId,
    },
  ]
}

function buildNote(note: string): string | undefined {
  const trimmedValue = note.trim()

  return trimmedValue.length > 0 ? trimmedValue : undefined
}

export function buildAlbumPatchInput(
  detail: AlbumDetail,
  values: AlbumOverrideFormValues,
): AlbumPatchInput {
  const patch: AlbumPatchInput = {}
  const normalizedTitle = normalizeRequiredText(values.title)

  if (normalizedTitle && normalizedTitle !== detail.title) {
    patch.title = normalizedTitle
  }

  const normalizedOriginalTitle = normalizeNullableText(values.originalTitle)
  if (normalizedOriginalTitle !== detail.originalTitle) {
    patch.originalTitle = normalizedOriginalTitle
  }

  const normalizedSummary = normalizeNullableText(values.summary)
  if (normalizedSummary !== detail.summary) {
    patch.summary = normalizedSummary
  }

  const normalizedArtworkUrl = normalizeNullableText(values.artworkUrl)
  if (normalizedArtworkUrl !== detail.artworkUrl) {
    patch.artworkUrl = normalizedArtworkUrl
  }

  const normalizedReleaseDate = normalizeNullableText(values.releaseDate)
  if (normalizedReleaseDate !== detail.releaseDate) {
    patch.releaseDate = normalizedReleaseDate
  }

  const normalizedSourceLabel = normalizeNullableText(values.sourceLabel)
  if (normalizedSourceLabel !== detail.sourceLabel) {
    patch.sourceLabel = normalizedSourceLabel
  }

  const normalizedDateAdded = normalizeNullableText(values.dateAdded)
  if (normalizedDateAdded !== detail.dateAdded) {
    patch.dateAdded = normalizedDateAdded
  }

  const normalizedDuration = normalizeNullableInteger(values.durationSec)
  if (normalizedDuration.kind === 'clear' && detail.durationSec !== null) {
    patch.durationSec = null
  }
  if (
    normalizedDuration.kind === 'value' &&
    normalizedDuration.value !== detail.durationSec
  ) {
    patch.durationSec = normalizedDuration.value
  }

  const normalizedSpotifyUrl = normalizeNullableText(values.spotifyUrl)
  if (normalizedSpotifyUrl !== detail.spotifyUrl) {
    patch.spotifyUrl = normalizedSpotifyUrl
  }

  const referenceOverrides = buildReferenceOverrides(detail, values)
  if (referenceOverrides) {
    patch.referenceOverrides = referenceOverrides
  }

  const note = buildNote(values.note)
  if (note) {
    patch.note = note
  }

  return patch
}

export function buildFilmPatchInput(
  detail: FilmDetail,
  values: FilmOverrideFormValues,
): FilmPatchInput {
  const patch: FilmPatchInput = {}
  const normalizedTitle = normalizeRequiredText(values.title)

  if (normalizedTitle && normalizedTitle !== detail.title) {
    patch.title = normalizedTitle
  }

  const normalizedOriginalTitle = normalizeNullableText(values.originalTitle)
  if (normalizedOriginalTitle !== detail.originalTitle) {
    patch.originalTitle = normalizedOriginalTitle
  }

  const normalizedSummary = normalizeNullableText(values.summary)
  if (normalizedSummary !== detail.summary) {
    patch.summary = normalizedSummary
  }

  const normalizedArtworkUrl = normalizeNullableText(values.artworkUrl)
  if (normalizedArtworkUrl !== detail.artworkUrl) {
    patch.artworkUrl = normalizedArtworkUrl
  }

  const normalizedReleaseDate = normalizeNullableText(values.releaseDate)
  if (normalizedReleaseDate !== detail.releaseDate) {
    patch.releaseDate = normalizedReleaseDate
  }

  const normalizedSourceLabel = normalizeNullableText(values.sourceLabel)
  if (normalizedSourceLabel !== detail.sourceLabel) {
    patch.sourceLabel = normalizedSourceLabel
  }

  const normalizedRuntime = normalizeNullableInteger(values.runtimeMinutes)
  if (normalizedRuntime.kind === 'clear' && detail.runtimeMinutes !== null) {
    patch.runtimeMinutes = null
  }
  if (
    normalizedRuntime.kind === 'value' &&
    normalizedRuntime.value !== detail.runtimeMinutes
  ) {
    patch.runtimeMinutes = normalizedRuntime.value
  }

  if (values.watched !== detail.watched) {
    patch.watched = values.watched
  }

  const normalizedSourceKind = normalizeNullableText(values.sourceKind)
  if (normalizedSourceKind !== detail.sourceKind) {
    patch.sourceKind = normalizedSourceKind
  }

  const normalizedBudget = normalizeNullableInteger(values.budget)
  if (normalizedBudget.kind === 'clear' && detail.budget !== null) {
    patch.budget = null
  }
  if (
    normalizedBudget.kind === 'value' &&
    normalizedBudget.value !== detail.budget
  ) {
    patch.budget = normalizedBudget.value
  }

  const normalizedBoxOffice = normalizeNullableInteger(values.boxOffice)
  if (normalizedBoxOffice.kind === 'clear' && detail.boxOffice !== null) {
    patch.boxOffice = null
  }
  if (
    normalizedBoxOffice.kind === 'value' &&
    normalizedBoxOffice.value !== detail.boxOffice
  ) {
    patch.boxOffice = normalizedBoxOffice.value
  }

  const referenceOverrides = buildReferenceOverrides(detail, values)
  if (referenceOverrides) {
    patch.referenceOverrides = referenceOverrides
  }

  const note = buildNote(values.note)
  if (note) {
    patch.note = note
  }

  return patch
}
