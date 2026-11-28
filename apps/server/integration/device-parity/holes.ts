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

/**
 * The order of reasons of docs/requirements/device-store.md: when a read
 * holds the conditions of several Known holes, the device answers the first
 * of them in this order. `not-ready` and `store-error` describe the store,
 * not the query, and are not expected of a filled store.
 */
export const reasonOrder: readonly UnsupportedReason[] = [
  'nul-text',
  'unimplemented-field',
  'catalog-scope',
  'library-playlist',
  'grouped-creator-scope',
  'creator-films',
  'invalid-query',
  'unknown-field',
  'provider-filter',
  'creator-tag-sort',
  'archived-artist-tags',
  'server-lower-case',
  'active-import',
]

/**
 * The conditions of every Known hole this read holds, each computed on its
 * own from the query, the API's answer and the data facts.
 */
function heldHoles(
  read: LibraryRead,
  observed: Observed,
): Set<UnsupportedReason> {
  const held = new Set<UnsupportedReason>()
  const hold = (reason: UnsupportedReason, condition: boolean) => {
    if (condition) held.add(reason)
  }
  // Text holding U+0000 is left to the API, whatever it answers.
  hold('nul-text', holdsNul(read.query))
  hold('unimplemented-field', unimplementedKey(read) !== undefined)
  // A query the API rejects is left to the API.
  hold('invalid-query', observed.status !== 200)
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
      hold('catalog-scope', !memberScope(query, 'track'))
      hold('library-playlist', libraryPlaylistFilter(query.filters))
      hold(
        'grouped-creator-scope',
        (recordings || query.groupRecordings === true) &&
          query.creatorId !== undefined,
      )
      // Counts, histograms and positions carry no provider links.
      const returnsItems =
        read.method === 'trackPage' ||
        read.method === 'trackList' ||
        read.method === 'trackRecordings'
      hold('provider-filter', returnsItems && nonExcludeProvider(query.filters))
      hold(
        'creator-tag-sort',
        query.sortBy === 'genre' &&
          query.tagLevels === undefined &&
          (query.creatorId !== undefined || recordings),
      )
      hold('server-lower-case', unsettledFilter('track', query, observed.facts))
      break
    }
    case 'trackFacets':
    case 'artistFacets':
    case 'filmFacets': {
      const library =
        read.method === 'trackFacets'
          ? 'track'
          : read.method === 'artistFacets'
            ? 'artist'
            : 'film'
      hold('catalog-scope', !memberScope(read.query))
      hold(
        'server-lower-case',
        unsettledFacetText(library, read.query.q, observed.facts),
      )
      break
    }
    case 'albumFacets':
      hold('catalog-scope', !memberScope(read.query))
      hold(
        'archived-artist-tags',
        read.query.includeArchived === 'true' &&
          albumFacetsReadArtistTags(read.query.tagLevels) &&
          observed.facts.archivedOnlyArtistTags,
      )
      hold(
        'server-lower-case',
        unsettledFacetText('album', read.query.q, observed.facts),
      )
      break
    case 'albumPage':
    case 'albumCount':
    case 'albumList':
    case 'albumHistogram':
      hold('catalog-scope', !memberScope(read.query))
      hold('library-playlist', libraryPlaylistFilter(read.query.filters))
      hold(
        'unknown-field',
        read.method !== 'albumHistogram' &&
          isPluginTextSort('album', read.query.sortBy, observed.facts),
      )
      hold(
        'server-lower-case',
        unsettledFilter('album', read.query, observed.facts),
      )
      break
    case 'filmPage':
    case 'filmCount':
    case 'filmList':
      hold('catalog-scope', !memberScope(read.query))
      hold('library-playlist', libraryPlaylistFilter(read.query.filters))
      hold('creator-films', read.query.creatorId !== undefined)
      hold(
        'unknown-field',
        isPluginTextSort('film', read.query.sortBy, observed.facts),
      )
      hold(
        'server-lower-case',
        unsettledFilter('film', read.query, observed.facts),
      )
      break
    case 'artistPage':
    case 'artistCount':
    case 'artistHistogram':
      hold('catalog-scope', !memberScope(read.query))
      hold(
        'provider-filter',
        read.method === 'artistPage' && nonExcludeProvider(read.query.filters),
      )
      hold(
        'server-lower-case',
        unsettledFilter('artist', read.query, observed.facts),
      )
      break
    case 'playlistPage':
    case 'playlistCount':
      hold('catalog-scope', !memberScope(read.query))
      // PL-17: `library` adds that library's playlists, which the feed does not publish.
      hold('library-playlist', read.query.library !== undefined)
      hold(
        'active-import',
        read.method === 'playlistPage' && activeImport(observed.data),
      )
      break
    case 'fields':
      break
  }
  return held
}

/**
 * The reason the device must give for this read: the first, in the order
 * of reasons, of the Known holes it holds; undefined when it must serve it.
 */
export function expectedHole(
  read: LibraryRead,
  observed: Observed,
): UnsupportedReason | undefined {
  const held = heldHoles(read, observed)
  return reasonOrder.find((reason) => held.has(reason))
}
