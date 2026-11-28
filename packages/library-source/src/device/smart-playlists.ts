import { z } from 'zod'
import {
  isTagBrowseField,
  LIBRARY_PLAYLIST_FILTER_FIELD,
  type LibraryPlaylistLibrary,
  type LibraryPlaylistView,
} from '@repo/schemas/browse'
import {
  parseLibraryBrowseView,
  type LibraryBrowseQuery,
} from '@repo/schemas/library-playlists'
import { defaultKeyNotation } from '@repo/schemas/musical-keys'
import { describeSavedView } from '@repo/schemas/saved-view-sentence'
import { normalizeTagName, tagDisplayName } from '@repo/schemas/tags'
import type { PlaylistBrowseQuery } from '@repo/schemas/tracks'
import { lowerCaseAsServer, type TextFold } from '../fold'
import type { BrowseCount } from '../source'
import {
  queryKeyCheck,
  unservedQueryKey,
  type QueryKeys,
} from '../compile/query-keys'
import { readRows, sql, values } from '../compile/sql'
import { UnsupportedQuery, unsupported } from '../compile/unsupported'
import { albumCount, albumQueryKeys } from './albums'
import { filmCount, filmQueryKeys } from './films'
import { holdsNul, type DeviceRead } from './read'
import { trackCount, trackQueryKeys } from './tracks'

/**
 * The two rules of the Playlists directory that read a smart playlist's
 * view (playlist-directory.ts): `savedViewText` (filterSavedViewText) and
 * the live count of a count range (countSmartCandidates).
 */

/** A smart playlist of the library, by its row. */
export type SmartPlaylist = { rid: number; view: LibraryPlaylistView }

const NameRowSchema = z.object({ id: z.string(), name: z.string() })

/**
 * The names `describeSavedView` reads for "In playlist": those of the stored
 * (not deleted) library playlists of any library that the views name.
 */
async function readPlaylistNames(
  read: DeviceRead,
  library: LibraryPlaylistLibrary,
  playlists: readonly SmartPlaylist[],
): Promise<Map<string, string>> {
  const ids = new Set<string>()
  for (const { view } of playlists) {
    const parsed = parseLibraryBrowseView(library, view)
    if (!parsed.success) continue
    for (const filter of parsed.data.query.filters)
      if (filter.field === LIBRARY_PLAYLIST_FILTER_FIELD) ids.add(filter.value)
  }
  if (ids.size === 0) return new Map()
  const rows = await readRows(
    read.tx,
    sql`SELECT t.id AS id, json_extract(t.summary, '$.name') AS name
      FROM library_playlist t WHERE t.id IN ${values([...ids])}`,
  )
  return new Map(
    rows.map((row) => {
      const parsed = NameRowSchema.parse(row)
      return [parsed.id, parsed.name]
    }),
  )
}

/**
 * The punctuation outside ASCII the sentences are written with: the
 * separator, the quotes around a search, the ellipsis and the en dash of a
 * missing value. No Unicode version gives them a case.
 */
const SENTENCE_PUNCTUATION = /([·“”…–])/u

/**
 * `text.toLowerCase()` as the server's engine gives it, as
 * `lowerCaseAsServer`, with the sentences' punctuation settled.
 */
function lowerTextAsServer(text: string, fold: TextFold): string | undefined {
  let lowered = ''
  for (const [index, part] of text.split(SENTENCE_PUNCTUATION).entries()) {
    // Odd entries are the punctuation the split kept.
    const piece = index % 2 === 1 ? part : lowerCaseAsServer(part, fold)
    if (piece === undefined) return undefined
    lowered += piece
  }
  return lowered
}

/**
 * `describeSavedView(...).toLowerCase()` as the server's engine gives it, or
 * undefined when the fold cannot settle it: the sentence lower-cased as
 * `lowerTextAsServer` does, and each tag value it formats (formatTagName
 * starts from normalizeTagName, `toLowerCase` in the engine) lower-cased by
 * this engine as the server's would.
 */
function sentenceAsServer(
  library: LibraryPlaylistLibrary,
  view: LibraryPlaylistView,
  options: {
    playlistName: (id: string) => string | null
    timeZone: string
    keyNotation: PlaylistBrowseQuery['keyNotation']
  },
  fold: TextFold,
): string | undefined {
  const parsed = parseLibraryBrowseView(library, view)
  // Subscriptions and Mixes show tag values as stored.
  if (parsed.success && library !== 'subscriptions' && library !== 'mixes')
    for (const filter of parsed.data.query.filters)
      if (
        filter.field !== LIBRARY_PLAYLIST_FILTER_FIELD &&
        isTagBrowseField(filter.field) &&
        normalizeTagName(filter.value) !==
          lowerCaseAsServer(tagDisplayName(filter.value), fold)
      )
        return undefined
  return lowerTextAsServer(
    describeSavedView({ library, view, ...options }),
    fold,
  )
}

/**
 * filterSavedViewText: the smart playlists whose sentence holds the text,
 * both lower-cased. The zone defaults to UTC; the key notation to the
 * default, which the server's `keyDisplayNotation()` always is (only the
 * web client sets it). A needle or sentence the fold cannot settle is
 * `server-lower-case`.
 */
export async function matchSavedViewText(
  read: DeviceRead,
  query: PlaylistBrowseQuery,
  library: LibraryPlaylistLibrary,
  text: string,
  candidates: readonly SmartPlaylist[],
): Promise<number[]> {
  const needle =
    lowerTextAsServer(text, read.fold) ?? unsupported('server-lower-case')
  const names = await readPlaylistNames(read, library, candidates)
  const options = {
    playlistName: (id: string) => names.get(id) ?? null,
    timeZone: query.timeZone ?? 'UTC',
    keyNotation: query.keyNotation ?? defaultKeyNotation,
  }
  return candidates.flatMap(({ rid, view }) => {
    const sentence =
      sentenceAsServer(library, view, options, read.fold) ??
      unsupported('server-lower-case')
    return sentence.includes(needle) ? [rid] : []
  })
}

/** The view without the parameters that only order it, as countSmartCandidates counts it. */
function countCriteria(view: LibraryPlaylistView): LibraryPlaylistView {
  const ordering = new Set(['sortBy', 'direction', 'listeningSort'])
  return Object.fromEntries(
    Object.entries(view).filter(([key]) => !ordering.has(key)),
  )
}

/**
 * The live count of each smart playlist whose view parses without its
 * ordering, from the device's own count reads with this read's clock. A
 * view that does not parse has no count, as the service leaves it out.
 * A count the device cannot read is `smart-count`: Subscriptions and Mixes,
 * a view holding U+0000 or a key its read leaves to the API, and any reason
 * of the count read but `not-ready` and `store-error`, which pass through.
 */
export async function countSmartPlaylists(
  read: DeviceRead,
  library: LibraryPlaylistLibrary,
  playlists: readonly SmartPlaylist[],
): Promise<Map<number, number>> {
  const byView = new Map<string, number>()
  const counts = new Map<number, number>()
  for (const { rid, view } of playlists) {
    const criteria = countCriteria(view)
    const key = JSON.stringify(criteria, Object.keys(criteria).sort())
    let count = byView.get(key)
    if (count === undefined) {
      const parsed = parseLibraryBrowseView(library, criteria)
      if (!parsed.success) continue
      count = await smartCount(read, parsed.data)
      byView.set(key, count)
    }
    counts.set(rid, count)
  }
  return counts
}

/** smartPlaylistCount: queryBrowseCount of the view's library. */
function smartCount(
  read: DeviceRead,
  browse: LibraryBrowseQuery,
): Promise<number> {
  switch (browse.library) {
    case 'tracks':
      return countWith(read, browse.query, trackQueryKeys, trackCount)
    case 'albums':
      return countWith(read, browse.query, albumQueryKeys, albumCount)
    case 'films':
      return countWith(read, browse.query, filmQueryKeys, filmCount)
    case 'subscriptions':
    case 'mixes':
      return unsupported('smart-count')
  }
}

async function countWith<Query extends Readonly<Record<string, unknown>>>(
  read: DeviceRead,
  query: Query,
  keys: QueryKeys<NoInfer<Query>>,
  count: (read: DeviceRead, query: Query) => Promise<BrowseCount>,
): Promise<number> {
  if (
    holdsNul(query) ||
    unservedQueryKey([queryKeyCheck(query, keys)]) !== undefined
  )
    return unsupported('smart-count')
  try {
    return (await count(read, query)).totalCount
  } catch (error) {
    if (
      error instanceof UnsupportedQuery &&
      error.reason !== 'not-ready' &&
      error.reason !== 'store-error'
    )
      return unsupported('smart-count')
    throw error
  }
}
