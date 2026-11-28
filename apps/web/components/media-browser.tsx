'use client'

import { ResultSection } from './result-feedback'
import { ReadButton } from '@/components/read-button'
import { useRestoreBrowsePreferences } from './workspace-tab-context'
import { DetailInspector } from './detail-inspector'
import { DetailListFrame } from './detail-list-frame'
import { CreatorLinks } from './creator-links'
import { CollectionLinks } from './collection-links'
import { CreatorScopeChip } from './creator-scope-chip'
import {
  clearCreatorScope,
  parseCreatorBrowseScope,
  type CreatorBrowseScope,
} from '@/utils/creator-browse'
import { useDetailInspector } from './detail-inspector-context'
import {
  detailPageHref,
  sameDetail,
  tagDetailId,
} from '@/utils/detail-inspector'
import { workspaceTabLinkProps } from '@/utils/workspace-tab-destination'
import { fitDetailList } from '@/utils/detail-list-space'

import Link from 'next/link'
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import { ListMusic } from 'lucide-react'
import { normalizeTagName } from '@repo/schemas/tags'
import { Button } from '@repo/ui/components/ui/button'
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableColumns,
  columnsWidth,
} from '@repo/ui/components/ui/table'
import { Card, CardGrid, CardTitle } from '@repo/ui/components/ds/card'
import {
  List,
  ListHead,
  ListRow,
  RowTitle,
  RowValue,
} from '@repo/ui/components/ds/list-row'
import {
  EmptyValue,
  Pill,
  PillLabel,
  Pills,
  Rating,
} from '@repo/ui/components/ds/pill'
import { Notice, Skeleton, State } from '@repo/ui/components/ds/feedback'
import { Select } from '@repo/ui/components/ds/toolbar'
import { formatItemCount, formatRuntime } from '@repo/ui/lib/format'
import { SavedViewSchema } from '@repo/schemas/imports'
import {
  defaultListeningPeriod,
  type ListeningFilter,
} from '@repo/schemas/listening'
import { PaginatedDataSchema } from '@repo/schemas/common'
import {
  AlbumListItemSchema,
  FilmListItemSchema,
  type AlbumListItem,
  type FilmListItem,
} from '@repo/schemas/media'
import {
  BrowseFieldSchema,
  BrowseFilterSchema,
  BrowseRangesParamSchema,
  albumBrowseFields,
  filmBrowseFields,
  getBrowseValues,
  formatBrowseValue,
  filmIdentificationStatus,
  canonicalBrowseKey,
  formatTagLevelsParam,
  sameBrowseFilter,
  selectedBrowseProviders,
  type BrowseField,
  type BrowseFilter,
  type BrowseValues,
} from '@repo/schemas/browse'
import { useConfig } from './providers'
import { usePlayback } from './playback-provider'
import { fetchApiData } from '@/utils/api'
import { useVirtualBrowse } from '@/hooks/useVirtualBrowse'
import {
  useEmbeddedBrowse,
  usePageBrowse,
  type BrowseHost,
} from '@/hooks/useBrowseHost'
import {
  embeddedScrollClass,
  type EmbeddedBrowse,
} from '@/utils/embedded-browse'
import { useBrowseFacets } from '@/hooks/useBrowseFacets'
import {
  clearLibraryScope,
  libraryScopeFilterCount,
  libraryScopeQuery,
  libraryScopeUpdates,
  readLibraryScope,
  type LibraryScopeState,
} from '@/utils/library-scope'
import { useProviderDisplayName } from '@/hooks/useProviderDisplayName'
import {
  listRowHeight,
  tableHeaderHeight,
  tableRowHeight,
} from '@/hooks/useVirtualTable'
import AiSearch from './ai-search'
import { aiSearchParams, mediaAiSearchTarget } from '@/utils/ai-search'
import { MediaArt, MediaThumb } from './media-artwork'
import { AlbumInlinePlayButton, TilePlayControls } from './play-controls'
import { FilteredProviderLinks } from './service-icon-links'
import { mediaBrowseLinkCandidates } from '@/utils/media-browse-links'
import { createBrowsePlaybackSource } from '@/utils/playback-source'
import ManualMediaAdd from './manual-media-add'
import {
  BrowseFilterChips,
  BrowseFilterPill,
  BrowseTagBadges,
  RangeEditor,
} from './browse-controls'
import { ListeningControls, ListeningFilterPills } from './listening-controls'
import BrowseToolbar, { BrowseColumnsSection } from './browse-toolbar'
import { LibraryScopePills } from './library-scope-controls'
import { FilterPanelSection } from './browse-filter-panel'
import { TagLocationSection } from './tag-location-section'
import {
  BrowsePlaceholderRow,
  BrowseSortHead,
  BrowseSpacerRow,
} from './browse-table'
import { DetailLink } from './detail-link'
import {
  listeningScrobblesField,
  parseListeningParams,
} from '@/utils/listening-filters'
import {
  cardDetails,
  cardGrid,
  defaultBrowseView,
  formatCardDetails,
  mediaGridGeometry,
  parseBrowseView,
  parseCardDetails,
  preserveGridScroll,
  restoreSavedBrowse,
} from '@/utils/media-grid'
import { useRailSlot } from '@/hooks/useRailSlot'
import { useGridDensity } from '@/hooks/useGridDensity'
import {
  getProviderRating,
  ratingScore,
  ratingSource,
} from '@/utils/provider-ratings'
import {
  matchingTitleFilters,
  titleSuggestions,
} from '@/utils/browse-suggestions'
import {
  browseFilterHref,
  browseSearchHref,
  columnOrderParam,
  hasCustomColumnOrder,
  orderColumns,
  orderFields,
  parseColumnOrder,
  parseTagLevelsParam,
} from '@/utils/browse-items'
import { ColumnChoices } from './browse-items'
import {
  MergeBar,
  RowSelectAll,
  RowSelectRow,
  rowSelectionWidth,
  useRowSelection,
} from './merge-bar'
import { albumMergeAdapter } from './album-merge-review'
import { libraryItemMore } from './item-more'
import { AddToPlaylistButton } from './library-playlist-picker'
import { ResultLineSlot } from './result-line'
import { suggestedPlaylistName } from '@/utils/library-playlists'

type MediaItem = AlbumListItem | FilmListItem

const PageSchema = PaginatedDataSchema(
  z.union([AlbumListItemSchema, FilmListItemSchema]),
)
const WidthsSchema = z.record(z.string(), z.number().min(70).max(650))

/** Default table columns, in the design library's one order. */
export const defaultAlbumColumns = [
  'title',
  'artist',
  'releaseDate',
  'dateAdded',
  'trackCount',
  'scrobbles',
  'ratingRymValue',
  'genre',
]
export const defaultFilmColumns = [
  'title',
  'director',
  'releaseDate',
  'runtimeMinutes',
  'watched',
  'dateAdded',
  'ratingImdbValue',
  'ratingMetascore',
  'ratingRt',
  'genre',
]
/**
 * Column and picker order: identity, creator, properties, dates, counts,
 * ratings, pills. Fields not named here, such as plugin ratings, go before
 * the pill columns.
 */
const albumFieldOrder = [
  'title',
  'artist',
  'country',
  'source',
  'provider',
  'edition',
  'durationSec',
  'releaseDate',
  'dateAdded',
  'lastListenedAt',
  'trackCount',
  'scrobbles',
  'scrobblesLast1y',
  'scrobblesLast5y',
  'listeningScrobbles',
  'ratingRymValue',
  'ratingRymVotes',
  'ratingDiscogsValue',
  'ratingDiscogsVotes',
  'ratingMetacriticValue',
  'ratingMetacriticVotes',
  'popularityDiscogs',
  'popularitySpotify',
  'popularityLastFm',
  'playlist',
  'collection',
  'albumTag',
  'artistTag',
  'genre',
]
const filmFieldOrder = [
  'title',
  'director',
  'actor',
  'writer',
  'country',
  'language',
  'productionCompany',
  'source',
  'identification',
  'provider',
  'releaseDate',
  'runtimeMinutes',
  'watched',
  'dateAdded',
  'updatedAt',
  'ratingImdbPersonal',
  'ratingImdbPersonalDate',
  'ratingImdbValue',
  'ratingImdbVotes',
  'ratingMetascore',
  'ratingRt',
  'ratingTmdbValue',
  'ratingTmdbVotes',
  'popularityTmdb',
  'ratingMetacriticUser',
  'ratingMetacriticUserVotes',
  'ratingTrakt',
  'ratingTraktVotes',
  'ratingLetterboxd',
  'ratingLetterboxdVotes',
  'ratingRtAudience',
  'ratingRtAudienceVotes',
  'budget',
  'boxOffice',
  'awards',
  'summary',
  'collection',
  'playlist',
  'genre',
]
/** Columns of pills absorb spare width, so they come last. */
const pillColumns = new Set([
  'genre',
  'albumTag',
  'artistTag',
  'playlist',
  'collection',
])
/** The one rating a card shows when the grid is not sorted by another. */
const headlineRating = { album: 'ratingRymValue', film: 'ratingImdbValue' }
/** Sorts whose value already sits on the card (title, creator, year). */
const sortsShownOnCard = new Set(['title', 'artist', 'director', 'releaseDate'])

const cardDetailLabels = {
  ratings: 'Rating',
  sort: 'Sorted value',
  tags: 'Tags',
}

function parseFilters(value: string | null): BrowseFilter[] {
  try {
    return z
      .array(BrowseFilterSchema)
      .max(100)
      .parse(JSON.parse(value ?? '[]'))
  } catch {
    return []
  }
}

/** Fields in the default column order, with the pill columns last. */
function mediaColumnFields(
  fields: readonly BrowseField[],
  mediaType: 'album' | 'film',
) {
  const ordered = orderFields(
    fields,
    mediaType === 'album' ? albumFieldOrder : filmFieldOrder,
  )
  return [
    ...ordered.filter((field) => !pillColumns.has(field.key)),
    ...ordered.filter((field) => pillColumns.has(field.key)),
  ]
}

function isMissing(value: BrowseValues[string] | undefined) {
  return (
    value === null ||
    value === undefined ||
    value === '' ||
    (Array.isArray(value) && value.length === 0)
  )
}

/** A field's header and rating label: ratings use their short source. */
function columnLabel(field: BrowseField) {
  return field.rating ? ratingSource(field.rating, field.label) : field.label
}

/** What an album's row stands for: its other editions, or that it is an edition. */
function AlbumRecordNote({ album }: { album: AlbumListItem }) {
  if (album.editionOfId) return <span className="ds-muted">Edition</span>
  const count = album.editionCount ?? 0
  if (!count) return null
  return (
    <span className="ds-muted ds-num">
      +{formatItemCount(count, { one: 'edition', other: 'editions' })}
    </span>
  )
}

export default function MediaBrowser({
  mediaType,
}: {
  mediaType: 'album' | 'film'
}) {
  return (
    <MediaBrowse
      mediaType={mediaType}
      host={usePageBrowse(mediaType === 'album' ? 'albums' : 'films')}
    />
  )
}

/**
 * The Albums or Films browser inside a detail, held to one creator's items.
 * It has every control of the Browse page; Show in Albums or Show in Films
 * shows the same result there.
 */
export function EmbeddedMediaBrowser({
  mediaType,
  creator,
  storage,
  sort,
  filterPanel,
  countActions,
  beforeResults,
}: {
  mediaType: 'album' | 'film'
  creator: CreatorBrowseScope
  /** Names the list's view, layout and column widths in browser storage. */
  storage: string
  sort: EmbeddedBrowse['sort']
  /** Controls of the detail that choose the scope, such as a person's role. */
  filterPanel?: { controls: ReactNode; count: number }
  countActions?: ReactNode
  beforeResults?: ReactNode
}) {
  const host = useEmbeddedBrowse(
    mediaType === 'album' ? 'albums' : 'films',
    { scope: creator, storage, mediaType, sort },
    defaultBrowseView(mediaType),
  )
  return (
    <MediaBrowse
      mediaType={mediaType}
      host={host}
      scope={creator}
      filterPanel={filterPanel}
      countActions={countActions}
      beforeResults={beforeResults}
    />
  )
}

function MediaBrowse({
  mediaType,
  host,
  scope,
  filterPanel,
  countActions,
  beforeResults,
}: {
  mediaType: 'album' | 'film'
  host: BrowseHost
  /** The creator a list inside a detail is held to. */
  scope?: CreatorBrowseScope
  filterPanel?: { controls: ReactNode; count: number }
  countActions?: ReactNode
  beforeResults?: ReactNode
}) {
  const collection = mediaType === 'album' ? 'albums' : 'films'
  const noun =
    mediaType === 'album'
      ? { one: 'album', other: 'albums' }
      : { one: 'film', other: 'films' }
  const { apiBaseUrl } = useConfig()
  const playback = usePlayback()
  const { embedded } = host
  const searchParams = host.params
  const libraryScope = readLibraryScope(searchParams)
  const catalogParams = libraryScopeQuery(libraryScope)
  const restoreBrowsePreferences = useRestoreBrowsePreferences()
  const [ready, setReady] = useState(embedded)
  const [draft, setDraft] = useState('')
  const [adding, setAdding] = useState(false)
  const [scroll, setScroll] = useState({ identity: '', top: 0 })
  const [scrolledSideways, setScrolledSideways] = useState(false)
  const [gridLayout, setGridLayout] = useState<{
    identity: string
    columns: number
    rowHeight: number
  } | null>(null)
  const [viewport, setViewport] = useState({ width: 1000, height: 800 })
  const [widths, setWidths] = useState<Record<string, number>>({})
  const scroller = useRef<HTMLDivElement>(null)
  const frame = useRef<HTMLDivElement>(null)
  const browser = useRef<HTMLElement>(null)
  const inspector = useDetailInspector()
  const pageRail = useRailSlot()
  // Inside a detail the active filters sit in a row above the results.
  const railSlot = embedded ? null : pageRail
  const filters = parseFilters(searchParams.get('filters'))
  const filteredProviders = selectedBrowseProviders(filters)
  const creator = scope ?? parseCreatorBrowseScope(searchParams, mediaType)
  const rangesResult = BrowseRangesParamSchema.safeParse(
    searchParams.get('ranges'),
  )
  const ranges = rangesResult.success ? rangesResult.data : []
  const listeningParams = parseListeningParams(searchParams)
  const listening =
    mediaType === 'album' ? listeningParams.listening : undefined
  const listeningSort =
    mediaType === 'album' ? listeningParams.listeningSort : undefined
  const listeningPeriod = listeningSort ?? defaultListeningPeriod
  // Films have one level of tags.
  const tagLevels =
    mediaType === 'album'
      ? parseTagLevelsParam(searchParams.get('tagLevels'))
      : undefined
  const tagLevelsParam = formatTagLevelsParam(tagLevels)
  const q = searchParams.get('q') ?? ''
  const includeArchived = searchParams.get('includeArchived') === 'true'
  // Editions are listed under their first album unless they are asked for as rows.
  const editions =
    mediaType === 'album' && searchParams.get('editions') === 'true'
  const limitResults = searchParams.get('limitResults')
  const savedViews = useQuery({
    queryKey: ['saved-views'],
    enabled: mediaType === 'album',
    queryFn: () =>
      fetchApiData(
        apiBaseUrl,
        '/api/v1/imports/saved-views',
        z.array(SavedViewSchema),
      ),
  })
  const sortBy = canonicalBrowseKey(
    searchParams.get('sortBy') ??
      (mediaType === 'album' ? 'dateAdded' : 'releaseDate'),
  )
  const direction = searchParams.get('direction') === 'asc' ? 'asc' : 'desc'
  const view = parseBrowseView(
    searchParams.get('view'),
    defaultBrowseView(mediaType),
  )
  const details = parseCardDetails(searchParams.get('overlays'))
  const density = useGridDensity(searchParams.get('density'))
  const selectedId =
    !embedded && inspector?.root?.kind === mediaType ? inspector.root.id : null
  const fieldsQuery = useQuery({
    queryKey: [collection, 'fields'],
    queryFn: () =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/${collection}/fields`,
        z.array(BrowseFieldSchema),
      ),
  })
  const baseFields =
    fieldsQuery.data ??
    (mediaType === 'album' ? albumBrowseFields : filmBrowseFields)
  const fields: BrowseField[] =
    mediaType === 'album'
      ? [...baseFields, listeningScrobblesField(listeningPeriod)]
      : baseFields
  const columnKeys = [
    ...new Set([
      'title',
      ...(searchParams.get('columns')?.split(',').map(canonicalBrowseKey) ??
        (mediaType === 'album' ? defaultAlbumColumns : defaultFilmColumns)),
    ]),
  ]
  const columnFields = mediaColumnFields(fields, mediaType)
  const columnOrder = parseColumnOrder(searchParams.get('columnOrder'))
  const orderedFields = orderColumns(columnFields, columnOrder, 'title')
  const columns = orderedFields.filter((field) =>
    columnKeys.includes(field.key),
  )
  const providerName = useProviderDisplayName(
    view === 'table' && columnKeys.includes('provider'),
  )
  const sortField = fields.find((field) => field.key === sortBy)
  // Description is a long text field; it is offered last, not first.
  const listedFields = [
    ...fields.filter((field) => field.key !== 'summary'),
    ...fields.filter((field) => field.key === 'summary'),
  ]
  const requestedListeningPeriod =
    mediaType === 'album' &&
    (sortBy === 'listeningScrobbles' ||
      columnKeys.includes('listeningScrobbles'))
      ? listeningPeriod
      : undefined
  const queryKey = JSON.stringify({
    ...catalogParams,
    q,
    filters,
    ranges,
    sortBy,
    direction,
    includeArchived,
    limitResults,
    listening,
    listeningSort: requestedListeningPeriod,
    ...(editions ? { editions } : {}),
    ...(tagLevelsParam ? { tagLevels: tagLevelsParam } : {}),
    ...creator,
  })
  // A compact card is too narrow for tags or a value beside the year.
  const compactCards = density === 'compact'
  const showTags = details.includes('tags') && !compactCards
  const grid = mediaGridGeometry({
    width: viewport.width,
    mediaType,
    density,
    tagsBelowArtwork: showTags,
  })
  const scrollIdentity = `${collection}:${queryKey}:${view}`
  const previousScrollTop = scroll.identity === scrollIdentity ? scroll.top : 0
  const scrollTop =
    view === 'grid' && gridLayout?.identity === scrollIdentity
      ? preserveGridScroll(previousScrollTop, gridLayout, grid)
      : previousScrollTop

  function setParams(updates: Record<string, string | null>, close = false) {
    host.update((params) => {
      for (const [key, value] of Object.entries(updates)) {
        if (value === null || value === '') params.delete(key)
        else params.set(key, value)
      }
    }, close)
  }
  function withFilter(filter: BrowseFilter) {
    return filters.some((item) => sameBrowseFilter(item, filter))
      ? filters
      : [...filters, filter]
  }
  const browseHref = host.browseHref ?? `/${collection}?${searchParams}`
  function filterHref(filter: BrowseFilter) {
    return browseFilterHref(browseHref, withFilter(filter))
  }
  function itemFilterHref(item: MediaItem, filter: BrowseFilter) {
    if (filter.field === 'genre' || filter.field === 'albumTag') {
      const name = normalizeTagName(filter.value)
      const matches = item.tags.filter(
        (tag) => normalizeTagName(tag.name) === name,
      )
      const id = matches.length === 1 ? matches[0]?.id : undefined
      if (id)
        return detailPageHref({
          kind: 'tag',
          id: tagDetailId(mediaType, id),
        })
    }
    if (filter.field === 'playlist') {
      const matches = item.playlists.filter(
        ({ kind, name }) => kind === 'playlist' && name === filter.value,
      )
      const id = matches.length === 1 ? matches[0]?.id : undefined
      if (id) return detailPageHref({ kind: 'playlist', id })
    }
    return filterHref(filter)
  }
  function addFilter(filter: BrowseFilter, keepOpen = false) {
    setParams({ filters: JSON.stringify(withFilter(filter)) }, !keepOpen)
  }
  function changeFilters(next: BrowseFilter[]) {
    setParams({ filters: next.length ? JSON.stringify(next) : null })
  }
  function changeListening(next: ListeningFilter | undefined) {
    setParams({ listening: next ? JSON.stringify(next) : null })
  }
  function clearFilters() {
    setParams({
      ...clearLibraryScope,
      q: null,
      filters: null,
      ranges: null,
      limitResults: null,
      listening: null,
      ...(scope ? {} : clearCreatorScope),
    })
  }
  function changeLibraryScope(next: LibraryScopeState) {
    setParams(libraryScopeUpdates(next))
  }
  function openDetail(id: string, trigger?: HTMLElement) {
    inspector?.open({ kind: mediaType, id }, trigger)
  }
  /** A new sort starts descending, except text, which starts ascending. */
  function sort(key: string) {
    const text = fields.find((field) => field.key === key)?.type === 'text'
    setParams({
      sortBy: key,
      direction:
        sortBy === key
          ? direction === 'desc'
            ? 'asc'
            : 'desc'
          : text
            ? 'asc'
            : 'desc',
    })
  }
  function saveWidths(next: Record<string, number>) {
    setWidths(next)
    try {
      localStorage.setItem(`widths:${host.storage}`, JSON.stringify(next))
    } catch {
      /* Width changes remain usable for this session. */
    }
  }

  useEffect(() => {
    try {
      // The saved Browse state belongs to the Browse page.
      const saved = embedded
        ? null
        : restoreSavedBrowse(window.localStorage, collection)
      if (saved) restoreBrowsePreferences(`/${collection}?${saved}`)
      const parsed = WidthsSchema.safeParse(
        JSON.parse(
          window.localStorage.getItem(`widths:${host.storage}`) ?? '{}',
        ),
      )
      if (parsed.success) setWidths(parsed.data)
    } catch {
      /* Ignore unavailable storage or malformed saved preferences. */
    }
    setReady(true)
  }, [collection, embedded, host.storage, restoreBrowsePreferences])
  useEffect(() => {
    const element = scroller.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry)
        setViewport({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        })
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    // The frame holds the list and its selection bar when it has one.
    const list = frame.current ?? scroller.current
    if (embedded && list) return fitDetailList(list)
  }, [embedded])
  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 })
  }, [scrollIdentity])
  useLayoutEffect(() => {
    if (
      gridLayout?.identity === scrollIdentity &&
      gridLayout.columns === grid.columns &&
      gridLayout.rowHeight === grid.rowHeight
    )
      return
    setGridLayout({
      identity: scrollIdentity,
      columns: grid.columns,
      rowHeight: grid.rowHeight,
    })
    if (view === 'grid' && gridLayout?.identity === scrollIdentity) {
      scroller.current?.scrollTo({ top: scrollTop })
      setScroll({
        identity: scrollIdentity,
        top: scroller.current?.scrollTop ?? scrollTop,
      })
    }
  }, [
    gridLayout,
    grid.columns,
    grid.rowHeight,
    scrollIdentity,
    scrollTop,
    view,
  ])
  useEffect(() => {
    if (selectedId)
      scroller.current
        ?.querySelector('[data-selected="true"]')
        ?.scrollIntoView({ block: 'nearest' })
  }, [selectedId])

  const gridColumns = grid.columns
  const rowHeight =
    view === 'table'
      ? tableRowHeight
      : view === 'list'
        ? listRowHeight
        : grid.rowHeight
  const params = new URLSearchParams({
    ...catalogParams,
    q,
    filters: JSON.stringify(filters),
    ranges: JSON.stringify(ranges),
    sortBy,
    direction,
    ...creator,
  })
  if (includeArchived) params.set('includeArchived', 'true')
  if (editions) params.set('editions', 'true')
  if (limitResults) params.set('limitResults', limitResults)
  if (tagLevelsParam) params.set('tagLevels', tagLevelsParam)
  if (listening) params.set('listening', JSON.stringify(listening))
  if (requestedListeningPeriod)
    params.set('listeningSort', JSON.stringify(requestedListeningPeriod))
  const query = useVirtualBrowse({
    performanceScreen: embedded
      ? undefined
      : mediaType === 'album'
        ? 'albums'
        : 'films',
    apiBaseUrl,
    collection,
    identity: queryKey,
    params,
    enabled: ready,
    columns: view === 'grid' ? gridColumns : 1,
    rowHeight,
    scrollTop,
    viewportHeight: viewport.height,
    headerHeight:
      view === 'grid'
        ? cardGrid.paddingTop
        : view === 'list' && grid.mobile
          ? 0
          : tableHeaderHeight,
  })
  const { total, slots, padTop, padBottom } = query
  // Albums Table rows can be ticked for a merge.
  const selectable = mediaType === 'album'
  const loadedIds = slots.flatMap(({ item }) => (item ? [item.id] : []))
  const selection = useRowSelection(loadedIds)
  // Another search, filter, sort, scope or view lists other albums.
  const [selectionIdentity, setSelectionIdentity] = useState(scrollIdentity)
  if (selectionIdentity !== scrollIdentity) {
    setSelectionIdentity(scrollIdentity)
    selection.clear()
  }
  const selectionColumns = selectable ? 1 : 0
  const selectedItem = slots.find(({ item }) => item?.id === selectedId)?.item
  const selectedListeningCount =
    selectedItem?.mediaType === 'album'
      ? selectedItem.listeningScrobbles
      : undefined
  const facets = useBrowseFacets(
    apiBaseUrl,
    collection,
    draft,
    ready,
    false,
    tagLevels,
    includeArchived,
    catalogParams,
  )
  const titleFilters = matchingTitleFilters(facets.data ?? [], facets.search)
  const titleMatches = useQuery({
    queryKey: [
      collection,
      'title-suggestions',
      titleFilters,
      includeArchived,
      catalogParams,
      ...(creator ? [creator] : []),
    ],
    enabled: ready && titleFilters.length > 0,
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({
        ...catalogParams,
        page: '1',
        size: '100',
        filters: JSON.stringify(titleFilters),
        sortBy: 'title',
        direction: 'asc',
        includeArchived: String(includeArchived),
        ...creator,
      })
      return fetchApiData(
        apiBaseUrl,
        `/api/v1/${collection}?${params}`,
        PageSchema,
        { signal },
      )
    },
  })
  const titlesLoading =
    facets.isDebouncing ||
    facets.isPending ||
    (titleFilters.length > 0 && titleMatches.isPending)
  const titleItems =
    !titlesLoading && draft.trim() && titleFilters.length > 0
      ? titleSuggestions(titleMatches.data?.items ?? [])
      : []
  const options = (facets.data ?? []).filter(
    (option) =>
      !filters.some(
        (filter) =>
          filter.field === option.field && filter.value === option.value,
      ),
  )
  useEffect(() => {
    function openPopovers() {
      return [
        ...(browser.current?.querySelectorAll<HTMLDetailsElement>(
          '.browse-popover[open]',
        ) ?? []),
      ]
    }
    function onPointerDown(event: PointerEvent) {
      for (const popover of openPopovers())
        if (!(event.target instanceof Node && popover.contains(event.target)))
          popover.open = false
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented) return
      const target = event.target instanceof Element ? event.target : null
      if (event.key === 'Escape') {
        const popovers = openPopovers()
        if (popovers.length) {
          for (const popover of popovers) popover.open = false
          event.preventDefault()
        }
        return
      }
      if (
        !selectedId ||
        !sameDetail(inspector?.active, inspector?.root) ||
        (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey
      )
        return
      // Arrow keys keep their usual meaning inside forms, tabs and the detail body.
      if (
        target &&
        target !== document.body &&
        !target.closest('.browse-scroller, .detail-topbar') &&
        !target.matches('.media-inspector')
      )
        return
      const current = slots.findIndex(({ item }) => item?.id === selectedId)
      const next = slots[current + (event.key === 'ArrowDown' ? 1 : -1)]?.item
      if (current < 0 || !next) return
      event.preventDefault()
      inspector?.replace({ kind: mediaType, id: next.id })
    }
    // Inside a detail the list hears Escape before the drawer that holds it.
    const keys = embedded ? browser.current : null
    document.addEventListener('pointerdown', onPointerDown)
    if (keys) keys.addEventListener('keydown', onKeyDown)
    else document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      if (keys) keys.removeEventListener('keydown', onKeyDown)
      else document.removeEventListener('keydown', onKeyDown)
    }
  })
  const widthFor = (field: BrowseField) =>
    widths[field.key] ??
    (field.key === 'title'
      ? 280
      : pillColumns.has(field.key)
        ? 220
        : field.type === 'text'
          ? 180
          : field.rating
            ? 84
            : 110)

  function filterValues(
    item: MediaItem,
    field: BrowseField,
    value: BrowseValues[string],
  ) {
    const values = Array.isArray(value)
      ? value
      : typeof value === 'string'
        ? [value]
        : []
    const onlyValue = values.length === 1 ? values[0] : undefined
    // A Provider value is an ID; the cell names it as the filter chip does.
    const shown = (value: string) =>
      field.key === 'provider' ? providerName(value) : value
    if (onlyValue !== undefined)
      return (
        <button
          {...workspaceTabLinkProps(
            itemFilterHref(item, { field: field.key, value: onlyValue }),
            shown(onlyValue),
          )}
          type="button"
          className="browse-open"
          onClick={() => addFilter({ field: field.key, value: onlyValue })}
          title={`Filter ${field.label}: ${shown(onlyValue)}`}
        >
          {shown(onlyValue)}
        </button>
      )
    return (
      <Pills max={2} label={field.label}>
        {values.map((value) => (
          <Pill asChild key={value}>
            <button
              {...workspaceTabLinkProps(
                itemFilterHref(item, { field: field.key, value }),
                shown(value),
              )}
              type="button"
              onClick={() => addFilter({ field: field.key, value })}
              title={`Filter ${field.label}: ${shown(value)}`}
            >
              <PillLabel>{shown(value)}</PillLabel>
            </button>
          </Pill>
        ))}
      </Pills>
    )
  }

  function renderValue(item: MediaItem, field: BrowseField) {
    if (field.key === 'collection')
      return (
        <CollectionLinks
          item={item}
          mediaType={item.mediaType}
          filterHref={filterHref}
        />
      )
    const values = getBrowseValues(item)
    const value = values[field.key]
    if (['artist', 'director', 'actor', 'writer'].includes(field.key))
      return item.credits.some((credit) => credit.role === field.key) ? (
        <CreatorLinks
          creators={item.credits.filter((credit) => credit.role === field.key)}
          kind={field.key === 'artist' ? 'artist' : 'person'}
          fallbackHref={(value) => filterHref({ field: field.key, value })}
        />
      ) : (
        <EmptyValue />
      )
    if (['genre', 'albumTag', 'artistTag'].includes(field.key)) {
      const tags =
        field.key === 'genre'
          ? item.tags.map((tag) => tag.name)
          : Array.isArray(value)
            ? value
            : []
      const artistTags =
        field.key === 'genre' && item.mediaType === 'album'
          ? item.artistTags
          : undefined
      return tags.length || artistTags?.length ? (
        <BrowseTagBadges
          field={field.key}
          tags={tags}
          artistTags={artistTags}
          onFilter={addFilter}
          filterHref={(filter) => itemFilterHref(item, filter)}
          max={2}
        />
      ) : (
        <EmptyValue />
      )
    }
    if (value === undefined || isMissing(value)) return <EmptyValue />
    if (field.rating && typeof value === 'number') {
      const rating = getProviderRating(field, values)
      return rating ? (
        <span className="ds-mono">{ratingScore(rating)}</span>
      ) : (
        <EmptyValue />
      )
    }
    if (field.type === 'text' && field.filterable && field.key !== 'title')
      return filterValues(item, field, value)
    if (field.key === 'runtimeMinutes' && typeof value === 'number')
      return formatRuntime(value)
    return formatBrowseValue(field, value)
  }

  /** The rating a card or row shows: the sorted one, or the headline one. */
  function shownRating(item: MediaItem) {
    const values = getBrowseValues(item)
    const sorted = sortField?.rating ? sortField : undefined
    const field =
      sorted ?? fields.find((field) => field.key === headlineRating[mediaType])
    if (!field?.rating) return null
    const rating = getProviderRating(field, values)
    return (
      <Rating
        source={ratingSource(field.rating, field.label)}
        value={rating ? ratingScore(rating) : null}
        sorted={Boolean(sorted)}
        title={field.label}
      />
    )
  }

  /** The sorted value, when the card does not already show it. */
  function sortedValue(item: MediaItem) {
    if (!sortField || sortField.rating || sortsShownOnCard.has(sortBy))
      return null
    const value = getBrowseValues(item)[sortBy]
    return (
      <span
        title={sortBy === 'dateAdded' ? item.dateAddedSource : sortField.label}
      >
        {sortBy === 'dateAdded' ? 'Added ' : ''}
        {sortBy === 'collection' ? (
          <CollectionLinks item={item} mediaType={item.mediaType} />
        ) : value === undefined || isMissing(value) ? (
          <EmptyValue />
        ) : (
          formatBrowseValue(sortField, value)
        )}
      </span>
    )
  }

  function cardMeta(item: MediaItem) {
    const year = item.releaseDate?.slice(0, 4)
    const value =
      !compactCards &&
      ((details.includes('sort') && sortedValue(item)) ||
        (details.includes('ratings') ||
        (details.includes('sort') && sortField?.rating)
          ? shownRating(item)
          : null))
    return (
      <>
        <span>{year ?? <EmptyValue />}</span>
        {value}
      </>
    )
  }

  function albumPlaybackSource(item: AlbumListItem, index: number) {
    const source = (length: number) =>
      createBrowsePlaybackSource({
        apiBaseUrl,
        collection: 'albums',
        params,
        href:
          host.browseHref ??
          `/albums?${searchParams.size ? searchParams : params}`,
        label: 'Albums',
        total: length,
        startIndex: index,
        initialItem: item,
      })
    return query.isCounting
      ? query.resolveTotal(index).then(source)
      : source(total)
  }
  function browseActions(
    item: MediaItem,
    index: number,
    place: 'row' | 'tile',
  ) {
    const providerLinks = filteredProviders.length ? (
      <FilteredProviderLinks
        providers={filteredProviders}
        links={mediaBrowseLinkCandidates(item)}
        itemTitle={item.title}
        fields={fields}
        place={item.mediaType === 'film' ? place : undefined}
      />
    ) : undefined
    if (item.mediaType === 'film') return providerLinks
    const Controls = place === 'tile' ? TilePlayControls : AlbumInlinePlayButton
    return (
      <Controls
        album={item}
        source={() => albumPlaybackSource(item, index)}
        more={libraryItemMore('albums', item)}
        afterQueue={providerLinks}
      />
    )
  }
  function creators(item: MediaItem) {
    const role = item.mediaType === 'album' ? 'artist' : 'director'
    const credits = item.credits.filter((credit) => credit.role === role)
    return credits.length ? (
      <CreatorLinks
        creators={credits}
        kind={item.mediaType === 'album' ? 'artist' : 'person'}
        fallbackHref={(value) => filterHref({ field: role, value })}
      />
    ) : null
  }
  function needsId(item: MediaItem) {
    return (
      item.mediaType === 'film' &&
      filmIdentificationStatus(item.providerReferences) === 'Needs ID'
    )
  }
  function isPlaying(item: MediaItem) {
    return (
      item.mediaType === 'album' &&
      playback.current?.albumId === item.id &&
      playback.snapshot !== null &&
      !playback.snapshot.paused
    )
  }
  function titleLink(item: MediaItem, className?: string) {
    return (
      <DetailLink
        kind={mediaType}
        id={item.id}
        className={className}
        title={item.title}
      >
        {item.title}
      </DetailLink>
    )
  }
  function thumbLink(item: MediaItem, size?: number) {
    return (
      <DetailLink
        kind={mediaType}
        id={item.id}
        className="browse-thumb-link"
        workspaceLabel={item.title}
        tabIndex={-1}
        aria-hidden="true"
      >
        <MediaThumb kind={mediaType} src={item.artworkUrl} size={size} />
      </DetailLink>
    )
  }

  /** The list's trailing values: rating, one number and one date. */
  const listNumberField =
    sortField &&
    sortField.type === 'number' &&
    !sortField.rating &&
    sortField.key !== 'runtimeMinutes'
      ? sortField
      : fields.find(
          (field) =>
            field.key ===
            (mediaType === 'album' ? 'scrobbles' : 'runtimeMinutes'),
        )
  const listDateField =
    sortField && sortField.type === 'date' && sortField.key !== 'releaseDate'
      ? sortField
      : fields.find((field) => field.key === 'dateAdded')
  const listRatingField = sortField?.rating
    ? sortField
    : fields.find((field) => field.key === headlineRating[mediaType])
  function listMeta(item: MediaItem) {
    const values = getBrowseValues(item)
    const number = listNumberField ? values[listNumberField.key] : undefined
    const date = listDateField ? values[listDateField.key] : undefined
    return (
      <>
        <RowValue kind="rating">{shownRating(item)}</RowValue>
        <RowValue kind="num">
          {listNumberField && typeof number === 'number' ? (
            listNumberField.key === 'runtimeMinutes' ? (
              formatRuntime(number)
            ) : (
              formatBrowseValue(listNumberField, number)
            )
          ) : (
            <EmptyValue />
          )}
        </RowValue>
        <RowValue kind="date">
          {listDateField && typeof date === 'number' ? (
            <span
              title={
                listDateField.key === 'dateAdded'
                  ? item.dateAddedSource
                  : undefined
              }
            >
              {formatBrowseValue(listDateField, date)}
            </span>
          ) : (
            <EmptyValue />
          )}
        </RowValue>
      </>
    )
  }

  // The creator a list inside a detail is held to is not a filter.
  const creatorFilter = scope ? undefined : creator
  const activeFilterCount =
    Number(Boolean(q)) +
    Number(Boolean(creatorFilter)) +
    filters.length +
    ranges.length +
    (listening?.rules.length ?? 0) +
    Number(Boolean(limitResults))
  const scopeFilterCount = libraryScopeFilterCount(libraryScope)
  const hasActiveFilters = activeFilterCount + scopeFilterCount > 0
  const activeFilters: ReactNode = hasActiveFilters ? (
    <>
      <LibraryScopePills value={libraryScope} onChange={changeLibraryScope} />
      {creatorFilter && (
        <CreatorScopeChip
          scope={creatorFilter}
          film={mediaType === 'film'}
          onMoved={(creatorId) => setParams({ creatorId })}
          onRemove={() => setParams(clearCreatorScope)}
        />
      )}
      {limitResults && (
        <BrowseFilterPill
          removeLabel={`Remove limit of ${limitResults}`}
          onRemove={() => setParams({ limitResults: null })}
        >
          Top {limitResults}
        </BrowseFilterPill>
      )}
      {q && (
        <BrowseFilterPill
          removeLabel="Remove search"
          onRemove={() => setParams({ q: null })}
        >
          Search: {q}
        </BrowseFilterPill>
      )}
      <BrowseFilterChips
        filters={filters}
        fields={fields}
        onChange={changeFilters}
        filterHref={(filter) => browseFilterHref(browseHref, [filter])}
      />
      {ranges.map((range) => {
        const field = fields.find((field) => field.key === range.field)
        const bound = (value: number | undefined) =>
          value === undefined
            ? '*'
            : field?.type === 'date'
              ? formatBrowseValue(field, value)
              : value
        const label = `${field?.label ?? range.field}: ${bound(range.min)} to ${bound(range.max)}${range.includeMissing ? ' + missing' : ''}`
        return (
          <BrowseFilterPill
            key={range.field}
            mode="required"
            removeLabel={`Remove range ${label}`}
            onRemove={() =>
              setParams({
                ranges: JSON.stringify(
                  ranges.filter((item) => item.field !== range.field),
                ),
              })
            }
          >
            {label}
          </BrowseFilterPill>
        )
      })}
      <ListeningFilterPills
        library="album"
        filter={listening}
        onChange={changeListening}
      />
      <Button type="button" variant="link" size="xs" onClick={clearFilters}>
        Clear all
      </Button>
    </>
  ) : null

  const emptyState =
    query.hasTotal && !query.isError && total === 0 ? (
      hasActiveFilters || filterPanel?.count ? (
        <State
          title={`No ${noun.other} match`}
          action={
            hasActiveFilters && (
              <Button type="button" onClick={clearFilters}>
                Clear filters
              </Button>
            )
          }
        />
      ) : (
        <State
          title={`No ${noun.other} yet`}
          action={
            !embedded && (
              <Button type="button" onClick={() => setAdding(true)}>
                Add {mediaType}
              </Button>
            )
          }
        />
      )
    ) : null

  return (
    <ResultSection
      identity={queryKey}
      result={query}
      className={embedded ? undefined : 'browse-page'}
      aria-label={collection}
      ref={browser}
    >
      <div className={embedded ? undefined : 'browse-column'}>
        <BrowseToolbar
          libraryScope={{ value: libraryScope, onChange: changeLibraryScope }}
          addActions={
            !embedded && (
              <>
                <Button type="button" onClick={() => setAdding(true)}>
                  Add {mediaType}
                </Button>
                {mediaType === 'film' && (
                  <Button asChild variant="ghost">
                    <Link href="/jobs?refresh=films">Refresh</Link>
                  </Button>
                )}
              </>
            )
          }
          search={
            <AiSearch
              key={mediaType}
              target={mediaAiSearchTarget(mediaType, fields)}
              queryIdentity={queryKey}
              autocomplete={{
                items: titleItems,
                itemKind: mediaType,
                titlesLoading,
                titlesError:
                  facets.isError ||
                  (titleFilters.length > 0 && titleMatches.isError),
                onOpenItem: openDetail,
                options,
                placeholder: `Search ${collection}`,
                value: draft,
                onFocus: facets.activate,
                onValueChange: setDraft,
                onAddFilter: addFilter,
                filterHref,
                searchHref: (value) =>
                  browseSearchHref(browseHref, { q: value }),
                onApplyText: (value) => {
                  setParams({ q: value || null })
                  setDraft('')
                },
              }}
              onApply={(plan) => {
                setParams(aiSearchParams(plan))
                setDraft('')
              }}
            />
          }
          sort={{
            key: sortBy,
            direction,
            options: listedFields,
            onChange: sort,
            onDirectionChange: (direction) => setParams({ direction }),
          }}
          filterCount={activeFilterCount + (filterPanel?.count ?? 0)}
          viewOptions={
            <>
              {view === 'grid' && (
                <fieldset className="browse-fieldset">
                  <legend className="ds-label">On cards</legend>
                  {cardDetails.map((detail) => (
                    <label className="ds-checkrow" key={detail}>
                      <input
                        type="checkbox"
                        className="ds-check"
                        checked={details.includes(detail)}
                        onChange={(event) =>
                          setParams({
                            overlays: formatCardDetails(
                              cardDetails.filter((key) =>
                                key === detail
                                  ? event.target.checked
                                  : details.includes(key),
                              ),
                            ),
                          })
                        }
                      />
                      {cardDetailLabels[detail]}
                    </label>
                  ))}
                </fieldset>
              )}
              <label className="ds-checkrow">
                <input
                  type="checkbox"
                  className="ds-check"
                  checked={includeArchived}
                  onChange={(event) =>
                    setParams({
                      includeArchived: event.target.checked ? 'true' : null,
                    })
                  }
                />
                Include archived imports
              </label>
              {mediaType === 'album' && (
                <label className="ds-checkrow">
                  <input
                    type="checkbox"
                    className="ds-check"
                    checked={editions}
                    onChange={(event) =>
                      setParams({
                        editions: event.target.checked ? 'true' : null,
                      })
                    }
                  />
                  Show editions as rows
                </label>
              )}
            </>
          }
          filters={
            <>
              {view === 'table' && (
                <BrowseColumnsSection>
                  <ColumnChoices
                    fields={orderedFields}
                    selected={columnKeys}
                    required="title"
                    onChange={(keys) => setParams({ columns: keys.join(',') })}
                    onOrderChange={(keys) =>
                      setParams({
                        columnOrder: columnOrderParam(keys, columnFields),
                      })
                    }
                    onResetOrder={
                      hasCustomColumnOrder(orderedFields, columnFields, 'title')
                        ? () => setParams({ columnOrder: null })
                        : undefined
                    }
                  />
                </BrowseColumnsSection>
              )}
              {filterPanel?.controls}
              {hasActiveFilters && (
                <section
                  className="browse-drawer-active"
                  aria-label="Active filters"
                >
                  <h3>Active filters</h3>
                  <div className="browse-filter-group">{activeFilters}</div>
                </section>
              )}
              {mediaType === 'album' && (
                <TagLocationSection
                  library="album"
                  value={tagLevels}
                  onChange={(next) =>
                    setParams({ tagLevels: formatTagLevelsParam(next) })
                  }
                />
              )}
              {mediaType === 'album' && (
                <FilterPanelSection
                  title="Smart playlists"
                  icon={
                    <ListMusic className="ds-i" data-size="sm" aria-hidden />
                  }
                >
                  <div className="browse-form">
                    <label className="ds-field">
                      <span className="ds-label">Saved view</span>
                      <Select
                        aria-label="Smart playlist"
                        value=""
                        onChange={(event) => {
                          const view = savedViews.data?.find(
                            (view) => view.name === event.target.value,
                          )
                          if (view)
                            setParams({
                              ...(scope ? {} : clearCreatorScope),
                              filters: JSON.stringify(view.filters),
                              ranges: JSON.stringify(view.ranges),
                              sortBy: view.sortBy,
                              direction: view.direction,
                              limitResults: view.limit
                                ? String(view.limit)
                                : null,
                              q: null,
                              listening: view.listening
                                ? JSON.stringify(view.listening)
                                : null,
                              listeningSort: view.listeningSort
                                ? JSON.stringify(view.listeningSort)
                                : null,
                              tagLevels: formatTagLevelsParam(view.tagLevels),
                            })
                        }}
                      >
                        <option value="">
                          {savedViews.isPending
                            ? 'Loading...'
                            : 'Choose a saved view'}
                        </option>
                        {savedViews.data?.map((view) => (
                          <option key={view.name} value={view.name}>
                            {view.name}
                          </option>
                        ))}
                      </Select>
                    </label>
                    {savedViews.isError && (
                      <Notice
                        tone="danger"
                        action={
                          <ReadButton
                            type="button"
                            size="xs"
                            read={() => savedViews.refetch()}
                          >
                            Retry
                          </ReadButton>
                        }
                      >
                        Saved views unavailable.
                      </Notice>
                    )}
                  </div>
                </FilterPanelSection>
              )}
              <RangeEditor
                presentation="panel"
                fields={fields.filter((field) => field.filterable)}
                ranges={ranges}
                onChange={(ranges) =>
                  setParams({
                    ranges: ranges.length ? JSON.stringify(ranges) : null,
                  })
                }
              />
              {mediaType === 'album' && (
                <ListeningControls
                  apiBaseUrl={apiBaseUrl}
                  library="album"
                  params={params}
                  filter={listening}
                  sortPeriod={listeningSort}
                  total={query.hasTotal ? total : undefined}
                  examples={slots
                    .flatMap(({ item }) => (item ? [item] : []))
                    .slice(0, 3)
                    .map((item) => ({
                      id: item.id,
                      title: item.title,
                      artworkUrl: item.artworkUrl,
                      by: creators(item),
                    }))}
                  onFilterChange={changeListening}
                  onSortPeriodChange={(period) =>
                    setParams({ listeningSort: JSON.stringify(period) })
                  }
                />
              )}
            </>
          }
          view={view}
          onViewChange={(next) => setParams({ view: next })}
          density={{
            value: density,
            onChange: (next) => setParams({ density: next }),
          }}
          count={
            query.countError ? (
              <ReadButton
                type="button"
                variant="link"
                size="xs"
                read={query.retryCount}
              >
                Retry count
              </ReadButton>
            ) : !query.isCounting ? (
              formatItemCount(
                total,
                noun,
                embedded ? undefined : query.unfilteredTotal,
              )
            ) : query.isPending ? (
              'Loading...'
            ) : (
              'Counting...'
            )
          }
          end={
            (countActions || host.browseHref) && (
              <>
                {countActions}
                {host.browseHref && (
                  <Button variant="link" asChild>
                    <Link href={host.browseHref}>
                      {`Show in ${mediaType === 'album' ? 'Albums' : 'Films'}`}
                    </Link>
                  </Button>
                )}
              </>
            )
          }
          compact={embedded}
          activeFilters={activeFilters}
        />
        {railSlot && activeFilters
          ? createPortal(
              <>
                <h2 className="ds-rail-label">Filters</h2>
                <div className="ds-rail-chips">{activeFilters}</div>
              </>,
              railSlot,
            )
          : activeFilters &&
            !embedded && (
              <div
                className="ds-strip"
                role="group"
                aria-label="Active filters"
              >
                {activeFilters}
              </div>
            )}
        {beforeResults}
        <DetailListFrame framed={embedded && selectable} frame={frame}>
          <div
            className={`browse-scroller${embedded ? ` ${embeddedScrollClass}` : ''}`}
            data-view={view}
            data-touch={grid.mobile ? '' : undefined}
            data-inspector-scroll={embedded ? '' : undefined}
            ref={scroller}
            role="region"
            aria-label={`${collection} ${view}`}
            tabIndex={0}
            onScroll={(event) => {
              setScroll({
                identity: scrollIdentity,
                top: event.currentTarget.scrollTop,
              })
              const sideways = event.currentTarget.scrollLeft > 0
              if (sideways !== scrolledSideways) setScrolledSideways(sideways)
            }}
          >
            {query.isError && (
              <div className="browse-notice">
                <Notice
                  tone="danger"
                  action={
                    <ReadButton type="button" size="xs" read={query.retry}>
                      Retry
                    </ReadButton>
                  }
                >
                  Could not load {collection}.
                </Notice>
              </div>
            )}
            <span className="sr-only" role="status">
              {query.isFetching ? 'Loading items' : ''}
            </span>
            {emptyState}
            {view === 'grid' ? (
              <div
                className="browse-extent"
                style={{
                  height:
                    query.height > 0
                      ? query.height - grid.gap + grid.padding
                      : 0,
                }}
              >
                <CardGrid
                  className="browse-slots"
                  data-density={density}
                  style={{
                    top: padTop,
                    gridTemplateColumns: `repeat(${gridColumns}, minmax(0, 1fr))`,
                    gridAutoRows: grid.cardHeight,
                  }}
                >
                  {slots.map(({ item, index }) => {
                    if (!item)
                      return (
                        <div
                          key={`slot-${index}`}
                          className="ds-card"
                          aria-hidden="true"
                        >
                          <span
                            className="ds-art"
                            data-ratio={
                              mediaType === 'film' ? 'poster' : undefined
                            }
                          >
                            <Skeleton width="100%" height="100%" />
                          </span>
                          <Skeleton height={12} width="80%" />
                          <Skeleton height={10} width="55%" />
                        </div>
                      )
                    return (
                      <Card
                        key={item.id}
                        data-item-index={index}
                        data-selected={item.id === selectedId}
                        selected={item.id === selectedId}
                        playing={isPlaying(item)}
                        art={
                          <MediaArt
                            kind={mediaType}
                            src={item.artworkUrl}
                            badge={needsId(item) ? 'Needs ID' : undefined}
                            overlay={browseActions(item, index, 'tile')}
                          >
                            {(image) => (
                              <DetailLink
                                kind={mediaType}
                                id={item.id}
                                className="browse-art-link"
                                workspaceLabel={item.title}
                                tabIndex={-1}
                                aria-hidden="true"
                              >
                                {image}
                              </DetailLink>
                            )}
                          </MediaArt>
                        }
                        title={<CardTitle>{titleLink(item)}</CardTitle>}
                        by={creators(item) ?? <EmptyValue />}
                        meta={cardMeta(item)}
                        tags={
                          showTags ? (
                            <BrowseTagBadges
                              tags={item.tags.map((tag) => tag.name)}
                              artistTags={
                                item.mediaType === 'album'
                                  ? item.artistTags
                                  : undefined
                              }
                              onFilter={addFilter}
                              filterHref={(filter) =>
                                itemFilterHref(item, filter)
                              }
                              max={mediaType === 'film' ? 1 : 2}
                            />
                          ) : undefined
                        }
                      />
                    )
                  })}
                </CardGrid>
              </div>
            ) : view === 'list' ? (
              <List compact={grid.mobile}>
                {!grid.mobile && (
                  <ListHead
                    title={mediaType === 'album' ? 'Album' : 'Film'}
                    tags="Tags"
                    playWidth={mediaType === 'album' ? 50 : 0}
                    meta={
                      <>
                        <RowValue kind="rating">
                          {listRatingField?.rating
                            ? ratingSource(
                                listRatingField.rating,
                                listRatingField.label,
                              )
                            : ''}
                        </RowValue>
                        <RowValue kind="num">{listNumberField?.label}</RowValue>
                        <RowValue kind="date">{listDateField?.label}</RowValue>
                      </>
                    }
                  />
                )}
                <div className="browse-extent" style={{ height: query.height }}>
                  <div className="browse-slots" style={{ top: padTop }}>
                    {slots.map(({ item, index }) =>
                      item ? (
                        <ListRow
                          key={item.id}
                          data-item-index={index}
                          data-selected={item.id === selectedId}
                          selected={item.id === selectedId}
                          playing={isPlaying(item)}
                          thumb={thumbLink(item, 40)}
                          title={<RowTitle>{titleLink(item)}</RowTitle>}
                          by={
                            <>
                              {creators(item)}
                              {item.credits.some(
                                (credit) =>
                                  credit.role ===
                                  (mediaType === 'album'
                                    ? 'artist'
                                    : 'director'),
                              ) && item.releaseDate
                                ? ' · '
                                : ''}
                              {item.releaseDate?.slice(0, 4)}
                              {sortField?.type === 'text' &&
                                !sortsShownOnCard.has(sortBy) && (
                                  <> · {sortedValue(item)}</>
                                )}
                              {needsId(item) && (
                                <>
                                  {' '}
                                  <Pill tone="attention">Needs ID</Pill>
                                </>
                              )}
                            </>
                          }
                          play={
                            <span>{browseActions(item, index, 'row')}</span>
                          }
                          tags={
                            <BrowseTagBadges
                              tags={item.tags.map((tag) => tag.name)}
                              artistTags={
                                item.mediaType === 'album'
                                  ? item.artistTags
                                  : undefined
                              }
                              onFilter={addFilter}
                              filterHref={(filter) =>
                                itemFilterHref(item, filter)
                              }
                              max={3}
                            />
                          }
                          meta={listMeta(item)}
                        />
                      ) : (
                        <div
                          key={`slot-${index}`}
                          className="ds-row"
                          aria-hidden="true"
                        >
                          <Skeleton width={40} height={40} />
                          <div className="ds-row-main">
                            <Skeleton height={12} width="60%" />
                            <Skeleton height={10} width="40%" />
                          </div>
                        </div>
                      ),
                    )}
                  </div>
                </div>
              </List>
            ) : (
              <table
                className="ds-table"
                data-layout="fixed"
                data-scrolled={scrolledSideways ? '' : undefined}
                aria-rowcount={query.hasTotal ? total + 1 : undefined}
                style={{
                  minWidth: columnsWidth([
                    ...(selectable ? [rowSelectionWidth] : []),
                    ...columns.map((field) => widthFor(field)),
                  ]),
                }}
              >
                <TableColumns
                  widths={[
                    ...(selectable ? [rowSelectionWidth] : []),
                    ...columns.map((field, column) =>
                      column === columns.length - 1 &&
                      pillColumns.has(field.key) &&
                      widths[field.key] === undefined
                        ? undefined
                        : widthFor(field),
                    ),
                  ]}
                />
                <TableHeader>
                  <TableRow>
                    {selectable && (
                      <TableHead sticky={0}>
                        <RowSelectAll
                          selection={selection}
                          label="Select loaded albums"
                          disabled={!loadedIds.length}
                        />
                      </TableHead>
                    )}
                    {columns.map((field, column) => (
                      <BrowseSortHead
                        key={field.key}
                        label={columnLabel(field)}
                        active={sortBy === field.key}
                        direction={direction}
                        onSort={() => sort(field.key)}
                        width={widthFor(field)}
                        onWidthChange={(width) =>
                          setWidths({ ...widths, [field.key]: width })
                        }
                        onWidthCommit={(width) =>
                          saveWidths({ ...widths, [field.key]: width })
                        }
                        align={field.type === 'text' ? undefined : 'end'}
                        sticky={
                          column === 0
                            ? selectable
                              ? rowSelectionWidth
                              : 0
                            : undefined
                        }
                        stickyEdge={column === 0}
                      />
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <BrowseSpacerRow
                    columns={selectionColumns + columns.length}
                    height={padTop}
                  />
                  {slots.map(({ item, index }) =>
                    item ? (
                      <TableRow
                        key={item.id}
                        data-item-index={index}
                        data-selected={item.id === selectedId}
                        selected={
                          item.id === selectedId || selection.has(item.id)
                        }
                        data-state={isPlaying(item) ? 'playing' : undefined}
                        aria-rowindex={index + 2}
                      >
                        {selectable && (
                          <TableCell sticky={0}>
                            <RowSelectRow
                              selection={selection}
                              id={item.id}
                              title={item.title}
                            />
                          </TableCell>
                        )}
                        {columns.map((field, column) =>
                          field.key === 'title' ? (
                            <TableCell
                              key={field.key}
                              sticky={
                                column === 0
                                  ? selectable
                                    ? rowSelectionWidth
                                    : 0
                                  : undefined
                              }
                              stickyEdge={column === 0}
                            >
                              <span className="ds-cell-id">
                                {thumbLink(item)}
                                {titleLink(item, 'ds-cell-title')}
                                {needsId(item) && (
                                  <Pill tone="attention">Needs ID</Pill>
                                )}
                                {item.mediaType === 'album' && (
                                  <AlbumRecordNote album={item} />
                                )}
                                {browseActions(item, index, 'row')}
                              </span>
                            </TableCell>
                          ) : (
                            <TableCell
                              key={field.key}
                              align={field.type === 'text' ? undefined : 'end'}
                              title={
                                field.key === 'dateAdded'
                                  ? item.dateAddedSource
                                  : undefined
                              }
                            >
                              {renderValue(item, field)}
                            </TableCell>
                          ),
                        )}
                      </TableRow>
                    ) : (
                      <BrowsePlaceholderRow
                        key={`slot-${index}`}
                        columns={selectionColumns + columns.length}
                        sticky
                      />
                    ),
                  )}
                  <BrowseSpacerRow
                    columns={selectionColumns + columns.length}
                    height={padBottom}
                  />
                </TableBody>
              </table>
            )}
          </div>
          {!embedded && (
            <ResultLineSlot
              place="content"
              hidden={view === 'table' && selection.count > 0}
            />
          )}
          {selectable && view === 'table' && (
            <MergeBar
              selection={selection}
              total={query.hasTotal ? total : undefined}
              adapter={albumMergeAdapter}
              actions={
                <AddToPlaylistButton
                  subject={{
                    library: 'albums',
                    selection: { ids: selection.ids },
                    count: selection.count,
                    title:
                      selection.count === 1
                        ? (slots.find(
                            ({ item }) => item?.id === selection.ids[0],
                          )?.item?.title ?? null)
                        : null,
                  }}
                  suggestedName={suggestedPlaylistName(filters, q)}
                  onAdded={selection.clear}
                />
              }
            />
          )}
        </DetailListFrame>
      </div>
      {adding && (
        <ManualMediaAdd
          key={mediaType}
          mediaType={mediaType}
          onClose={() => setAdding(false)}
          onAdded={(id) => {
            setAdding(false)
            openDetail(id)
          }}
        />
      )}
      {!embedded && (
        <DetailInspector
          media={{
            onFilter:
              inspector?.active?.kind === mediaType ? addFilter : undefined,
            filterHref:
              inspector?.active?.kind === mediaType ? filterHref : undefined,
            onFiltersChange:
              inspector?.active?.kind === mediaType ? changeFilters : undefined,
            highlightField:
              inspector?.active?.kind === mediaType ? sortBy : undefined,
            browseMetric:
              sameDetail(inspector?.root, inspector?.active) &&
              sortField?.key === 'listeningScrobbles' &&
              selectedListeningCount !== undefined
                ? { field: sortField, value: selectedListeningCount }
                : undefined,
          }}
        />
      )}
    </ResultSection>
  )
}
