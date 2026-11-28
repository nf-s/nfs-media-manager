import {
  deviceQueryKeys,
  type LibraryRead,
  type QueryKeyUse,
  type UnsupportedReason,
} from '@repo/library-source'
import { isSpotifyAudioFeatureKey } from '@repo/schemas/audio-features'
import {
  albumBrowseFields,
  filmBrowseFields,
  LIBRARY_PLAYLIST_FILTER_FIELD,
} from '@repo/schemas/browse'
import { memberScope } from '@repo/schemas/catalog'
import { tagDisplayName } from '@repo/schemas/tags'
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
   * An archived library album with artist tags (some credited artist has
   * snapshot tags) credits an artist who is on no non-archived library
   * album.
   */
  archivedOnlyArtistTags: boolean
  /** Plugin text keys for which some library item holds a JSON number. */
  numericPluginText: { album: ReadonlySet<string>; film: ReadonlySet<string> }
  /**
   * The database's `lower()`: each code point it changes, with the result,
   * and the code points the results consist of.
   */
  fold: FoldFacts
  /**
   * Texts listBrowseFacets lower-cases in TypeScript besides `q`: the field
   * labels of each library and the provider display names.
   */
  facetTexts: Record<Library, readonly string[]>
}

type Library = 'track' | 'album' | 'film' | 'artist'

export type FoldFacts = {
  lower: ReadonlyMap<number, string>
  yields: ReadonlySet<number>
}

/**
 * Whether the published fold leaves `text.toLowerCase()` on the server
 * unsettled (Known holes, `server-lower-case`): a capital sigma, a lone
 * surrogate, a code point the database changes to several (other than
 * U+0130), or a code point outside ASCII that the database neither changes
 * nor yields, other than U+03C2.
 */
export function unsettledLowerCase(text: string, fold: FoldFacts): boolean {
  return [...text].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    if (codePoint === 0x130) return false
    if (codePoint === 0x3a3 || (codePoint >= 0xd800 && codePoint <= 0xdfff))
      return true
    const lower = fold.lower.get(codePoint)
    if (lower !== undefined) return [...lower].length !== 1
    return !(
      codePoint < 0x80 ||
      codePoint === 0x3c2 ||
      fold.yields.has(codePoint)
    )
  })
}

/** The fields whose filter values the service normalises with normalizeTagName. */
const tagFilterFields: Record<Library, readonly string[]> = {
  track: ['genre', 'trackTag', 'albumTag', 'artistTag'],
  album: ['genre', 'albumTag', 'artistTag'],
  film: ['genre'],
  artist: ['genre'],
}

/**
 * A filter the service lower-cases in TypeScript with a value the fold
 * cannot settle: a tag filter (and the `tag` parameter) in every library,
 * and the Provider filter on Tracks.
 */
function unsettledFilter(
  library: Library,
  query: { filters: readonly Filter[]; tag?: string | undefined },
  facts: DataFacts,
) {
  const values = [
    ...query.filters
      .filter(
        (filter) =>
          tagFilterFields[library].includes(filter.field) ||
          (library === 'track' && filter.field === 'provider'),
      )
      .map((filter) =>
        filter.field === 'provider'
          ? filter.value
          : tagDisplayName(filter.value),
      ),
    ...(query.tag === undefined ? [] : [tagDisplayName(query.tag)]),
  ]
  return values.some((value) => unsettledLowerCase(value, facts.fold))
}

/** Facets: `q` always, and once it has a word every field label and provider name. */
function unsettledFacetText(
  library: Library,
  q: string | undefined,
  facts: DataFacts,
) {
  if (unsettledLowerCase(q ?? '', facts.fold)) return true
  if (!(q ?? '').split(/\s+/).some(Boolean)) return false
  return facts.facetTexts[library].some((text) =>
    unsettledLowerCase(text, facts.fold),
  )
}

/** Tags at a location that reads artist tags: Auto, or a location with `artist`. */
const readsArtistTags = (levels: readonly string[] | undefined) =>
  levels === undefined || levels.includes('artist')

/**
 * The Album facets that read artist tags: the Artist tags field, or Tags
 * at a location that reads them, among the suggested fields.
 */
function albumFacetsReadArtistTags(levels: readonly string[] | undefined) {
  const suggested = albumBrowseFields.filter(
    (field) => field.type === 'text' && field.filterable,
  )
  return suggested.some(
    (field) =>
      field.key === 'artistTag' ||
      (field.key === 'genre' && readsArtistTags(levels)),
  )
}

/** Known holes, `nul-text`: some text of the parsed query holds U+0000. */
function holdsNul(value: unknown): boolean {
  if (typeof value === 'string') return value.includes('\u0000')
  if (Array.isArray(value)) return value.some(holdsNul)
  if (typeof value === 'object' && value !== null)
    return Object.values(value).some(holdsNul)
  return false
}

type Observed = {
  /** The API's status for the path. */
  status: number
  /** The API's data, parsed, when it answered 200. */
  data: unknown
  facts: DataFacts
}

type Filter = { field: string; value: string; mode?: string }

/** Known holes, `library-playlist`: a libraryPlaylist filter in any mode (PL-18). */
const libraryPlaylistFilter = (filters: readonly Filter[]) =>
  filters.some((filter) => filter.field === LIBRARY_PLAYLIST_FILTER_FIELD)

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

/**
 * Known holes, `unimplemented-field` (DEVICE-34): a key of the read's query
 * that holds a value (anything but undefined) and that the device's table
 * for the read marks `api`. For a recordings list, a key of its `query`.
 */
function unimplementedKey(read: LibraryRead): string | undefined {
  const query =
    read.method === 'trackRecordings'
      ? read.query.query
      : read.method === 'fields'
        ? {}
        : read.query
  const keys: Readonly<Record<string, QueryKeyUse>> =
    deviceQueryKeys[read.method]
  return Object.entries(query).find(
    ([key, value]) => value !== undefined && keys[key] === 'api',
  )?.[0]
}

/** The reason the device must give for this read, or undefined when it must serve it. */
export function expectedHole(
  read: LibraryRead,
  observed: Observed,
): UnsupportedReason | undefined {
  // Text holding U+0000 is left to the API, whatever it answers.
  if (holdsNul(read.query)) return 'nul-text'
  // A query key the device does not implement, before every other reason.
  if (unimplementedKey(read) !== undefined) return 'unimplemented-field'
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
      if (libraryPlaylistFilter(query.filters)) return 'library-playlist'
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
      return unsettledFilter('track', query, observed.facts)
        ? 'server-lower-case'
        : undefined
    }
    case 'trackFacets':
    case 'artistFacets':
    case 'filmFacets': {
      if (!memberScope(read.query)) return 'catalog-scope'
      const library =
        read.method === 'trackFacets'
          ? 'track'
          : read.method === 'artistFacets'
            ? 'artist'
            : 'film'
      return unsettledFacetText(library, read.query.q, observed.facts)
        ? 'server-lower-case'
        : undefined
    }
    case 'albumFacets':
      if (!memberScope(read.query)) return 'catalog-scope'
      if (
        read.query.includeArchived === 'true' &&
        albumFacetsReadArtistTags(read.query.tagLevels) &&
        observed.facts.archivedOnlyArtistTags
      )
        return 'archived-artist-tags'
      return unsettledFacetText('album', read.query.q, observed.facts)
        ? 'server-lower-case'
        : undefined
    case 'albumPage':
    case 'albumCount':
    case 'albumList':
    case 'albumHistogram':
      if (!memberScope(read.query)) return 'catalog-scope'
      if (libraryPlaylistFilter(read.query.filters)) return 'library-playlist'
      if (unsettledFilter('album', read.query, observed.facts))
        return 'server-lower-case'
      return read.method !== 'albumHistogram' &&
        isPluginTextSort('album', read.query.sortBy, observed.facts)
        ? 'unknown-field'
        : undefined
    case 'filmPage':
    case 'filmCount':
    case 'filmList':
      if (!memberScope(read.query)) return 'catalog-scope'
      if (libraryPlaylistFilter(read.query.filters)) return 'library-playlist'
      if (read.query.creatorId !== undefined) return 'creator-films'
      if (unsettledFilter('film', read.query, observed.facts))
        return 'server-lower-case'
      return isPluginTextSort('film', read.query.sortBy, observed.facts)
        ? 'unknown-field'
        : undefined
    case 'artistPage':
    case 'artistCount':
    case 'artistHistogram':
      if (!memberScope(read.query)) return 'catalog-scope'
      if (
        read.method === 'artistPage' &&
        nonExcludeProvider(read.query.filters)
      )
        return 'provider-filter'
      return unsettledFilter('artist', read.query, observed.facts)
        ? 'server-lower-case'
        : undefined
    case 'playlistPage':
      if (!memberScope(read.query)) return 'catalog-scope'
      // PL-17: `library` adds that library's playlists, which the feed does not publish.
      if (read.query.library !== undefined) return 'library-playlist'
      return activeImport(observed.data) ? 'active-import' : undefined
    case 'playlistCount':
      if (!memberScope(read.query)) return 'catalog-scope'
      return read.query.library === undefined ? undefined : 'library-playlist'
    case 'fields':
      return undefined
  }
}
