import {
  albumBrowseFields,
  filmBrowseFields,
  formatBrowseFilterValue,
  LIBRARY_PLAYLIST_FILTER_FIELD,
  trackBrowseFields,
  type BrowseField,
  type BrowseFilter,
  type BrowseRange,
} from '@repo/schemas/browse'
import {
  parseLibraryBrowseView,
  type LibraryPlaylistLibrary,
  type LibraryPlaylistView,
} from '@repo/schemas/library-playlists'
import type { ListeningFilter } from '@repo/schemas/listening'
import {
  subscriptionBrowseFieldsFor,
  type SubscriptionSort,
} from '@repo/schemas/subscriptions'
import { mediaRangeLabel, trackRangeLabel } from './browse-items'
import { libraryPlaylistNouns } from './library-playlists'
import {
  formatListeningFilter,
  listeningNoun,
  listeningScrobblesField,
} from './listening-filters'
import {
  subscriptionRangeLabel,
  subscriptionSort,
  subscriptionSortLabelsFor,
} from './subscriptions'

/**
 * A playlist's name for "In playlist: Name": null when it no longer exists,
 * undefined while it is not known yet.
 */
export type PlaylistNameLookup = (id: string) => string | null | undefined

type Direction = 'asc' | 'desc'

/** The fields each library's Browse chips and sort picker name. */
function defaultFields(library: LibraryPlaylistLibrary): BrowseField[] {
  switch (library) {
    case 'albums':
      return albumBrowseFields
    case 'tracks':
      return trackBrowseFields
    case 'films':
      return filmBrowseFields
    case 'subscriptions':
    case 'mixes':
      return subscriptionBrowseFieldsFor(library)
  }
}

/**
 * PL-41: newest or oldest first for dates, A to Z or Z to A for text,
 * longest or shortest first for durations, highest or lowest first otherwise.
 */
export function directionWords(
  field: Pick<BrowseField, 'type' | 'format'>,
  direction: Direction,
) {
  const desc = direction === 'desc'
  if (field.type === 'date') return desc ? 'newest first' : 'oldest first'
  if (field.type === 'text') return desc ? 'Z to A' : 'A to Z'
  if (field.format === 'seconds' || field.format === 'minutes')
    return desc ? 'longest first' : 'shortest first'
  return desc ? 'highest first' : 'lowest first'
}

/** The Subscriptions and Mixes sorts that are not one of their fields. */
const subscriptionSortFields: Record<
  SubscriptionSort,
  Pick<BrowseField, 'type' | 'format'> | null
> = {
  relevance: null,
  publishedAt: { type: 'date' },
  title: { type: 'text' },
  source: { type: 'text' },
  durationSec: { type: 'number', format: 'seconds' },
  watchedAt: { type: 'date' },
  viewCount: { type: 'number' },
  likeCount: { type: 'number' },
  commentCount: { type: 'number' },
}

function orderText(
  label: string,
  field: Pick<BrowseField, 'type' | 'format'> | null | undefined,
  direction: Direction,
) {
  return field ? `${label}, ${directionWords(field, direction)}` : label
}

/**
 * PL-41: the sentence names a field in the singular, "Tag: Ambient or Jazz",
 * where the Browse field's label, which the chips keep, is plural.
 */
const singularFieldLabels: Readonly<Record<string, string>> = {
  Actors: 'Actor',
  'Album tags': 'Album tag',
  Artists: 'Artist',
  'Artist tags': 'Artist tag',
  Collections: 'Collection',
  Countries: 'Country',
  Directors: 'Director',
  Languages: 'Language',
  Playlists: 'Playlist',
  'Production companies': 'Production company',
  Tags: 'Tag',
  'Track tags': 'Track tag',
  Writers: 'Writer',
}

/** A Browse field's label as the sentence names it. */
export function singularFieldLabel(label: string) {
  return singularFieldLabels[label] ?? label
}

/**
 * Field filters, grouped by field and mode in the order they were added:
 * Any values joined with "or", Required with "and", Exclude read "Not".
 */
function filterParts(
  filters: readonly BrowseFilter[],
  label: (field: string) => string,
  value: (filter: BrowseFilter) => string,
) {
  const groups = new Map<
    string,
    { label: string; mode: BrowseFilter['mode']; values: string[] }
  >()
  for (const filter of filters) {
    const key = `${filter.field}\u0000${filter.mode ?? 'any'}`
    const group = groups.get(key) ?? {
      label: label(filter.field),
      mode: filter.mode,
      values: [],
    }
    group.values.push(value(filter))
    groups.set(key, group)
  }
  return [...groups.values()].map(({ label, mode, values }) =>
    mode === 'required'
      ? `${label}: ${values.join(' and ')}`
      : mode === 'exclude'
        ? `${label}: Not ${values.join(' or ')}`
        : `${label}: ${values.join(' or ')}`,
  )
}

/**
 * PL-41: a saved view written out, its filters and then its order, joined
 * with " · ": "Tag: Ambient or Jazz · Search: “rain” · In playlist: Late
 * shift · Added, newest first". Without a filter it starts "All tracks".
 * Values and range and listening labels are the ones the Browse chips show,
 * and field names their labels in the singular; `fields` are the library's
 * Browse fields when they are loaded.
 */
export function describeSavedView({
  library,
  view,
  playlistName,
  fields = defaultFields(library),
}: {
  library: LibraryPlaylistLibrary
  view: LibraryPlaylistView
  playlistName: PlaylistNameLookup
  fields?: readonly BrowseField[]
}): string {
  const all = `All ${libraryPlaylistNouns[library].other}`
  const parsed = parseLibraryBrowseView(library, view)
  if (!parsed.success) return all
  const { data } = parsed
  const query: {
    q?: string
    filters: BrowseFilter[]
    ranges: BrowseRange[]
    sortBy?: string
    direction: Direction
    listening?: ListeningFilter
    limitResults?: number
  } = data.query
  const listening =
    data.library === 'albums' || data.library === 'tracks'
      ? data.query.listening
      : undefined
  const listeningSort =
    data.library === 'albums' || data.library === 'tracks'
      ? data.query.listeningSort
      : undefined
  const named = [...fields, listeningScrobblesField(listeningSort)]
  const subscriptions = library === 'subscriptions' || library === 'mixes'
  const fieldLabel = (key: string) =>
    singularFieldLabel(named.find((field) => field.key === key)?.label ?? key)
  const playlistFilters = query.filters.filter(
    (filter) => filter.field === LIBRARY_PLAYLIST_FILTER_FIELD,
  )
  const parts = [
    ...filterParts(
      query.filters.filter(
        (filter) => filter.field !== LIBRARY_PLAYLIST_FILTER_FIELD,
      ),
      fieldLabel,
      (filter) =>
        // Subscriptions and Mixes chips show tag values as stored.
        subscriptions
          ? filter.value
          : formatBrowseFilterValue(filter.field, filter.value),
    ),
    ...(query.q?.trim() ? [`Search: “${query.q.trim()}”`] : []),
    ...filterParts(
      playlistFilters,
      () => 'In playlist',
      (filter) => {
        const name = playlistName(filter.value)
        return name === undefined ? '…' : (name ?? 'removed')
      },
    ),
    ...query.ranges.map((range) =>
      subscriptions
        ? subscriptionRangeLabel(range, [...named])
        : library === 'tracks'
          ? trackRangeLabel(range, named)
          : mediaRangeLabel(range, named),
    ),
    ...(listening
      ? [
          formatListeningFilter(
            listening,
            listeningNoun(library === 'tracks' ? 'track' : 'album'),
          ).replace(/\.$/, ''),
        ]
      : []),
    ...(query.limitResults
      ? [
          library === 'tracks'
            ? `Limit: ${query.limitResults}`
            : `Top ${query.limitResults}`,
        ]
      : []),
  ]
  let order: string
  if (data.library === 'subscriptions' || data.library === 'mixes') {
    // The sort Subscriptions Browse uses when the view names none.
    const sortBy = subscriptionSort({
      q: data.query.q ?? '',
      sortBy: data.query.sortBy ?? null,
    })
    order = orderText(
      subscriptionSortLabelsFor(data.library)[sortBy],
      subscriptionSortFields[sortBy],
      query.direction,
    )
  } else {
    // Browse sorts by Added when the view names no order.
    const sortBy = data.query.sortBy ?? 'dateAdded'
    const field = named.find((field) => field.key === sortBy)
    order = orderText(field?.label ?? sortBy, field, query.direction)
  }
  return [...(parts.length ? parts : [all]), order].join(' · ')
}
