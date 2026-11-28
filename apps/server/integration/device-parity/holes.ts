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
  isTagBrowseField,
  LIBRARY_PLAYLIST_FILTER_FIELD,
  type LibraryPlaylistLibrary,
  type LibraryPlaylistView,
} from '@repo/schemas/browse'
import { memberScope } from '@repo/schemas/catalog'
import { parseLibraryBrowseView } from '@repo/schemas/library-playlists'
import { describeSavedView } from '@repo/schemas/saved-view-sentence'
import { normalizeTagName, tagDisplayName } from '@repo/schemas/tags'
import {
  PlaylistBrowsePageSchema,
  type PlaylistBrowseQuery,
} from '@repo/schemas/tracks'
import { apiPath } from './matrix'

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
  /**
   * The names of the library playlists that are not deleted, of every
   * library, by ID: the names a saved view's sentence gives "In playlist".
   */
  playlistNames: ReadonlyMap<string, string>
  /**
   * For each library, whether the device can count every smart playlist of
   * it that is not deleted and whose view, without the parameters that only
   * order it, parses (Known holes, `smart-count`).
   */
  smartCountable: Record<LibraryPlaylistLibrary, boolean>
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

export type ApiAnswer = { status: number; data: unknown }

export type Observed = {
  /** The API's status for the path. */
  status: number
  /** The API's data, parsed, when it answered 200. */
  data: unknown
  facts: DataFacts
  /** Another read of the API, for a hole that the API's rows decide. */
  readApi: (path: string) => Promise<ApiAnswer>
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

type ColumnRange = { min?: number | string; max?: number | string }

const hasBound = (range: ColumnRange | undefined) =>
  range?.min !== undefined || range?.max !== undefined

/** A Playlists directory date range with a bound: a bound that is a date. */
function holdsDateBound(query: PlaylistBrowseQuery) {
  const ranges: Record<string, ColumnRange | undefined> =
    query.columnRanges ?? {}
  return Object.values(ranges).some(
    (range) => typeof (range?.min ?? range?.max) === 'string',
  )
}

/**
 * Known holes, `time-zone`: a zone other than `UTC` or an `Area/Location`
 * name (letters, then one or more `/` parts, not starting `Etc/` in any
 * case). Without a zone the directory reads UTC.
 */
function zoneReadAsServer(zone: string | undefined) {
  if (zone === undefined || zone === 'UTC') return true
  return (
    /^[A-Za-z]+(\/[A-Za-z0-9_+-]+)+$/u.test(zone) &&
    !zone.toLowerCase().startsWith('etc/')
  )
}

/** `types` empty, absent or holding Smart: the directory reads smart rows' views. */
const readsSmartRows = (query: PlaylistBrowseQuery) =>
  !query.types?.length || query.types.includes('smart')

/** The punctuation of the sentences outside ASCII, which has no case. */
const SENTENCE_PUNCTUATION = /[·“”…–]/gu

/** Whether the fold cannot settle `text.toLowerCase()` outside the sentences' punctuation. */
const unsettledSentence = (text: string, fold: FoldFacts) =>
  unsettledLowerCase(text.replace(SENTENCE_PUNCTUATION, ''), fold)

/**
 * The fold's lower case of settled text: U+0130 as the engine writes it,
 * each code point the database maps to one, and the rest as it is.
 */
function foldLower(text: string, fold: FoldFacts) {
  return [...text]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0
      if (codePoint === 0x130) return 'i̇'
      return fold.lower.get(codePoint) ?? character
    })
    .join('')
}

/**
 * A tag filter value of a view of Albums, Tracks or Films whose
 * `normalizeTagName` on the device differs from the fold's lower case of its
 * `tagDisplayName`, or whose lower case the fold cannot settle.
 */
function unsettledTagValue(
  library: LibraryPlaylistLibrary,
  view: LibraryPlaylistView,
  fold: FoldFacts,
) {
  if (library === 'subscriptions' || library === 'mixes') return false
  const parsed = parseLibraryBrowseView(library, view)
  if (!parsed.success) return false
  return parsed.data.query.filters.some((filter) => {
    if (
      filter.field === LIBRARY_PLAYLIST_FILTER_FIELD ||
      !isTagBrowseField(filter.field)
    )
      return false
    const display = tagDisplayName(filter.value)
    return (
      unsettledLowerCase(display, fold) ||
      normalizeTagName(filter.value) !== foldLower(display, fold)
    )
  })
}

/**
 * The views of the smart rows of the query's library that pass every
 * filter but `savedViewText` and the count range, read from the API.
 */
async function smartCandidateViews(
  query: PlaylistBrowseQuery,
  observed: Observed,
): Promise<LibraryPlaylistView[]> {
  const ranges = Object.entries(query.columnRanges ?? {}).filter(
    ([key]) => key !== 'count',
  )
  const views: LibraryPlaylistView[] = []
  for (let page = 1; ; page += 1) {
    const answer = await observed.readApi(
      apiPath('playlists/browse-page', {
        ...query,
        savedViewText: undefined,
        types: ['smart'],
        columnRanges: ranges.length ? Object.fromEntries(ranges) : undefined,
        page,
        size: 100,
      }),
    )
    const parsed = PlaylistBrowsePageSchema.parse(answer.data)
    for (const item of parsed.items)
      if (item.type === 'smart' && item.view) views.push(item.view)
    if (!parsed.hasMore) return views
  }
}

/**
 * Known holes, `server-lower-case` for `savedViewText`: with `library`, and
 * `types` not leaving Smart out, the text, or the sentence of a smart row
 * that passes the other filters, holds a code point the fold cannot settle
 * outside the sentences' punctuation, or such a row's view holds a tag
 * filter value the fold cannot match (unsettledTagValue).
 */
async function unsettledSavedViewText(
  query: PlaylistBrowseQuery,
  observed: Observed,
) {
  const { library, savedViewText: text } = query
  const { fold, playlistNames } = observed.facts
  if (library === undefined || !text || !readsSmartRows(query)) return false
  if (unsettledSentence(text, fold)) return true
  const views = await smartCandidateViews(query, observed)
  return views.some(
    (view) =>
      unsettledSentence(
        describeSavedView({
          library,
          view,
          playlistName: (id) => playlistNames.get(id) ?? null,
          timeZone: query.timeZone ?? 'UTC',
          keyNotation: query.keyNotation,
        }),
        fold,
      ) || unsettledTagValue(library, view, fold),
  )
}

/**
 * Known holes, `smart-count`: with `library`, a count range with a bound
 * and `types` not leaving Smart out, while some smart playlist of the
 * library cannot be counted on the device.
 */
const smartCountHole = (query: PlaylistBrowseQuery, facts: DataFacts) =>
  query.library !== undefined &&
  hasBound(query.columnRanges?.count) &&
  readsSmartRows(query) &&
  !facts.smartCountable[query.library]

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
  'time-zone',
  'grouped-creator-scope',
  'creator-films',
  'invalid-query',
  'unknown-field',
  'provider-filter',
  'creator-tag-sort',
  'archived-artist-tags',
  'server-lower-case',
  'smart-count',
  'active-import',
]

/**
 * The conditions of every Known hole this read holds, each computed on its
 * own from the query, the API's answer and the data facts.
 */
async function heldHoles(
  read: LibraryRead,
  observed: Observed,
): Promise<Set<UnsupportedReason>> {
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
      hold(
        'time-zone',
        holdsDateBound(read.query) && !zoneReadAsServer(read.query.timeZone),
      )
      hold(
        'server-lower-case',
        await unsettledSavedViewText(read.query, observed),
      )
      hold('smart-count', smartCountHole(read.query, observed.facts))
      hold(
        'active-import',
        read.method === 'playlistPage' && activeImport(observed.data),
      )
      break
    case 'libraryPlaylistList':
    case 'fields':
      break
  }
  return held
}

/**
 * The reason the device must give for this read: the first, in the order
 * of reasons, of the Known holes it holds; undefined when it must serve it.
 */
export async function expectedHole(
  read: LibraryRead,
  observed: Observed,
): Promise<UnsupportedReason | undefined> {
  const held = await heldHoles(read, observed)
  return reasonOrder.find((reason) => held.has(reason))
}
