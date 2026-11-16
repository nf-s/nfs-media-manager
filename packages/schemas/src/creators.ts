import { z } from 'zod'
import {
  ArtistProfileProviderSchema,
  ArtistIdentifierSchema,
  ArtistProfileSchema,
  ArtistProviderSnapshotSchema,
} from './artist-profiles'
import {
  CreatorIdSchema,
  DirectionSchema,
  PaginatedDataSchema,
  PaginationQuerySchema,
  PersonRoleSchema,
} from './common'
import { AlbumListItemSchema, FilmListItemSchema } from './media'
import { TrackListItemSchema } from './tracks'

const CountSchema = z.number().int().nonnegative()
const CreatorIdentitySchema = z.object({
  id: z.string(),
  name: z.string(),
  sortName: z.string().nullable(),
  createdAt: z.string().datetime(),
})

export const CreatorParamsSchema = z.object({ id: CreatorIdSchema })
export const ArtistDetailQuerySchema = z.object({
  includeHistory: z.enum(['true', 'false']).optional(),
})
export type ArtistDetailQuery = z.infer<typeof ArtistDetailQuerySchema>
export { PersonRoleSchema, type PersonRole } from './common'

export const ArtistSummarySchema = CreatorIdentitySchema.extend({
  artworkUrl: z.string().url().nullable(),
  albumCount: CountSchema,
  trackCount: CountSchema,
  playlistCount: CountSchema,
})
export type ArtistSummary = z.infer<typeof ArtistSummarySchema>
export const ArtistPageSchema = PaginatedDataSchema(ArtistSummarySchema)
export type ArtistPage = z.infer<typeof ArtistPageSchema>

export const ArtistDetailSchema = ArtistSummarySchema.extend({
  identifiers: z.array(ArtistIdentifierSchema),
  profile: ArtistProfileSchema,
  providers: z.array(ArtistProviderSnapshotSchema),
  history: z.array(ArtistProviderSnapshotSchema),
})
export type ArtistDetail = z.infer<typeof ArtistDetailSchema>

export const ArtistHistoryQuerySchema = PaginationQuerySchema.extend({
  provider: ArtistProfileProviderSchema.optional(),
})
export type ArtistHistoryQuery = z.infer<typeof ArtistHistoryQuerySchema>
export const ArtistHistoryPageSchema = PaginatedDataSchema(
  ArtistProviderSnapshotSchema,
)
export type ArtistHistoryPage = z.infer<typeof ArtistHistoryPageSchema>

export const PersonSummarySchema = CreatorIdentitySchema.extend({
  filmCount: CountSchema,
  directorCount: CountSchema,
  actorCount: CountSchema,
  roles: z.array(PersonRoleSchema),
})
export type PersonSummary = z.infer<typeof PersonSummarySchema>
export const PersonDetailSchema = PersonSummarySchema
export type PersonDetail = PersonSummary
export const PersonPageSchema = PaginatedDataSchema(PersonSummarySchema)
export type PersonPage = z.infer<typeof PersonPageSchema>

const CreatorQuerySchema = PaginationQuerySchema.extend({
  q: z.string().trim().max(200).optional(),
  direction: DirectionSchema.default('asc'),
})

export const ArtistQuerySchema = CreatorQuerySchema.extend({
  sortBy: z
    .enum(['name', 'createdAt', 'albumCount', 'trackCount', 'playlistCount'])
    .default('name'),
})
export type ArtistQuery = z.infer<typeof ArtistQuerySchema>

export const PersonQuerySchema = CreatorQuerySchema.extend({
  sortBy: z
    .enum(['name', 'createdAt', 'filmCount', 'directorCount', 'actorCount'])
    .default('name'),
  role: PersonRoleSchema.optional(),
})
export type PersonQuery = z.infer<typeof PersonQuerySchema>

export const ArtistAlbumQuerySchema = CreatorQuerySchema.extend({
  sortBy: z.enum(['title', 'releaseDate', 'dateAdded']).default('title'),
})
export type ArtistAlbumQuery = z.infer<typeof ArtistAlbumQuerySchema>
export const ArtistAlbumPageSchema = PaginatedDataSchema(AlbumListItemSchema)
export type ArtistAlbumPage = z.infer<typeof ArtistAlbumPageSchema>

export const ArtistTrackQuerySchema = CreatorQuerySchema.extend({
  sortBy: z
    .enum(['title', 'releaseDate', 'dateAdded', 'durationSec', 'scrobbles'])
    .default('title'),
})
export type ArtistTrackQuery = z.infer<typeof ArtistTrackQuerySchema>
export const ArtistTrackPageSchema = PaginatedDataSchema(TrackListItemSchema)
export type ArtistTrackPage = z.infer<typeof ArtistTrackPageSchema>

export const ArtistPlaylistQuerySchema = CreatorQuerySchema.extend({
  sortBy: z
    .enum(['name', 'createdAt', 'trackCount', 'albumCount'])
    .default('name'),
})
export type ArtistPlaylistQuery = z.infer<typeof ArtistPlaylistQuerySchema>
export const ArtistPlaylistSchema = z.object({
  id: z.string(),
  name: z.string(),
  artworkUrl: z.string().nullable(),
  spotifyUrl: z.string().nullable(),
  createdAt: z.string().datetime(),
  trackCount: CountSchema,
  albumCount: CountSchema,
})
export type ArtistPlaylist = z.infer<typeof ArtistPlaylistSchema>
export const ArtistPlaylistPageSchema =
  PaginatedDataSchema(ArtistPlaylistSchema)
export type ArtistPlaylistPage = z.infer<typeof ArtistPlaylistPageSchema>

export const PersonFilmQuerySchema = CreatorQuerySchema.extend({
  sortBy: z
    .enum(['title', 'releaseDate', 'dateAdded', 'runtimeMinutes', 'watched'])
    .default('title'),
  role: PersonRoleSchema.optional(),
})
export type PersonFilmQuery = z.infer<typeof PersonFilmQuerySchema>
export const PersonFilmPageSchema = PaginatedDataSchema(FilmListItemSchema)
export type PersonFilmPage = z.infer<typeof PersonFilmPageSchema>
