import { z } from 'zod'
import { DirectionSchema, PaginationQuerySchema } from './common'
import { trackBrowseFields, type BrowseField } from './browse'
import { TrackListItemSchema, TrackQuerySchema } from './tracks'

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
    view: z.enum(['providers', 'spotify-coverage']).optional(),
    playability: TrackPlayabilitySchema.optional(),
    creatorId: TrackQuerySchema.shape.creatorId,
    filters: TrackQuerySchema.shape.filters,
    ranges: TrackQuerySchema.shape.ranges,
    limitResults: TrackQuerySchema.shape.limitResults,
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

export const MatchDiagnosticsRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  creator: z.string().nullable(),
  albumName: z.string().nullable().optional(),
  track: TrackListItemSchema.optional(),
  spotifyAlternate: z
    .object({
      trackId: z.string(),
      name: z.string(),
      albumName: z.string().nullable(),
      album: TrackListItemSchema.shape.album.optional(),
      artworkUrl: TrackListItemSchema.shape.artworkUrl.optional(),
      identifier: z.string(),
    })
    .optional(),
  mergeSourceId: z.string().optional(),
  sourceId: z.string().optional(),
  matches: z.array(
    z.object({
      provider: z.string(),
      name: z.string().nullable(),
      creator: z.string().nullable(),
      identifier: z.string().nullable(),
      artistKey: z.string().optional(),
      trackKey: z.string().optional(),
      albumKey: z.string().optional(),
      albumId: z.string().optional(),
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
