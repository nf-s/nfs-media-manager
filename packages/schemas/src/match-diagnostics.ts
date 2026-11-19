import { z } from 'zod'
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
import { selectionQueryFields } from './film-selection'
import { SpotifyTrackSearchFreshnessSchema } from './spotify-track-search'
import {
  AlbumHttpUrlSchema,
  AlbumMetacriticUrlSchema,
} from './provider-identification'

export const MatchDiagnosticsQuerySchema = PaginationQuerySchema.extend({
  q: z.string().trim().max(200).optional(),
  sortBy: z.string().min(1).max(100).default('name'),
  direction: DirectionSchema.default('asc'),
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

export const TrackMatchDiagnosticsQuerySchema =
  MatchDiagnosticsQuerySchema.extend({
    /** Coverage lists read library recordings without hydrating provider payloads. */
    view: z
      .enum(['providers', 'spotify-coverage', 'spotify-search-metadata'])
      .optional(),
    playability: TrackPlayabilitySchema.optional(),
    creatorId: TrackQuerySchema.shape.creatorId,
    filters: TrackQuerySchema.shape.filters,
    ranges: TrackQuerySchema.shape.ranges,
    limitResults: TrackQuerySchema.shape.limitResults,
    listening: TrackQuerySchema.shape.listening,
    listeningSort: TrackQuerySchema.shape.listeningSort,
    freshness: selectionQueryFields.freshness
      .pipe(SpotifyTrackSearchFreshnessSchema)
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
  ...trackBrowseFields.map((field) =>
    field.key === 'spotifyMatch'
      ? { ...field, label: 'Spotify match on this entry' }
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

export const AlbumMatchRejectionInputSchema = z.object({
  provider: z.string().min(1).max(200),
  sourceProvider: z.string().min(1).max(200),
  snapshotId: z.string().min(1).max(500),
  referenceType: z.string().min(1).max(200),
  identifier: z.string().min(1).max(500),
})
export type AlbumMatchRejectionInput = z.infer<
  typeof AlbumMatchRejectionInputSchema
>

export const AlbumMatchRejectionSchema = AlbumMatchRejectionInputSchema.extend({
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
  AlbumMatchRejectionInputSchema.extend({
    provider: z.literal('google-custom-search'),
    sourceProvider: z.enum([
      'google-custom-search',
      'legacy-record',
      'legacy-browser',
    ]),
    referenceType: z.literal('metacritic-url'),
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
