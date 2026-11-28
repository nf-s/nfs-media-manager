'use client'

import { ResultSection } from './result-feedback'
import { useRestoreBrowsePreferences } from './workspace-tab-context'
import { workspaceTabLinkProps } from '@/utils/workspace-tab-destination'
import Link from 'next/link'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import { Search } from 'lucide-react'
import { Button } from '@repo/ui/components/ui/button'
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableScroll,
  TableColumns,
  columnsWidth,
} from '@repo/ui/components/ui/table'
import { Card, CardTitle } from '@repo/ui/components/ds/card'
import {
  ListHead,
  ListRow,
  RowTitle,
  RowValue,
} from '@repo/ui/components/ds/list-row'
import { EmptyValue, Pill, PillLabel, Pills } from '@repo/ui/components/ds/pill'
import { BrowseActions } from '@repo/ui/components/ds/play'
import { Skeleton, State } from '@repo/ui/components/ds/feedback'
import { EMPTY_VALUE, formatCount } from '@repo/ui/lib/format'
import {
  BrowseFieldSchema,
  canonicalBrowseKey,
  type BrowseField,
  type BrowseFilter,
} from '@repo/schemas/browse'
import {
  SubscriptionItemPageSchema,
  SubscriptionItemSchema,
  getSubscriptionBrowseValues,
  subscriptionBrowseFieldsFor,
  subscriptionLibraryLabels,
  subscriptionTypeLabels,
  type SubscriptionItem,
  type SubscriptionLibrary,
} from '@repo/schemas/subscriptions'
import { useConfig } from './providers'
import { fetchApiData } from '@/utils/api'
import {
  useInLibraryBrowseCount,
  useVirtualBrowse,
} from '@/hooks/useVirtualBrowse'
import { useBrowseFacets } from '@/hooks/useBrowseFacets'
import { useRailSlot } from '@/hooks/useRailSlot'
import { useGridDensity } from '@/hooks/useGridDensity'
import { useSubscriptionSource } from '@/hooks/useSubscriptionSource'
import { useColumnWidths } from '@/hooks/useColumnWidths'
import {
  useEmbeddedBrowse,
  usePageBrowse,
  type BrowseHost,
} from '@/hooks/useBrowseHost'
import {
  embeddedScrollClass,
  type EmbeddedBrowse,
} from '@/utils/embedded-browse'
import { matchingTitleFilters } from '@/utils/browse-suggestions'
import {
  clearLibraryScope,
  libraryScopeFilterCount,
  libraryScopeQuery,
  libraryScopeUpdates,
  readLibraryScope,
} from '@/utils/library-scope'
import {
  defaultBrowseView,
  gridCardMin,
  preserveGridScroll,
} from '@/utils/media-grid'
import {
  aiMixSearchParams,
  aiSubscriptionSearchParams,
  mixAiSearchTarget,
  subscriptionAiSearchTarget,
} from '@/utils/ai-search'
import {
  defaultSubscriptionColumnsFor,
  formatCompactSubscriptionCount,
  formatSubscriptionDuration,
  formatSubscriptionPublished,
  hasSubscriptionFilters,
  isSubscriptionSort,
  parseSubscriptionBrowseState,
  savedSubscriptionSearch,
  subscriptionArtworkUrl,
  subscriptionBrowseQuery,
  subscriptionFieldOrders,
  subscriptionLibraryPages,
  subscriptionLibraryParams,
  subscriptionRangeLabel,
  subscriptionSortLabelsFor,
  subscriptionSortOptions,
  subscriptionTitleSuggestions,
  withSubscriptionFilter,
} from '@/utils/subscriptions'
import {
  browseFilterHref,
  browseSearchHref,
  columnOrderParam,
  hasCustomColumnOrder,
  formatFieldValue,
  itemGridGeometry,
  nextSortDirection,
  orderColumns,
  orderFields,
  parseColumnOrder,
  sortedValueLabel,
  textValues,
} from '@/utils/browse-items'
import { DetailInspector } from './detail-inspector'
import { DetailLink } from './detail-link'
import { useDetailInspector } from './detail-inspector-context'
import { detailPageHref, sameDetail } from '@/utils/detail-inspector'
import { fitDetailList } from '@/utils/detail-list-space'
import AiSearch from './ai-search'
import type { BrowseFilterAutocompleteProps } from './browse-filter-autocomplete'
import {
  BrowseFilterChips,
  BrowseFilterPill,
  BrowseTagBadges,
  RangeEditor,
} from './browse-controls'
import BrowseToolbar, { BrowseColumnsSection } from './browse-toolbar'
import { FilterPanelSection } from './browse-filter-panel'
import {
  ActiveFiltersSection,
  ClearableFilters,
  BrowseItemsCount,
  BrowseItemsHead,
  BrowseItemsStates,
  CardSkeleton,
  ColumnChoices,
  ItemArt,
  ItemThumb,
  PlacedFilters,
  RowSkeleton,
  VirtualCards,
  VirtualRows,
} from './browse-items'
import {
  RowSelectAll,
  RowSelectRow,
  rowSelectionWidth,
  SelectAllMatching,
  SelectionBar,
  useRowSelection,
} from './merge-bar'
import { libraryItemMore } from './item-more'
import { AddToPlaylistButton } from './library-playlist-picker'
import { ResultLineSlot } from './result-line'
import {
  SmartPlaylistActions,
  SmartPlaylistName,
  SmartPlaylistsSection,
  useLibraryPlaylistSuggestions,
  useSmartPlaylistBrowse,
} from './smart-playlist-controls'
import {
  matchingBlocked,
  matchingCount,
  matchingSubject,
  selectionSubject,
  suggestedPlaylistName,
} from '@/utils/library-playlists'

/** --ds-head, --ds-row-media and --ds-row. */
const headerHeight = 28
const listRowHeight = 48
const tableRowHeight = 32
/** Sorts whose value the card does not already show; a mix card has no length badge. */
const cardSortKeys: Record<SubscriptionLibrary, Set<string>> = {
  subscriptions: new Set(['watchedAt', 'likeCount', 'commentCount']),
  mixes: new Set(['watchedAt', 'durationSec']),
}
const searchFieldOptions: Array<{ value: 'all' | 'title'; label: string }> = [
  { value: 'all', label: 'Titles and descriptions' },
  { value: 'title', label: 'Titles only' },
]
const searchPlaceholders: Record<SubscriptionLibrary, string> = {
  subscriptions: 'Search titles, channels, podcasts, tags...',
  mixes: 'Search titles, shows, artists, tags...',
}
const emptyLibraryHelp: Record<SubscriptionLibrary, string> = {
  subscriptions: 'Sync channels and podcasts in Imports.',
  mixes: 'Sync station archives in Imports.',
}

/**
 * Browse for Subscriptions (YouTube videos and podcast episodes) or Mixes
 * (radio station archives). Both read the Subscriptions API; `library`
 * decides the labels, the cache and storage keys and the item kinds.
 */
export default function SubscriptionBrowser({
  library = 'subscriptions',
}: {
  library?: SubscriptionLibrary
}) {
  const host = usePageBrowse(
    subscriptionLibraryPages[library].collection,
    savedSubscriptionSearch,
  )
  return <SubscriptionBrowse host={host} library={library} />
}

/**
 * The Subscriptions or Mixes browser inside a detail, held to one channel,
 * podcast or show. It has every control of the library's page; Show in
 * Subscriptions or Show in Mixes shows the same result there.
 */
export function EmbeddedSubscriptionBrowser({
  library,
  sourceId,
  storage,
  sort,
}: {
  library: SubscriptionLibrary
  sourceId: string
  /** Names the list's view and column widths in browser storage. */
  storage: string
  sort: EmbeddedBrowse['sort']
}) {
  const page = subscriptionLibraryPages[library]
  const host = useEmbeddedBrowse(
    page.collection,
    {
      scope: { sourceId },
      storage,
      // Mixes are square, like albums.
      mediaType: library === 'mixes' ? 'album' : 'subscription',
      sort,
    },
    defaultBrowseView(page.itemKind),
  )
  return <SubscriptionBrowse host={host} library={library} scope={sourceId} />
}

function SubscriptionBrowse({
  host,
  library,
  scope,
}: {
  host: BrowseHost
  library: SubscriptionLibrary
  /** The channel, podcast or show a list inside a detail is held to. */
  scope?: string
}) {
  const page = subscriptionLibraryPages[library]
  const { collection, path: libraryPath, itemKind, sourceKind } = page
  const labels = subscriptionLibraryLabels[library]
  const mixes = library === 'mixes'
  const { apiBaseUrl } = useConfig()
  const { embedded } = host
  const searchParams = host.params
  const restoreBrowsePreferences = useRestoreBrowsePreferences()
  const [ready, setReady] = useState(embedded)
  const [draft, setDraft] = useState('')
  const [scroll, setScroll] = useState({ identity: '', top: 0 })
  const [gridLayout, setGridLayout] = useState<{
    identity: string
    columns: number
    rowHeight: number
  } | null>(null)
  const [viewport, setViewport] = useState({ width: 1000, height: 800 })
  const scroller = useRef<HTMLDivElement>(null)
  const inspector = useDetailInspector()
  const pageRail = useRailSlot()
  // Inside a detail the active filters sit in a row above the results.
  const railSlot = embedded ? null : pageRail
  const parsed = parseSubscriptionBrowseState(
    new URLSearchParams(searchParams),
    library,
  )
  const state = scope ? { ...parsed, sourceId: scope } : parsed
  const { q, filters, ranges, view, sourceId } = state
  // The source a list inside a detail is held to is not a filter.
  const sourceFilter = scope ? undefined : sourceId
  const libraryScope = readLibraryScope(searchParams)
  const catalogParams = libraryScopeQuery(libraryScope)
  const { params, sortBy, direction } = subscriptionBrowseQuery(state, library)
  for (const [key, value] of Object.entries(catalogParams))
    params.set(key, value)
  const identity = params.toString()
  const sourceTitle = useSubscriptionSource(sourceFilter, library).data?.source
    .title
  const selectedId =
    !embedded && inspector?.root?.kind === itemKind ? inspector.root.id : null
  const libraryQuery = new URLSearchParams(subscriptionLibraryParams(library))
  const fieldsQuery = useQuery({
    queryKey: [collection, 'fields'],
    queryFn: () =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/subscriptions/fields${libraryQuery.size ? `?${libraryQuery}` : ''}`,
        z.array(BrowseFieldSchema),
      ),
  })
  const fields = orderFields(
    fieldsQuery.data ?? subscriptionBrowseFieldsFor(library),
    subscriptionFieldOrders[library],
  )
  const sortField = fields.find((field) => field.key === sortBy)
  const sortLabels = subscriptionSortLabelsFor(library)
  const smart = useSmartPlaylistBrowse({
    library,
    host,
    order: { sortBy, direction },
    fields,
    suggestedName: suggestedPlaylistName(filters, q),
  })
  // Watched Yes/No is a filter; the Watched column shows the date.
  const columnFields = fields.filter(
    (field) => field.key !== 'description' && field.key !== 'watched',
  )
  const columnKeys = [
    ...new Set([
      'title',
      ...(state.columns?.map(canonicalBrowseKey) ??
        defaultSubscriptionColumnsFor[library]),
    ]),
  ]
  const columnOrder = parseColumnOrder(searchParams.get('columnOrder'))
  const orderedFields = orderColumns(columnFields, columnOrder, 'title')
  const columns = orderedFields.filter((field) =>
    columnKeys.includes(field.key),
  )
  const widths = useColumnWidths(host.storage, (field: BrowseField) =>
    field.key === 'title'
      ? 340
      : field.key === 'source' || field.key === 'artist'
        ? 200
        : field.key === 'genre'
          ? 220
          : field.type === 'text'
            ? 100
            : 110,
  )
  const mobile = viewport.width <= 700
  const density = useGridDensity(searchParams.get('density'))
  // A compact card is too narrow for tags or a value beside the date.
  const compactCards = density === 'compact'
  const grid = itemGridGeometry({
    width: viewport.width,
    min: gridCardMin(mixes ? 'mix' : 'subscription', density),
    ratio: mixes ? 1 : 9 / 16,
    tags: !compactCards,
  })
  const scrollIdentity = `${collection}:${identity}:${view}`
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
  function addFilter(filter: BrowseFilter) {
    setParams(
      { filters: JSON.stringify(withSubscriptionFilter(filters, filter)) },
      true,
    )
  }
  const browseHref = host.browseHref ?? `${libraryPath}?${searchParams}`
  function filterHref(filter: BrowseFilter) {
    return browseFilterHref(browseHref, withSubscriptionFilter(filters, filter))
  }
  function changeFilters(next: BrowseFilter[]) {
    setParams({ filters: next.length ? JSON.stringify(next) : null })
  }
  function clearFilters() {
    setParams({
      q: null,
      fields: null,
      filters: null,
      ranges: null,
      ...clearLibraryScope,
      ...(scope ? {} : { sourceId: null }),
    })
  }
  function openDetail(id: string, trigger?: HTMLElement) {
    inspector?.open({ kind: itemKind, id }, trigger)
  }
  function sort(key: string) {
    setParams({
      sortBy: key,
      direction: nextSortDirection(fields, key, { sortBy, direction }),
    })
  }

  useEffect(() => {
    // The saved Browse state belongs to the library's page.
    if (embedded) return
    try {
      const saved = window.localStorage.getItem(`browse:${collection}`)
      if (saved) restoreBrowsePreferences(`${libraryPath}?${saved}`)
    } catch {
      /* Ignore unavailable storage or malformed saved preferences. */
    }
    setReady(true)
  }, [collection, embedded, libraryPath, restoreBrowsePreferences])
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
    if (embedded && scroller.current) return fitDetailList(scroller.current)
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
        ?.querySelector('[aria-selected="true"]')
        ?.scrollIntoView({ block: 'nearest' })
  }, [selectedId])

  const query = useVirtualBrowse({
    performanceScreen: embedded || mixes ? undefined : 'subscriptions',
    apiBaseUrl,
    collection,
    endpoint: 'subscriptions',
    identity,
    params,
    enabled: ready,
    columns: view === 'grid' ? grid.columns : 1,
    rowHeight:
      view === 'grid'
        ? grid.rowHeight
        : view === 'list'
          ? listRowHeight
          : tableRowHeight,
    scrollTop,
    viewportHeight: viewport.height,
    headerHeight:
      view === 'table' || (view === 'list' && !mobile) ? headerHeight : 0,
    itemSchema: SubscriptionItemSchema,
  })
  const { total, slots, padTop, padBottom } = query
  // Table rows can be ticked to add to a playlist (PL-33).
  const loadedIds = slots.flatMap(({ item }) => (item ? [item.id] : []))
  const selection = useRowSelection(loadedIds, {
    identity: scrollIdentity,
    result:
      view === 'table'
        ? { ids: loadedIds, total: query.hasTotal ? total : undefined }
        : undefined,
    outside: slots.flatMap(({ item }) =>
      item?.inLibrary === false ? [item.id] : [],
    ),
  })
  const inLibraryCount = useInLibraryBrowseCount({
    apiBaseUrl,
    collection,
    endpoint: 'subscriptions',
    params,
    enabled: selection.matching,
    total: selection.total,
  })
  const tableWidths = [
    rowSelectionWidth,
    ...columns.map((field) => widths.widthFor(field)),
  ]
  const activeItem =
    inspector?.active?.kind === itemKind
      ? slots.find(({ item }) => item?.id === inspector.active?.id)?.item
      : undefined
  const facets = useBrowseFacets(
    apiBaseUrl,
    collection,
    draft,
    ready,
    false,
    undefined,
    false,
    catalogParams,
  )
  const titleFilters = matchingTitleFilters(facets.data ?? [], facets.search)
  const titleMatches = useQuery({
    queryKey: [
      collection,
      'title-suggestions',
      titleFilters,
      catalogParams,
      ...(sourceId ? [sourceId] : []),
    ],
    enabled: ready && titleFilters.length > 0,
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({
        page: '1',
        size: '100',
        filters: JSON.stringify(titleFilters),
        sortBy: 'title',
        direction: 'asc',
        ...(sourceId ? { sourceId } : {}),
        ...subscriptionLibraryParams(library),
        ...catalogParams,
      })
      return fetchApiData(
        apiBaseUrl,
        `/api/v1/subscriptions?${params}`,
        SubscriptionItemPageSchema,
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
      ? subscriptionTitleSuggestions(titleMatches.data?.items ?? [])
      : []
  const playlistSuggestions = useLibraryPlaylistSuggestions(
    smart,
    facets.isDebouncing ? '' : facets.search,
  )
  const options = [
    ...(facets.data ?? []),
    ...playlistSuggestions.options,
  ].filter(
    (option) =>
      !filters.some(
        (filter) =>
          filter.field === option.field && filter.value === option.value,
      ),
  )
  useEffect(() => {
    // Arrow keys step through the page's own list, not one inside a detail.
    if (embedded) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented) return
      const target = event.target instanceof Element ? event.target : null
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
      // Arrow keys keep their usual meaning inside forms and the detail body.
      if (
        target &&
        target !== document.body &&
        !target.closest('.browse-scroll, .detail-topbar') &&
        !target.matches('.media-inspector')
      )
        return
      const current = slots.findIndex(({ item }) => item?.id === selectedId)
      const next = slots[current + (event.key === 'ArrowDown' ? 1 : -1)]?.item
      if (current < 0 || !next) return
      event.preventDefault()
      inspector?.replace({ kind: itemKind, id: next.id })
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  })

  function published(item: SubscriptionItem) {
    return formatSubscriptionPublished(
      item.publishedAt,
      item.publishedPrecision,
    )
  }

  function cellText(item: SubscriptionItem, field: BrowseField) {
    if (field.key === 'publishedAt') return published(item)
    if (field.key === 'durationSec') return formatSubscriptionDuration(item)
    return formatFieldValue(field, getSubscriptionBrowseValues(item)[field.key])
  }

  function itemLink(item: SubscriptionItem, className?: string) {
    return (
      <DetailLink
        kind={itemKind}
        id={item.id}
        className={className}
        title={item.title}
      >
        {item.title}
      </DetailLink>
    )
  }

  function channelLink(item: SubscriptionItem) {
    return (
      <DetailLink kind={sourceKind} id={item.sourceId}>
        {item.sourceTitle}
      </DetailLink>
    )
  }

  function itemTags(item: SubscriptionItem) {
    return (
      <BrowseTagBadges
        tags={item.tags}
        onFilter={addFilter}
        filterHref={filterHref}
        max={2}
        storedNames
      />
    )
  }

  /** More alone, as these items cannot be played; none outside the library. */
  function itemMore(item: SubscriptionItem, place: 'tile' | 'row') {
    const more = libraryItemMore(library, item)
    return more && <BrowseActions place={place}>{more}</BrowseActions>
  }

  function thumb(item: SubscriptionItem) {
    return (
      <ItemThumb
        kind={mixes ? 'album' : 'video'}
        src={subscriptionArtworkUrl(item)}
        title={item.title}
        target={{ kind: itemKind, id: item.id }}
        contain={item.type === 'spotify'}
      />
    )
  }

  function renderValue(item: SubscriptionItem, field: BrowseField) {
    if (field.key === 'title')
      return (
        <span className="ds-cell-id">
          {thumb(item)}
          {itemLink(item, 'ds-cell-title')}
          {itemMore(item, 'row')}
        </span>
      )
    if (field.key === 'source') return channelLink(item)
    if (field.key === 'genre')
      return item.tags.length ? itemTags(item) : <EmptyValue />
    const value = getSubscriptionBrowseValues(item)[field.key]
    if (field.type === 'text' && field.filterable) {
      const values = textValues(value)
      if (!values.length) return <EmptyValue />
      return (
        <Pills max={2} label={field.label}>
          {values.map((value) => (
            <Pill asChild key={value}>
              <button
                {...workspaceTabLinkProps(
                  filterHref({ field: field.key, value }),
                  value,
                )}
                type="button"
                title={`Filter ${field.label}: ${value}`}
                onClick={() => addFilter({ field: field.key, value })}
              >
                <PillLabel>{value}</PillLabel>
              </button>
            </Pill>
          ))}
        </Pills>
      )
    }
    return cellText(item, field)
  }

  function cardMeta(item: SubscriptionItem) {
    const sorted = cardSortKeys[library].has(sortBy)
      ? sortedValueLabel(sortField, getSubscriptionBrowseValues(item)[sortBy])
      : null
    return (
      <>
        <span>{published(item)}</span>
        {!compactCards && (
          <span>
            {sorted ??
              (item.type === 'youtube'
                ? item.viewCount === null
                  ? 'Views hidden'
                  : `${formatCompactSubscriptionCount(item.viewCount)} views`
                : subscriptionTypeLabels[item.type])}
          </span>
        )}
      </>
    )
  }

  const showFieldsChip = Boolean(q) && state.fields === 'title'
  const activeFilterCount =
    Number(Boolean(q)) +
    Number(showFieldsChip) +
    Number(Boolean(sourceFilter)) +
    filters.length +
    ranges.length
  const filterPills =
    activeFilterCount > 0 ? (
      <>
        {sourceFilter && (
          <BrowseFilterPill
            mode="required"
            destination={{
              href: detailPageHref({ kind: sourceKind, id: sourceFilter }),
              label: sourceTitle ?? labels.source,
            }}
            removeLabel={`Remove ${labels.source.toLowerCase()} filter`}
            onRemove={() => setParams({ sourceId: null })}
          >
            {sourceTitle ? `${labels.source}: ${sourceTitle}` : labels.source}
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
        {showFieldsChip && (
          <BrowseFilterPill
            removeLabel="Search titles and descriptions"
            onRemove={() => setParams({ fields: null })}
          >
            Titles only
          </BrowseFilterPill>
        )}
        <BrowseFilterChips
          filters={filters}
          fields={fields}
          onChange={changeFilters}
          filterHref={(filter) => browseFilterHref(browseHref, [filter])}
          storedTagNames
        />
        {ranges.map((range) => {
          const label = subscriptionRangeLabel(range, fields)
          return (
            <BrowseFilterPill
              key={range.field}
              removeLabel={`Remove ${label}`}
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
      </>
    ) : null

  const autocomplete: BrowseFilterAutocompleteProps = {
    items: titleItems,
    itemKind,
    smartPlaylists: playlistSuggestions.smartPlaylists,
    onOpenSmartPlaylist: smart
      ? (playlist) => {
          smart.choose(playlist)
          setDraft('')
        }
      : undefined,
    titlesLoading,
    titlesError:
      facets.isError ||
      playlistSuggestions.isError ||
      (titleFilters.length > 0 && titleMatches.isError),
    onOpenItem: openDetail,
    options,
    placeholder: searchPlaceholders[library],
    value: draft,
    onFocus: facets.activate,
    onValueChange: setDraft,
    onAddFilter: addFilter,
    filterHref,
    searchHref: (value: string) =>
      browseSearchHref(browseHref, { q: value.slice(0, 200) }),
    onApplyText: (value: string) => {
      setParams({ q: value.slice(0, 200) || null }, true)
      setDraft('')
    },
  }

  return (
    <ResultSection
      identity={identity}
      result={query}
      className={embedded ? undefined : 'media-browser'}
      aria-label={page.name}
    >
      <div className={embedded ? undefined : 'browse-main'}>
        <BrowseToolbar
          search={
            mixes ? (
              <AiSearch
                target={mixAiSearchTarget}
                queryIdentity={identity}
                autocomplete={autocomplete}
                onApply={(plan) => {
                  setParams(aiMixSearchParams(plan))
                  setDraft('')
                }}
              />
            ) : (
              <AiSearch
                target={subscriptionAiSearchTarget}
                queryIdentity={identity}
                autocomplete={autocomplete}
                onApply={(plan) => {
                  setParams(aiSubscriptionSearchParams(plan))
                  setDraft('')
                }}
              />
            )
          }
          sort={{
            key: sortBy,
            direction: sortBy === 'relevance' ? undefined : direction,
            options: subscriptionSortOptions(q, library).map((key) => ({
              key,
              label: sortLabels[key],
            })),
            onChange: sort,
            onDirectionChange: (direction) => setParams({ sortBy, direction }),
          }}
          filterCount={activeFilterCount}
          libraryScope={{
            value: libraryScope,
            onChange: (next) => setParams(libraryScopeUpdates(next)),
          }}
          filters={
            <>
              {smart && <SmartPlaylistsSection smart={smart} />}
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
              {filterPills && (
                <ActiveFiltersSection
                  count={activeFilterCount}
                  onClear={clearFilters}
                >
                  {filterPills}
                </ActiveFiltersSection>
              )}
              <FilterPanelSection
                title="Search"
                icon={<Search className="ds-i" data-size="sm" aria-hidden />}
                count={state.fields === 'title' ? 1 : 0}
              >
                <fieldset className="grid gap-2">
                  <legend className="sr-only">Search in</legend>
                  {searchFieldOptions.map(({ value, label }) => (
                    <label className="ds-checkrow" key={value}>
                      <input
                        type="radio"
                        className="ds-check"
                        name={`${itemKind}-search-fields`}
                        checked={state.fields === value}
                        onChange={() =>
                          setParams({ fields: value === 'all' ? null : value })
                        }
                      />
                      {label}
                    </label>
                  ))}
                </fieldset>
              </FilterPanelSection>
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
            </>
          }
          view={view}
          onViewChange={(next) => setParams({ view: next })}
          density={{
            value: density,
            onChange: (next) => setParams({ density: next }),
          }}
          count={
            <BrowseItemsCount
              query={query}
              total={total}
              unfiltered={embedded ? undefined : query.unfilteredTotal}
              noun={page.items}
            />
          }
          countAction={
            view === 'table' && (
              <SelectAllMatching selection={selection} noun={page.items} />
            )
          }
          end={
            host.browseHref && (
              <Button variant="link" asChild>
                <Link href={host.browseHref}>{`Show in ${page.name}`}</Link>
              </Button>
            )
          }
          compact={embedded}
          activeFilters={
            filterPills && (
              <ClearableFilters onClear={clearFilters}>
                {filterPills}
              </ClearableFilters>
            )
          }
        />
        {(filterPills || smart?.open) && !embedded && (
          <PlacedFilters
            railSlot={railSlot}
            onClear={clearFilters}
            view={
              smart
                ? (place) => <SmartPlaylistName smart={smart} place={place} />
                : undefined
            }
            actions={
              smart
                ? (place) => (
                    <SmartPlaylistActions smart={smart} place={place} />
                  )
                : undefined
            }
          >
            {filterPills}
          </PlacedFilters>
        )}
        <BrowseItemsStates
          query={query}
          total={total}
          noun={page.plural}
          filtered={
            libraryScopeFilterCount(libraryScope) > 0 ||
            hasSubscriptionFilters({
              ...state,
              sourceId: sourceFilter,
            })
          }
          onClear={clearFilters}
          empty={
            <State
              title={`No ${page.plural} yet`}
              action={
                <Button asChild>
                  <Link href={page.importsHref}>Open Imports</Link>
                </Button>
              }
            >
              {emptyLibraryHelp[library]}
            </State>
          }
        />
        <TableScroll
          className={`browse-scroll bi-scroll${embedded ? ` ${embeddedScrollClass}` : ''}`}
          data-view={view}
          data-inspector-scroll={embedded ? '' : undefined}
          ref={scroller}
          role="region"
          aria-label={`${page.name} ${view}`}
          onScroll={(event) =>
            setScroll({
              identity: scrollIdentity,
              top: event.currentTarget.scrollTop,
            })
          }
        >
          {view === 'grid' ? (
            <VirtualCards
              height={query.height}
              padTop={padTop}
              columns={grid.columns}
              cardHeight={grid.cardHeight}
            >
              {slots.map(({ item, index }) => {
                if (!item)
                  return (
                    <CardSkeleton
                      key={`slot-${index}`}
                      ratio={mixes ? undefined : 'video'}
                    />
                  )
                const duration = formatSubscriptionDuration(item)
                const badge =
                  mixes || duration === EMPTY_VALUE ? undefined : duration
                return (
                  <Card
                    key={item.id}
                    data-item-index={index}
                    selected={item.id === selectedId}
                    art={
                      <ItemArt
                        kind={mixes ? 'album' : 'video'}
                        src={subscriptionArtworkUrl(item)}
                        title={item.title}
                        target={{ kind: itemKind, id: item.id }}
                        contain={item.type === 'spotify'}
                        overlay={itemMore(item, 'tile')}
                        badge={badge}
                      />
                    }
                    title={<CardTitle>{itemLink(item)}</CardTitle>}
                    by={channelLink(item)}
                    meta={cardMeta(item)}
                    tags={compactCards ? undefined : itemTags(item)}
                  />
                )
              })}
            </VirtualCards>
          ) : view === 'list' ? (
            <VirtualRows
              height={query.height}
              padTop={padTop}
              compact={mobile}
              head={
                <ListHead
                  title="Title"
                  tags="Tags"
                  playWidth={24}
                  meta={
                    <>
                      <RowValue kind="date">{labels.published}</RowValue>
                      <RowValue kind="num">Duration</RowValue>
                      {!mixes && <RowValue kind="num">Views</RowValue>}
                    </>
                  }
                />
              }
            >
              {slots.map(({ item, index }) =>
                item ? (
                  <ListRow
                    key={item.id}
                    data-item-index={index}
                    selected={item.id === selectedId}
                    thumb={thumb(item)}
                    title={<RowTitle>{itemLink(item)}</RowTitle>}
                    by={channelLink(item)}
                    play={<span>{itemMore(item, 'row')}</span>}
                    tags={itemTags(item)}
                    meta={
                      <>
                        <RowValue kind="date">{published(item)}</RowValue>
                        <RowValue kind="num">
                          {formatSubscriptionDuration(item)}
                        </RowValue>
                        {!mixes && (
                          <RowValue kind="num">
                            {item.type === 'youtube' && item.viewCount !== null
                              ? formatCount(item.viewCount)
                              : EMPTY_VALUE}
                          </RowValue>
                        )}
                      </>
                    }
                  />
                ) : (
                  <RowSkeleton
                    key={`slot-${index}`}
                    ratio={mixes ? undefined : 'video'}
                  />
                ),
              )}
            </VirtualRows>
          ) : (
            <table
              className="ds-table"
              data-layout="fixed"
              aria-label={page.name}
              aria-rowcount={query.hasTotal ? total + 1 : undefined}
              style={{ width: columnsWidth(tableWidths) }}
            >
              <TableColumns widths={tableWidths} />
              <TableHeader>
                <TableRow>
                  <TableHead sticky={0}>
                    <RowSelectAll
                      selection={selection}
                      label={`Select loaded ${page.items.other}`}
                      matchingLabel={`Select all matching ${page.items.other}`}
                      disabled={!loadedIds.length}
                    />
                  </TableHead>
                  {columns.map((field) => (
                    <BrowseItemsHead
                      key={field.key}
                      field={field}
                      identity={field.key === 'title'}
                      sticky={rowSelectionWidth}
                      sortable={isSubscriptionSort(field.key, library)}
                      sortBy={sortBy}
                      direction={sortBy === 'relevance' ? undefined : direction}
                      onSort={sort}
                      resizer={widths.resizer(field)}
                    />
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {padTop > 0 && (
                  <tr className="bi-spacer" aria-hidden="true">
                    <td
                      colSpan={columns.length + 1}
                      style={{ height: padTop }}
                    />
                  </tr>
                )}
                {slots.map(({ item, index }) =>
                  item ? (
                    <TableRow
                      key={item.id}
                      data-item-index={index}
                      selected={
                        item.id === selectedId || selection.has(item.id)
                      }
                      aria-rowindex={index + 2}
                    >
                      <TableCell sticky={0}>
                        <RowSelectRow
                          selection={selection}
                          id={item.id}
                          title={item.title}
                        />
                      </TableCell>
                      {columns.map((field) => (
                        <TableCell
                          key={field.key}
                          align={field.type === 'number' ? 'end' : undefined}
                          sticky={
                            field.key === 'title'
                              ? rowSelectionWidth
                              : undefined
                          }
                          stickyEdge={field.key === 'title'}
                          title={cellText(item, field)}
                        >
                          {renderValue(item, field)}
                        </TableCell>
                      ))}
                    </TableRow>
                  ) : (
                    <TableRow
                      key={`slot-${index}`}
                      aria-hidden="true"
                      data-placeholder=""
                    >
                      <TableCell />
                      {columns.map((field) => (
                        <TableCell key={field.key}>
                          <Skeleton height={10} width="70%" />
                        </TableCell>
                      ))}
                    </TableRow>
                  ),
                )}
                {padBottom > 0 && (
                  <tr className="bi-spacer" aria-hidden="true">
                    <td
                      colSpan={columns.length + 1}
                      style={{ height: padBottom }}
                    />
                  </tr>
                )}
              </TableBody>
            </table>
          )}
        </TableScroll>
        {!embedded && (
          <ResultLineSlot
            place="content"
            hidden={view === 'table' && selection.count > 0}
          />
        )}
        {view === 'table' && (
          <SelectionBar
            selection={selection}
            total={query.hasTotal ? total : undefined}
            actions={
              <AddToPlaylistButton
                subject={
                  selection.matching
                    ? matchingSubject(
                        library,
                        params,
                        selection.excludeIds,
                        matchingCount(inLibraryCount.total ?? 0, selection),
                      )
                    : selectionSubject(
                        library,
                        selection.ids,
                        slots.map(({ item }) => item),
                      )
                }
                suggestedName={suggestedPlaylistName(filters, q)}
                primary
                counting={
                  selection.matching && inLibraryCount.total === undefined
                }
                blocked={
                  selection.matching ? matchingBlocked(inLibraryCount) : null
                }
                onAdded={selection.clear}
              />
            }
          />
        )}
      </div>
      {embedded ? null : mixes ? (
        <DetailInspector
          mix={{ initialItem: activeItem, onFilter: addFilter, filterHref }}
        />
      ) : (
        <DetailInspector
          subscription={{
            initialItem: activeItem,
            onFilter: addFilter,
            filterHref,
          }}
        />
      )}
    </ResultSection>
  )
}
