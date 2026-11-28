import type { DeviceBrowseLibrary } from '@repo/schemas/device'
import type { BrowseField } from '@repo/schemas/browse'
import type { SqliteDriver } from '../driver'
import type { LibrarySource } from '../source'
import { readBrowseFields } from '../compile/fields'
import { albumFacets } from './album-facets'
import { albumCount, albumHistogram, albumList, albumPage } from './albums'
import { artistFacets } from './artist-facets'
import { artistCount, artistHistogram, artistPage } from './artists'
import { filmFacets } from './film-facets'
import { filmCount, filmList, filmPage } from './films'
import { playlistCount, playlistPage } from './playlists'
import { serveRead } from './read'
import { trackFacets } from './track-facets'
import {
  trackCount,
  trackHistogram,
  trackList,
  trackPage,
  trackPositions,
  trackRecordings,
} from './tracks'

export type DeviceSourceOptions = {
  /** The clock, read once per call for listening periods; the system clock by default. */
  now?: () => Date
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
  return {
    trackPage: (query) =>
      serveRead(driver, now, query, (read) => trackPage(read, query)),
    trackCount: (query) =>
      serveRead(driver, now, query, (read) => trackCount(read, query)),
    trackList: (query) =>
      serveRead(driver, now, query, (read) => trackList(read, query)),
    trackPositions: (query) =>
      serveRead(driver, now, query, (read) => trackPositions(read, query)),
    trackRecordings: (query) =>
      serveRead(driver, now, query, (read) => trackRecordings(read, query)),
    trackFacets: (query) =>
      serveRead(driver, now, query, (read) => trackFacets(read, query)),
    trackHistogram: (query) =>
      serveRead(driver, now, query, (read) => trackHistogram(read, query)),

    albumPage: (query) =>
      serveRead(driver, now, query, (read) => albumPage(read, query)),
    albumCount: (query) =>
      serveRead(driver, now, query, (read) => albumCount(read, query)),
    albumList: (query) =>
      serveRead(driver, now, query, (read) => albumList(read, query)),
    albumFacets: (query) =>
      serveRead(driver, now, query, (read) => albumFacets(read, query)),
    albumHistogram: (query) =>
      serveRead(driver, now, query, (read) => albumHistogram(read, query)),

    filmPage: (query) =>
      serveRead(driver, now, query, (read) => filmPage(read, query)),
    filmCount: (query) =>
      serveRead(driver, now, query, (read) => filmCount(read, query)),
    filmList: (query) =>
      serveRead(driver, now, query, (read) => filmList(read, query)),
    filmFacets: (query) =>
      serveRead(driver, now, query, (read) => filmFacets(read, query)),

    artistPage: (query) =>
      serveRead(driver, now, query, (read) => artistPage(read, query)),
    artistCount: (query) =>
      serveRead(driver, now, query, (read) => artistCount(read, query)),
    artistFacets: (query) =>
      serveRead(driver, now, query, (read) => artistFacets(read, query)),
    artistHistogram: (query) =>
      serveRead(driver, now, query, (read) => artistHistogram(read, query)),

    playlistPage: (query) =>
      serveRead(driver, now, query, (read) => playlistPage(read, query)),
    playlistCount: (query) =>
      serveRead(driver, now, query, (read) => playlistCount(read, query)),

    fields: (library: DeviceBrowseLibrary) =>
      serveRead<BrowseField[]>(driver, now, library, (read) =>
        readBrowseFields(read.tx, library),
      ),
  }
}
