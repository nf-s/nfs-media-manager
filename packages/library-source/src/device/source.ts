import type { DeviceBrowseLibrary } from '@repo/schemas/device'
import type { BrowseField } from '@repo/schemas/browse'
import type { SqliteDriver } from '../driver'
import type { LibrarySource, SourceResult } from '../source'
import { readBrowseFields } from '../compile/fields'
import { serveRead } from './read'
import {
  trackCount,
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
 * A read the device does not answer yet; another library's compiler
 * replaces it. Until then the read goes to the API.
 */
function notServedYet<T>(): Promise<SourceResult<T>> {
  return Promise.resolve({ served: false, reason: 'not-ready' })
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
      serveRead(driver, now, (read) => trackPage(read, query)),
    trackCount: (query) =>
      serveRead(driver, now, (read) => trackCount(read, query)),
    trackList: (query) =>
      serveRead(driver, now, (read) => trackList(read, query)),
    trackPositions: (query) =>
      serveRead(driver, now, (read) => trackPositions(read, query)),
    trackRecordings: (query) =>
      serveRead(driver, now, (read) => trackRecordings(read, query)),
    trackFacets: notServedYet,
    trackHistogram: notServedYet,

    albumPage: notServedYet,
    albumCount: notServedYet,
    albumList: notServedYet,
    albumFacets: notServedYet,
    albumHistogram: notServedYet,

    filmPage: notServedYet,
    filmCount: notServedYet,
    filmList: notServedYet,
    filmFacets: notServedYet,

    artistPage: notServedYet,
    artistCount: notServedYet,
    artistFacets: notServedYet,
    artistHistogram: notServedYet,

    playlistPage: notServedYet,
    playlistCount: notServedYet,

    fields: (library: DeviceBrowseLibrary) =>
      serveRead<BrowseField[]>(driver, now, (read) =>
        readBrowseFields(read.tx, library),
      ),
  }
}
