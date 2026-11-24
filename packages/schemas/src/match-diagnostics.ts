import { z } from 'zod'
import { CatalogScopeQuerySchema } from './catalog'
import {
  DirectionSchema,
  PaginatedDataSchema,
  PaginationQuerySchema,
} from './common'
import { trackBrowseFields, type BrowseField } from './browse'
import {
  TrackListItemSchema,
  TrackQuerySchema,
  TrackSpotifyAlternateSchema,
} from './tracks'
import {
  ProviderFreshnessFiltersSchema,
  selectionQueryFields,
} from './film-selection'
import {
  albumMatchIdentifierMaxLength,
  AlbumHttpUrlSchema,
  AlbumMetacriticUrlSchema,
  LegacyRymAlbumUrlSchema,
  legacyRymAlbumUrlMaxLength,
} from './provider-identification'

export const MatchDiagnosticsQuerySchema = PaginationQuerySchema.extend({
  q: z.string().trim().max(200).optional(),
  sortBy: z.string().min(1).max(100).default('name'),
  direction: DirectionSchema.default('asc'),
})

const longRymQuery = z.literal('1').optional()
export const AlbumMatchDiagnosticsQuerySchema =
  MatchDiagnosticsQuerySchema.extend({
    longRym: longRymQuery,
  })
export const AlbumMatchRejectionHistoryQuerySchema =
  PaginationQuerySchema.extend({
    longRym: longRymQuery,
  })

export const TrackPlayabilitySchema = z.enum([
  'all',
  'playable',
  'direct',
  'alternate',
  'unavailable',
])
export type TrackPlayability = z.infer<typeof TrackPlayabilitySchema>
export const trackPlayabilityLabels: Record<TrackPlayability, string> = {
  all: 'Any playability',
  playable: 'Any playable version',
  direct: 'Playable on this entry',
  alternate: 'Playable via another version',
  unavailable: 'No playable version',
}

/** Which possible duplicate groups: those nothing speaks against merging, or the others. */
export const TrackDuplicateCautionsSchema = z.enum(['all', 'none', 'some'])
export type TrackDuplicateCautions = z.infer<
  typeof TrackDuplicateCautionsSchema
>
export const trackDuplicateCautionsLabels: Record<
  TrackDuplicateCautions,
  string
> = {
  all: 'All groups',
  none: 'Nothing against merging',
  some: 'Something against merging',
}

/** Track Metadata filters by Spotify search, TIDAL match and Sonovault lookup freshness. */
export const trackMatchFreshnessProviders = [
  'spotify',
  'tidal',
  'sonovault',
] as const
export const TrackMatchFreshnessSchema = ProviderFreshnessFiltersSchema.refine(
  (filters) =>
    filters.every(({ provider }) =>
      trackMatchFreshnessProviders.some((item) => item === provider),
    ),
  'Track freshness is available for Spotify, TIDAL and Sonovault',
)

export const TrackMatchDiagnosticsQuerySchema =
  MatchDiagnosticsQuerySchema.extend({
    ...CatalogScopeQuerySchema.shape,
    /** Coverage lists read library recordings without hydrating provider payloads. */
    view: z
      .enum(['providers', 'spotify-coverage', 'spotify-search-metadata'])
      .optional(),
    playability: TrackPlayabilitySchema.optional(),
    /** Only possible duplicates, grouped, most played group first. */
    duplicates: z
      .union([
        z.boolean(),
        z.enum(['true', 'false']).transform((value) => value === 'true'),
      ])
      .optional(),
    /** With `duplicates`, only the groups of that kind. */
    duplicateCautions: TrackDuplicateCautionsSchema.optional(),
    creatorId: TrackQuerySchema.shape.creatorId,
    filters: TrackQuerySchema.shape.filters,
    ranges: TrackQuerySchema.shape.ranges,
    limitResults: TrackQuerySchema.shape.limitResults,
    listening: TrackQuerySchema.shape.listening,
    listeningSort: TrackQuerySchema.shape.listeningSort,
    freshness: selectionQueryFields.freshness
      .pipe(TrackMatchFreshnessSchema)
      .optional(),
  })
export type TrackMatchDiagnosticsQuery = z.infer<
  typeof TrackMatchDiagnosticsQuerySchema
>

export const trackMatchProviderLabels = {
  spotify: 'Spotify',
  lastfm: 'Last.fm',
  discogs: 'Discogs album position',
  noRecording: 'No recording matches',
  noEvidence: 'No provider evidence',
}

const diagnosticText = (key: string, label: string): BrowseField => ({
  key,
  label,
  type: 'text',
  filterable: true,
})

export const trackMatchDiagnosticFields: BrowseField[] = [
  // Beside Provider match, which is evidence on the entry, the providers
  // with an ID for the track read as Provider ID.
  ...trackBrowseFields.map((field) =>
    field.key === 'spotifyMatch'
      ? { ...field, label: 'Spotify match on this entry' }
      : field.key === 'provider'
        ? { ...field, label: 'Provider ID' }
        : field,
  ),
  diagnosticText('matchProvider', 'Provider match'),
  diagnosticText('spotifyName', 'Spotify track name'),
  diagnosticText('spotifyArtist', 'Spotify artist'),
  diagnosticText('spotifyId', 'Spotify track ID'),
  diagnosticText('lastfmName', 'Last.fm track name'),
  diagnosticText('lastfmArtist', 'Last.fm artist'),
  diagnosticText('lastfmId', 'Last.fm recording MBID'),
  diagnosticText('discogsName', 'Discogs track name'),
  diagnosticText('discogsArtist', 'Discogs track artist'),
]

export const AlbumMatchRejectionInputSchema = z
  .object({
    provider: z.string().min(1).max(200),
    sourceProvider: z.string().min(1).max(200),
    snapshotId: z.string().min(1).max(500),
    referenceType: z.string().min(1).max(200),
    identifier: z.string().min(1).max(legacyRymAlbumUrlMaxLength),
  })
  .refine(
    ({ provider, sourceProvider, referenceType, identifier }) =>
      identifier.length <= albumMatchIdentifierMaxLength ||
      (provider === 'google-custom-search' &&
        ['google-custom-search', 'legacy-record', 'legacy-browser'].includes(
          sourceProvider,
        ) &&
        referenceType === 'rym-url' &&
        LegacyRymAlbumUrlSchema.safeParse(identifier).success),
    {
      path: ['identifier'],
      message: 'Expected a provider identifier or a legacy RYM release URL.',
    },
  )
export type AlbumMatchRejectionInput = z.infer<
  typeof AlbumMatchRejectionInputSchema
>

export const AlbumMatchRejectionSchema =
  AlbumMatchRejectionInputSchema.safeExtend({
    rejectedAt: z.string().datetime(),
  })
export type AlbumMatchRejection = z.infer<typeof AlbumMatchRejectionSchema>

export const AlbumMatchRejectionPageSchema = PaginatedDataSchema(
  AlbumMatchRejectionSchema,
)

const metacriticEvidenceSource = z.enum([
  'metacritic-index',
  'musicbrainz',
  'wikidata',
])
const metacriticEvidenceUrl = {
  musicbrainz:
    /^https?:\/\/(?:www[.])?musicbrainz[.]org\/release-group\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}(?:\/details)?\/?$/i,
  wikidata: /^https?:\/\/(?:www[.])?wikidata[.]org\/wiki\/Q[1-9][0-9]*\/?$/,
}

const AlbumMetacriticEvidenceSchema = z
  .strictObject({
    source: metacriticEvidenceSource,
    sourceUrl: AlbumHttpUrlSchema.pipe(z.string().max(500)),
    observedUrl: AlbumMetacriticUrlSchema,
    observedAt: z.iso.datetime(),
    note: z.string().trim().min(1).max(500).optional(),
  })
  .refine(
    ({ source, sourceUrl, observedUrl }) =>
      source === 'metacritic-index'
        ? sourceUrl === observedUrl
        : metacriticEvidenceUrl[source].test(sourceUrl),
    {
      path: ['sourceUrl'],
      message:
        'Use the observed Metacritic page or its release-group or Wikidata source.',
    },
  )

const AlbumMetacriticRejectionTargetSchema =
  AlbumMatchRejectionInputSchema.safeExtend({
    provider: z.literal('google-custom-search'),
    sourceProvider: z.enum([
      'google-custom-search',
      'legacy-record',
      'legacy-browser',
    ]),
    referenceType: z.literal('metacritic-url'),
    identifier: z.string().min(1).max(albumMatchIdentifierMaxLength),
  })

export const AlbumMetacriticCandidatesInputSchema = z.strictObject({
  rejected: AlbumMetacriticRejectionTargetSchema,
})
export type AlbumMetacriticCandidatesInput = z.infer<
  typeof AlbumMetacriticCandidatesInputSchema
>

export const AlbumMetacriticCandidateSchema = z.object({
  url: AlbumMetacriticUrlSchema,
  title: z.string().min(1).max(1000),
  description: z.string().max(4000),
  indexedDate: z.iso.date().optional(),
})

export const AlbumMetacriticCandidatesSchema = z.object({
  items: z.array(AlbumMetacriticCandidateSchema).max(10),
})

export const AlbumMetacriticCorrectionInputSchema = z
  .strictObject({
    rejected: AlbumMetacriticRejectionTargetSchema,
    replacement: z.strictObject({
      url: AlbumMetacriticUrlSchema,
      title: z.string().trim().min(1).max(1000),
      artist: z.string().trim().min(1).max(1000),
      releaseDate: z.iso.date().optional(),
    }),
    evidence: z.array(AlbumMetacriticEvidenceSchema).min(1).max(6),
  })
  .refine(
    ({ evidence, replacement }) =>
      evidence.every(({ observedUrl }) => observedUrl === replacement.url),
    {
      path: ['evidence'],
      message: 'Each source must identify the selected Metacritic URL.',
    },
  )
export type AlbumMetacriticCorrectionInput = z.infer<
  typeof AlbumMetacriticCorrectionInputSchema
>
export const AlbumMetacriticCorrectionSchema = z.object({
  snapshotId: z.string().min(1),
  url: AlbumMetacriticUrlSchema,
})

export type AlbumMatchRejectionPage = z.infer<
  typeof AlbumMatchRejectionPageSchema
>

export const MatchDiagnosticsRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  creator: z.string().nullable(),
  albumName: z.string().nullable().optional(),
  track: TrackListItemSchema.optional(),
  spotifyAlternate: TrackSpotifyAlternateSchema.optional(),
  mergeSourceId: z.string().optional(),
  sourceId: z.string().optional(),
  matches: z.array(
    z.object({
      provider: z.string(),
      sourceProvider: z.string().optional(),
      name: z.string().nullable(),
      creator: z.string().nullable(),
      identifier: z.string().nullable(),
      artistKey: z.string().optional(),
      trackKey: z.string().optional(),
      albumKey: z.string().optional(),
      albumId: z.string().optional(),
      rejectionTarget: AlbumMatchRejectionInputSchema.optional(),
      rejectedAt: z.string().datetime().optional(),
    }),
  ),
})

export const MatchDiagnosticsPageSchema = z.object({
  providers: z.array(z.object({ key: z.string(), label: z.string() })),
  items: z.array(MatchDiagnosticsRowSchema),
  totalCount: z.number().int().nonnegative(),
  pageCount: z.number().int().nonnegative(),
})

export type MatchDiagnosticsQuery = z.infer<typeof MatchDiagnosticsQuerySchema>
export type MatchDiagnosticsRow = z.infer<typeof MatchDiagnosticsRowSchema>
export type MatchDiagnosticsPage = z.infer<typeof MatchDiagnosticsPageSchema>
