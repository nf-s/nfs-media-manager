import type { DeviceBrowseLibrary } from '@repo/schemas/device'
import type { BrowseField } from '@repo/schemas/browse'
import type { SqliteDriver } from '../driver'
import type { LibraryMethod, LibrarySource, SourceResult } from '../source'
import { readBrowseFields } from '../compile/fields'
import {
  queryKeyCheck,
  type QueryKeys,
  type QueryKeyUse,
} from '../compile/query-keys'
import { albumFacetQueryKeys, albumFacets } from './album-facets'
import {
  albumCount,
  albumHistogram,
  albumHistogramQueryKeys,
  albumList,
  albumPage,
  albumQueryKeys,
} from './albums'
import { artistFacetQueryKeys, artistFacets } from './artist-facets'
import {
  artistCount,
  artistHistogram,
  artistHistogramQueryKeys,
  artistPage,
  artistQueryKeys,
} from './artists'
import { filmFacetQueryKeys, filmFacets } from './film-facets'
import { filmCount, filmList, filmPage, filmQueryKeys } from './films'
import {
  libraryPlaylistList,
  libraryPlaylistListQueryKeys,
} from './library-playlists'
import { playlistCount, playlistPage, playlistQueryKeys } from './playlists'
import { serveRead, type DeviceRead } from './read'
import { trackFacetQueryKeys, trackFacets } from './track-facets'
import {
  trackCount,
  trackHistogram,
  trackHistogramQueryKeys,
  trackList,
  trackPage,
  trackPositions,
  trackPositionsQueryKeys,
  trackQueryKeys,
  trackRecordings,
} from './tracks'

export type DeviceSourceOptions = {
  /** The clock, read once per call for listening periods; the system clock by default. */
  now?: () => Date
}

/**
 * DEVICE-34: the key table of each read's parsed query, kept beside its
 * reader; for `trackRecordings`, of its `query` (its `id` is read). `fields`
 * takes a library name, which has no keys.
 */
export const deviceQueryKeys = {
  trackPage: trackQueryKeys,
  trackCount: trackQueryKeys,
  trackList: trackQueryKeys,
  trackPositions: trackPositionsQueryKeys,
  trackRecordings: trackQueryKeys,
  trackFacets: trackFacetQueryKeys,
  trackHistogram: trackHistogramQueryKeys,
  albumPage: albumQueryKeys,
  albumCount: albumQueryKeys,
  albumList: albumQueryKeys,
  albumFacets: albumFacetQueryKeys,
  albumHistogram: albumHistogramQueryKeys,
  filmPage: filmQueryKeys,
  filmCount: filmQueryKeys,
  filmList: filmQueryKeys,
  filmFacets: filmFacetQueryKeys,
  artistPage: artistQueryKeys,
  artistCount: artistQueryKeys,
  artistFacets: artistFacetQueryKeys,
  artistHistogram: artistHistogramQueryKeys,
  playlistPage: playlistQueryKeys,
  playlistCount: playlistQueryKeys,
  libraryPlaylistList: libraryPlaylistListQueryKeys,
  fields: {},
} satisfies {
  readonly [Method in LibraryMethod]: Readonly<Record<string, QueryKeyUse>>
}

/**
 * `DeviceLibrarySource` (DEVICE-20): Browse reads answered from the store
 * with the API's results, or not at all. The source holds no state of its
 * own; every call reads one transaction of the driver.
 */
export function createDeviceLibrarySource(
  driver: SqliteDriver,
  options: DeviceSourceOptions = {},
): LibrarySource {
  const now = options.now ?? (() => new Date())
  const keys = deviceQueryKeys
  /** One read of a query checked against the table of its type. */
  const serve = <Query extends Readonly<Record<string, unknown>>, T>(
    query: Query,
    table: QueryKeys<NoInfer<Query>>,
    work: (read: DeviceRead) => Promise<T>,
  ): Promise<SourceResult<T>> =>
    serveRead(driver, now, query, [queryKeyCheck(query, table)], work)
  return {
    trackPage: (query) =>
      serve(query, keys.trackPage, (read) => trackPage(read, query)),
    trackCount: (query) =>
      serve(query, keys.trackCount, (read) => trackCount(read, query)),
    trackList: (query) =>
      serve(query, keys.trackList, (read) => trackList(read, query)),
    trackPositions: (query) =>
      serve(query, keys.trackPositions, (read) => trackPositions(read, query)),
    trackRecordings: (query) =>
      serveRead(
        driver,
        now,
        query,
        [queryKeyCheck(query.query, keys.trackRecordings)],
        (read) => trackRecordings(read, query),
      ),
    trackFacets: (query) =>
      serve(query, keys.trackFacets, (read) => trackFacets(read, query)),
    trackHistogram: (query) =>
      serve(query, keys.trackHistogram, (read) => trackHistogram(read, query)),

    albumPage: (query) =>
      serve(query, keys.albumPage, (read) => albumPage(read, query)),
    albumCount: (query) =>
      serve(query, keys.albumCount, (read) => albumCount(read, query)),
    albumList: (query) =>
      serve(query, keys.albumList, (read) => albumList(read, query)),
    albumFacets: (query) =>
      serve(query, keys.albumFacets, (read) => albumFacets(read, query)),
    albumHistogram: (query) =>
      serve(query, keys.albumHistogram, (read) => albumHistogram(read, query)),

    filmPage: (query) =>
      serve(query, keys.filmPage, (read) => filmPage(read, query)),
    filmCount: (query) =>
      serve(query, keys.filmCount, (read) => filmCount(read, query)),
    filmList: (query) =>
      serve(query, keys.filmList, (read) => filmList(read, query)),
    filmFacets: (query) =>
      serve(query, keys.filmFacets, (read) => filmFacets(read, query)),

    artistPage: (query) =>
      serve(query, keys.artistPage, (read) => artistPage(read, query)),
    artistCount: (query) =>
      serve(query, keys.artistCount, (read) => artistCount(read, query)),
    artistFacets: (query) =>
      serve(query, keys.artistFacets, (read) => artistFacets(read, query)),
    artistHistogram: (query) =>
      serve(query, keys.artistHistogram, (read) =>
        artistHistogram(read, query),
      ),

    playlistPage: (query) =>
      serve(query, keys.playlistPage, (read) => playlistPage(read, query)),
    playlistCount: (query) =>
      serve(query, keys.playlistCount, (read) => playlistCount(read, query)),
    libraryPlaylistList: (query) =>
      serve(query, keys.libraryPlaylistList, (read) =>
        libraryPlaylistList(read, query),
      ),

    // A library name has no keys.
    fields: (library: DeviceBrowseLibrary) =>
      serveRead<BrowseField[]>(driver, now, library, [], (read) =>
        readBrowseFields(read.tx, library),
      ),
  }
}
