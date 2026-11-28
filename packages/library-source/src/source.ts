/**
 * One method per Browse read (docs/requirements/device-store.md). Every
 * method answers exactly what the API answers, or does not answer: a source
 * never returns a partial or approximate result.
 *
 * | Method            | Argument (parsed schema)                         | Result schema                                   |
 * | ----------------- | ------------------------------------------------ | ----------------------------------------------- |
 * | `trackPage`       | `TrackQuerySchema`                               | `BrowsePageSliceSchema(TrackListItemSchema)`    |
 * | `trackCount`      | `TrackQuerySchema`                               | `BrowseCountSchema`                             |
 * | `trackList`       | `TrackQuerySchema`                               | `PaginatedDataSchema(TrackListItemSchema)`      |
 * | `trackPositions`  | `TrackPositionsQuerySchema`                      | `TrackPositionsSchema`                          |
 * | `trackRecordings` | `{ id, query: TrackQuerySchema }`                | `BrowsePageSliceSchema(TrackListItemSchema)`    |
 * | `trackFacets`     | `BrowseFacetQuerySchema`                         | `TrackFilterOptionSchema[]`                     |
 * | `trackHistogram`  | `TrackListeningHistogramQuerySchema`             | `ListeningHistogramSchema`                      |
 * | `albumPage`       | `AlbumQuerySchema`                               | `BrowsePageSliceSchema(AlbumListItemSchema)`    |
 * | `albumCount`      | `AlbumQuerySchema`                               | `BrowseCountSchema`                             |
 * | `albumList`       | `AlbumQuerySchema`                               | `PaginatedDataSchema(AlbumListItemSchema)`      |
 * | `albumFacets`     | `ArchivableBrowseFacetQuerySchema`               | `AlbumFilterOptionSchema[]`                     |
 * | `albumHistogram`  | `AlbumListeningHistogramQuerySchema`             | `ListeningHistogramSchema`                      |
 * | `filmPage`        | `FilmQuerySchema`                                | `BrowsePageSliceSchema(FilmListItemSchema)`     |
 * | `filmCount`       | `FilmQuerySchema`                                | `BrowseCountSchema`                             |
 * | `filmList`        | `FilmQuerySchema`                                | `PaginatedDataSchema(FilmListItemSchema)`       |
 * | `filmFacets`      | `ArchivableBrowseFacetQuerySchema`               | `FilmFilterOptionSchema[]`                      |
 * | `artistPage`      | `ArtistQuerySchema`                              | `BrowsePageSliceSchema(ArtistSummarySchema)`    |
 * | `artistCount`     | `ArtistQuerySchema`                              | `BrowseCountSchema`                             |
 * | `artistFacets`    | `BrowseFacetQuerySchema`                         | `FilmFilterOptionSchema[]` (as the route)       |
 * | `artistHistogram` | `ArtistListeningHistogramQuerySchema`            | `ListeningHistogramSchema`                      |
 * | `playlistPage`    | `PlaylistBrowseQuerySchema`                      | `PlaylistBrowsePageSchema`                      |
 * | `playlistCount`   | `PlaylistBrowseQuerySchema`                      | `BrowseCountSchema`, without `unfilteredCount`  |
 * | `libraryPlaylistList` | `LibraryPlaylistListQuerySchema`             | `LibraryPlaylistPageSchema`                     |
 * | `fields`          | `DeviceBrowseLibrarySchema`                      | `BrowseFieldSchema[]`                           |
 *
 * Arguments are the schemas' parsed output, as a route handler receives them.
 */
import type { z } from 'zod'
import type {
  ArchivableBrowseFacetQuery,
  BrowseCountSchema,
  BrowseFacetQuery,
  BrowseField,
  BrowsePageSliceSchema,
} from '@repo/schemas/browse'
import type { PaginatedDataSchema } from '@repo/schemas/common'
import type {
  ArtistListeningHistogramQuery,
  ArtistQuery,
  ArtistSummarySchema,
} from '@repo/schemas/creators'
import type { DeviceBrowseLibrary } from '@repo/schemas/device'
import type {
  LibraryPlaylistListQuery,
  LibraryPlaylistPage,
} from '@repo/schemas/library-playlists'
import type { ListeningHistogram } from '@repo/schemas/listening'
import type {
  AlbumFilterOptionSchema,
  AlbumListeningHistogramQuery,
  AlbumListItemSchema,
  AlbumQuery,
  FilmFilterOptionSchema,
  FilmListItemSchema,
  FilmQuery,
} from '@repo/schemas/media'
import type {
  PlaylistBrowsePage,
  PlaylistBrowseQuery,
  TrackFilterOptionSchema,
  TrackListeningHistogramQuery,
  TrackListItemSchema,
  TrackPositionsQuery,
  TrackPositionsSchema,
  TrackQuery,
} from '@repo/schemas/tracks'

/**
 * Why a read went to the API. Each known hole of the requirements has one
 * reason; `not-ready` and `store-error` cover a store that cannot answer.
 */
export type UnsupportedReason =
  /** The first fill has not completed, or the store is off. */
  | 'not-ready'
  /** The store failed: storage, quota, a driver or a corrupt row. */
  | 'store-error'
  /** AI search runs on the server. */
  | 'ai-search'
  /** A catalog scope other than the library: `memberScope` is false. */
  | 'catalog-scope'
  /** Subscriptions and Mixes are not on the device. */
  | 'subscriptions'
  /** Grouped Tracks inside a creator scope: groups differ from the library-wide key. */
  | 'grouped-creator-scope'
  /** The Tags sort at Auto on Tracks in a creator scope or a recordings list: the service orders by another first-tag expression. */
  | 'creator-tag-sort'
  /** A non-exclude Provider filter on Tracks or Artists: rows carry per-request links. */
  | 'provider-filter'
  /** Films inside a creator scope: the service adds films linked through catalog observations. */
  | 'creator-films'
  /** Album facets with archived albums whose artist tags the service leaves out. */
  | 'archived-artist-tags'
  /** A Playlists page holding a playlist whose import is queued or running: the API has its progress. */
  | 'active-import'
  /**
   * A Playlists directory date range in a time zone other than `UTC` or an
   * `Area/Location` name, which PostgreSQL may read differently from the
   * device's time zone database.
   */
  | 'time-zone'
  /**
   * A Playlists directory count range with `library` while the live count of
   * a smart playlist of the library cannot be read on the device.
   */
  | 'smart-count'
  /**
   * The service lower-cases a value of the query in TypeScript, and the
   * server's fold cannot tell what its engine gives (see `lowerCaseAsServer`).
   */
  | 'server-lower-case'
  /** Detail pages and the lists owned by a detail. */
  | 'detail'
  /** Metadata selection, Matches, Jobs, Providers and Imports. */
  | 'server-state'
  /** A field missing from the device's field list, such as one a plugin added since. */
  | 'unknown-field'
  /** The API answers the query with an error, which the device leaves to it. */
  | 'invalid-query'
  /**
   * Text of the query holds U+0000. PostgreSQL text cannot hold it, so the
   * API rejects such a value where it reaches the database and answers where
   * the service compares it in TypeScript; the device leaves every such read
   * to the API.
   */
  | 'nul-text'
  /**
   * The query holds a value for a key the device does not implement: one
   * its reader's table marks `api` (DEVICE-34), such as a parameter added to
   * a schema since. Checked after `nul-text` and before every other reason.
   */
  | 'unimplemented-field'

export type SourceResult<T> =
  | { served: true; data: T }
  | { served: false; reason: UnsupportedReason }

type Infer<Schema extends z.ZodType> = z.infer<Schema>
type PageSlice<Item extends z.ZodTypeAny> = Infer<
  ReturnType<typeof BrowsePageSliceSchema<Item>>
>
type PaginatedPage<Item extends z.ZodTypeAny> = Infer<
  ReturnType<typeof PaginatedDataSchema<Item>>
>

export type BrowseCount = Infer<typeof BrowseCountSchema>
export type TrackPage = PageSlice<typeof TrackListItemSchema>
export type TrackListPage = PaginatedPage<typeof TrackListItemSchema>
export type TrackPositions = Infer<typeof TrackPositionsSchema>
export type TrackFilterOption = Infer<typeof TrackFilterOptionSchema>
export type AlbumPage = PageSlice<typeof AlbumListItemSchema>
export type AlbumListPage = PaginatedPage<typeof AlbumListItemSchema>
export type AlbumFilterOption = Infer<typeof AlbumFilterOptionSchema>
export type FilmPage = PageSlice<typeof FilmListItemSchema>
export type FilmListPage = PaginatedPage<typeof FilmListItemSchema>
export type FilmFilterOption = Infer<typeof FilmFilterOptionSchema>
export type ArtistPage = PageSlice<typeof ArtistSummarySchema>
/** `/artists/facets` answers with the film suggestion shape. */
export type ArtistFilterOption = Infer<typeof FilmFilterOptionSchema>

/** `/tracks/:id/recordings`: the track and its query. */
export type TrackRecordingsQuery = { id: string; query: TrackQuery }

export interface LibrarySource {
  trackPage(query: TrackQuery): Promise<SourceResult<TrackPage>>
  trackCount(query: TrackQuery): Promise<SourceResult<BrowseCount>>
  trackList(query: TrackQuery): Promise<SourceResult<TrackListPage>>
  trackPositions(
    query: TrackPositionsQuery,
  ): Promise<SourceResult<TrackPositions>>
  trackRecordings(query: TrackRecordingsQuery): Promise<SourceResult<TrackPage>>
  trackFacets(
    query: BrowseFacetQuery,
  ): Promise<SourceResult<TrackFilterOption[]>>
  trackHistogram(
    query: TrackListeningHistogramQuery,
  ): Promise<SourceResult<ListeningHistogram>>

  albumPage(query: AlbumQuery): Promise<SourceResult<AlbumPage>>
  albumCount(query: AlbumQuery): Promise<SourceResult<BrowseCount>>
  albumList(query: AlbumQuery): Promise<SourceResult<AlbumListPage>>
  albumFacets(
    query: ArchivableBrowseFacetQuery,
  ): Promise<SourceResult<AlbumFilterOption[]>>
  albumHistogram(
    query: AlbumListeningHistogramQuery,
  ): Promise<SourceResult<ListeningHistogram>>

  filmPage(query: FilmQuery): Promise<SourceResult<FilmPage>>
  filmCount(query: FilmQuery): Promise<SourceResult<BrowseCount>>
  filmList(query: FilmQuery): Promise<SourceResult<FilmListPage>>
  filmFacets(
    query: ArchivableBrowseFacetQuery,
  ): Promise<SourceResult<FilmFilterOption[]>>

  artistPage(query: ArtistQuery): Promise<SourceResult<ArtistPage>>
  artistCount(query: ArtistQuery): Promise<SourceResult<BrowseCount>>
  artistFacets(
    query: BrowseFacetQuery,
  ): Promise<SourceResult<ArtistFilterOption[]>>
  artistHistogram(
    query: ArtistListeningHistogramQuery,
  ): Promise<SourceResult<ListeningHistogram>>

  playlistPage(
    query: PlaylistBrowseQuery,
  ): Promise<SourceResult<PlaylistBrowsePage>>
  playlistCount(query: PlaylistBrowseQuery): Promise<SourceResult<BrowseCount>>
  libraryPlaylistList(
    query: LibraryPlaylistListQuery,
  ): Promise<SourceResult<LibraryPlaylistPage>>

  fields(library: DeviceBrowseLibrary): Promise<SourceResult<BrowseField[]>>
}

export type LibraryMethod = keyof LibrarySource

/** One read as `resolveLibraryRead` returns it and a Worker receives it. */
export type LibraryRead = {
  [Method in LibraryMethod]: {
    method: Method
    query: Parameters<LibrarySource[Method]>[0]
  }
}[LibraryMethod]
