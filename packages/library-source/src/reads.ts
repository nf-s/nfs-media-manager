import { z } from 'zod'
import {
  BrowseCountSchema,
  BrowseFieldSchema,
  BrowsePageSliceSchema,
} from '@repo/schemas/browse'
import { PaginatedDataSchema } from '@repo/schemas/common'
import { ArtistSummarySchema } from '@repo/schemas/creators'
import { ListeningHistogramSchema } from '@repo/schemas/listening'
import {
  AlbumFilterOptionSchema,
  AlbumListItemSchema,
  FilmFilterOptionSchema,
  FilmListItemSchema,
} from '@repo/schemas/media'
import {
  PlaylistBrowsePageSchema,
  TrackFilterOptionSchema,
  TrackListItemSchema,
  TrackPositionsSchema,
} from '@repo/schemas/tracks'
import type { LibraryMethod, LibrarySource, SourceResult } from './source'

/** The argument of each `LibrarySource` method: the parsed query. */
export type LibraryQueries = {
  [Method in LibraryMethod]: Parameters<LibrarySource[Method]>[0]
}

/** What each `LibrarySource` method answers when it serves the read. */
export type LibraryData = {
  [Method in LibraryMethod]: Extract<
    Awaited<ReturnType<LibrarySource[Method]>>,
    { served: true }
  >['data']
}

/** One function that answers every method, the read named by its first argument. */
export type LibraryReader = <Method extends LibraryMethod>(
  method: Method,
  query: LibraryQueries[Method],
) => Promise<SourceResult<LibraryData[Method]>>

/**
 * The API response schema of each read (the table in `source.ts`), for the
 * envelope's `data`. A device answer is checked with the same schema.
 */
export const libraryResponseSchemas: {
  [Method in LibraryMethod]: z.ZodType<LibraryData[Method]>
} = {
  trackPage: BrowsePageSliceSchema(TrackListItemSchema),
  trackCount: BrowseCountSchema,
  trackList: PaginatedDataSchema(TrackListItemSchema),
  trackPositions: TrackPositionsSchema,
  trackRecordings: BrowsePageSliceSchema(TrackListItemSchema),
  trackFacets: z.array(TrackFilterOptionSchema),
  trackHistogram: ListeningHistogramSchema,
  albumPage: BrowsePageSliceSchema(AlbumListItemSchema),
  albumCount: BrowseCountSchema,
  albumList: PaginatedDataSchema(AlbumListItemSchema),
  albumFacets: z.array(AlbumFilterOptionSchema),
  albumHistogram: ListeningHistogramSchema,
  filmPage: BrowsePageSliceSchema(FilmListItemSchema),
  filmCount: BrowseCountSchema,
  filmList: PaginatedDataSchema(FilmListItemSchema),
  filmFacets: z.array(FilmFilterOptionSchema),
  artistPage: BrowsePageSliceSchema(ArtistSummarySchema),
  artistCount: BrowseCountSchema,
  artistFacets: z.array(FilmFilterOptionSchema),
  artistHistogram: ListeningHistogramSchema,
  playlistPage: PlaylistBrowsePageSchema,
  playlistCount: BrowseCountSchema,
  fields: z.array(BrowseFieldSchema),
}

/** A `LibrarySource` whose every method calls `read` with its own name. */
export function librarySourceFrom(read: LibraryReader): LibrarySource {
  return {
    trackPage: (query) => read('trackPage', query),
    trackCount: (query) => read('trackCount', query),
    trackList: (query) => read('trackList', query),
    trackPositions: (query) => read('trackPositions', query),
    trackRecordings: (query) => read('trackRecordings', query),
    trackFacets: (query) => read('trackFacets', query),
    trackHistogram: (query) => read('trackHistogram', query),
    albumPage: (query) => read('albumPage', query),
    albumCount: (query) => read('albumCount', query),
    albumList: (query) => read('albumList', query),
    albumFacets: (query) => read('albumFacets', query),
    albumHistogram: (query) => read('albumHistogram', query),
    filmPage: (query) => read('filmPage', query),
    filmCount: (query) => read('filmCount', query),
    filmList: (query) => read('filmList', query),
    filmFacets: (query) => read('filmFacets', query),
    artistPage: (query) => read('artistPage', query),
    artistCount: (query) => read('artistCount', query),
    artistFacets: (query) => read('artistFacets', query),
    artistHistogram: (query) => read('artistHistogram', query),
    playlistPage: (query) => read('playlistPage', query),
    playlistCount: (query) => read('playlistCount', query),
    fields: (library) => read('fields', library),
  }
}

/** Calls the method of `source` that `method` names: the typed view of a source as a reader. */
export function readSource<Method extends LibraryMethod>(
  source: LibrarySource,
  method: Method,
  query: LibraryQueries[Method],
): Promise<SourceResult<LibraryData[Method]>> {
  const readers: {
    [Name in LibraryMethod]: (
      query: LibraryQueries[Name],
    ) => Promise<SourceResult<LibraryData[Name]>>
  } = source
  return readers[method](query)
}
