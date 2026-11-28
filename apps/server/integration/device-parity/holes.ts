import type { LibraryRead, UnsupportedReason } from '@repo/library-source'
import { isSpotifyAudioFeatureKey } from '@repo/schemas/audio-features'
import { albumBrowseFields, filmBrowseFields } from '@repo/schemas/browse'
import { memberScope } from '@repo/schemas/catalog'
import { PlaylistBrowsePageSchema } from '@repo/schemas/tracks'

/**
 * The Known holes of docs/requirements/device-store.md as query shapes
 * (DEVICE-33): for each read, the reason the device must give for not
 * serving it, or undefined when it must serve it. Written from the table,
 * not from the compiler, so a fall-through the table does not list fails,
 * and so does a served answer for a shape the table lists.
 */

/** What some holes depend on beyond the query: read from PostgreSQL. */
export type DataFacts = {
  /**
   * An archived library album credits an artist who is on no other
   * non-archived library album, and the album carries artist tags.
   */
  archivedOnlyArtistTags: boolean
  /** Plugin text keys for which some library item holds a JSON number. */
  numericPluginText: { album: ReadonlySet<string>; film: ReadonlySet<string> }
  /**
   * For each Tags filter value of the matrix: no published track holds the
   * tag set from Sonovault, and a visible library track with tags of its
   * own would inherit the tag at Auto without carrying it.
   */
  sonovaultUndecided: ReadonlyMap<string, boolean>
}

type Observed = {
  /** The API's status for the path. */
  status: number
  /** The API's data, parsed, when it answered 200. */
  data: unknown
  facts: DataFacts
}

type Filter = { field: string; value: string; mode?: string }

const nonExcludeProvider = (filters: readonly Filter[]) =>
  filters.some(
    (filter) => filter.field === 'provider' && filter.mode !== 'exclude',
  )

/** A plugin text field of Albums or Films: listed by the API, not built in. */
function isPluginTextSort(
  library: 'album' | 'film',
  sortBy: string,
  facts: DataFacts,
) {
  const builtin = library === 'album' ? albumBrowseFields : filmBrowseFields
  return (
    !builtin.some((field) => field.key === sortBy) &&
    !isSpotifyAudioFeatureKey(sortBy) &&
    facts.numericPluginText[library].has(sortBy)
  )
}

function activeImport(data: unknown) {
  const page = PlaylistBrowsePageSchema.safeParse(data)
  return (
    page.success &&
    page.data.items.some(
      (item) =>
        item.sync.job?.status === 'queued' ||
        item.sync.job?.status === 'running',
    )
  )
}

function undecided(facts: DataFacts, value: string) {
  const known = facts.sonovaultUndecided.get(value)
  if (known === undefined)
    throw new Error(`The suite has no Sonovault facts for the tag ${value}`)
  return known
}

/**
 * A fall-through the table allows beside serving, where its condition
 * depends on more data than the suite reproduces: Tags suggestions on
 * Tracks at Auto may fall through with `sonovault-tags`. The suite asserts
 * each outcome on chosen texts.
 */
export function allowedHole(read: LibraryRead): UnsupportedReason | undefined {
  return read.method === 'trackFacets' && read.query.tagLevels === undefined
    ? 'sonovault-tags'
    : undefined
}

/** The reason the device must give for this read, or undefined when it must serve it. */
export function expectedHole(
  read: LibraryRead,
  observed: Observed,
): UnsupportedReason | undefined {
  // A query the API rejects is left to the API.
  if (observed.status !== 200) return 'invalid-query'
  switch (read.method) {
    case 'trackPage':
    case 'trackCount':
    case 'trackList':
    case 'trackPositions':
    case 'trackHistogram':
    case 'trackRecordings': {
      const query =
        read.method === 'trackRecordings' ? read.query.query : read.query
      const recordings = read.method === 'trackRecordings'
      if (!memberScope(query, 'track')) return 'catalog-scope'
      if (
        (recordings || query.groupRecordings === true) &&
        query.creatorId !== undefined
      )
        return 'grouped-creator-scope'
      // Counts, histograms and positions carry no provider links.
      const returnsItems =
        read.method === 'trackPage' ||
        read.method === 'trackList' ||
        read.method === 'trackRecordings'
      if (returnsItems && nonExcludeProvider(query.filters))
        return 'provider-filter'
      if (
        query.sortBy === 'genre' &&
        query.tagLevels === undefined &&
        (query.creatorId !== undefined || recordings)
      )
        return 'creator-tag-sort'
      if (
        query.tagLevels === undefined &&
        query.filters.some(
          (filter) =>
            filter.field === 'genre' && undecided(observed.facts, filter.value),
        )
      )
        return 'sonovault-tags'
      return undefined
    }
    case 'trackFacets':
    case 'artistFacets':
    case 'filmFacets':
      return memberScope(read.query) ? undefined : 'catalog-scope'
    case 'albumFacets':
      if (!memberScope(read.query)) return 'catalog-scope'
      return read.query.includeArchived === 'true' &&
        observed.facts.archivedOnlyArtistTags
        ? 'archived-artist-tags'
        : undefined
    case 'albumPage':
    case 'albumCount':
    case 'albumList':
    case 'albumHistogram':
      if (!memberScope(read.query)) return 'catalog-scope'
      return read.method !== 'albumHistogram' &&
        isPluginTextSort('album', read.query.sortBy, observed.facts)
        ? 'unknown-field'
        : undefined
    case 'filmPage':
    case 'filmCount':
    case 'filmList':
      if (!memberScope(read.query)) return 'catalog-scope'
      if (read.query.creatorId !== undefined) return 'creator-films'
      return isPluginTextSort('film', read.query.sortBy, observed.facts)
        ? 'unknown-field'
        : undefined
    case 'artistPage':
    case 'artistCount':
    case 'artistHistogram':
      if (!memberScope(read.query)) return 'catalog-scope'
      return read.method === 'artistPage' &&
        nonExcludeProvider(read.query.filters)
        ? 'provider-filter'
        : undefined
    case 'playlistPage':
      if (!memberScope(read.query)) return 'catalog-scope'
      return activeImport(observed.data) ? 'active-import' : undefined
    case 'playlistCount':
      return memberScope(read.query) ? undefined : 'catalog-scope'
    case 'fields':
      return undefined
  }
}
