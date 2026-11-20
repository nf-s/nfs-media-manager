'use client'

import { useRestoreBrowsePreferences } from './workspace-tab-context'
import { workspaceTabLinkProps } from '@/utils/workspace-tab-destination'
import {
  replaceWorkspaceUrl,
  useDetailInspector,
} from './detail-inspector-context'
import {
  detailPageHref,
  sameDetail,
  withoutDetailEntries,
} from '@/utils/detail-inspector'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import {
  TableBody,
  TableCell,
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
import { Skeleton } from '@repo/ui/components/ds/feedback'
import { Sparkline } from '@repo/ui/components/ds/trend-chart'
import { formatCount, formatItemCount } from '@repo/ui/lib/format'
import {
  BrowseFieldSchema,
  BrowsePageSliceSchema,
  canonicalBrowseKey,
  type BrowseField,
  type BrowseFilter,
} from '@repo/schemas/browse'
import {
  ArtistQuerySchema,
  ArtistSummarySchema,
  type ArtistSummary,
} from '@repo/schemas/creators'
import {
  artistBrowseFields,
  getArtistBrowseValues,
} from '@repo/schemas/artist-browse'
import { useConfig } from './providers'
import { fetchApiData } from '@/utils/api'
import { useVirtualBrowse } from '@/hooks/useVirtualBrowse'
import { useBrowseFacets } from '@/hooks/useBrowseFacets'
import { useRailSlot } from '@/hooks/useRailSlot'
import { matchingTitleFilters } from '@/utils/browse-suggestions'
import {
  artistFieldOrder,
  defaultArtistColumns,
  parseArtistFilters,
  artistTitleSuggestions,
  withArtistFilter,
} from '@/utils/artist-browse'
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
import { aiSearchParams, mediaAiSearchTarget } from '@/utils/ai-search'
import {
  defaultListeningPeriod,
  type ListeningFilter,
} from '@repo/schemas/listening'
import {
  listeningScrobblesField,
  listeningScrobblesKey,
  parseListeningParams,
} from '@/utils/listening-filters'
import AiSearch from './ai-search'
import {
  BrowseFilterChips,
  BrowseFilterPill,
  BrowseTagBadges,
  RangeEditor,
} from './browse-controls'
import BrowseToolbar, { BrowseColumnsSection } from './browse-toolbar'
import { ListeningControls, ListeningFilterPills } from './listening-controls'
import {
  gridCardMin,
  parseBrowseView,
  preserveGridScroll,
} from '@/utils/media-grid'
import { useGridDensity } from '@/hooks/useGridDensity'
import { useColumnWidths } from '@/hooks/useColumnWidths'
import { DetailLink } from './detail-link'
import {
  ActiveFiltersSection,
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

const collection = 'artists'
const PageSchema = BrowsePageSliceSchema(ArtistSummarySchema)
/** --ds-head, --ds-row-media and --ds-row. */
const headerHeight = 28
const listRowHeight = 48
const tableRowHeight = 32
const noun = { one: 'artist', other: 'artists' }

export default function ArtistBrowser() {
  const { apiBaseUrl } = useConfig()
  const searchParams = useSearchParams()
  const restoreBrowsePreferences = useRestoreBrowsePreferences()
  const [ready, setReady] = useState(false)
  const [draft, setDraft] = useState('')
  const [scroll, setScroll] = useState({ identity: '', top: 0 })
  const [viewport, setViewport] = useState({ width: 1000, height: 800 })
  const [gridLayout, setGridLayout] = useState<{
    identity: string
    columns: number
    rowHeight: number
  } | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const inspector = useDetailInspector()
  const railSlot = useRailSlot()
  const view = parseBrowseView(searchParams.get('view'), 'list')
  const density = useGridDensity(searchParams.get('density'))
  const filters = parseArtistFilters(searchParams.get('filters'))
  const playlistsResult = ArtistQuerySchema.shape.playlistIds.safeParse(
    searchParams.get('playlistIds') ?? undefined,
  )
  const playlistIds = playlistsResult.success ? playlistsResult.data : []
  const limitResult = ArtistQuerySchema.shape.limitResults.safeParse(
    searchParams.get('limitResults') ?? undefined,
  )
  const limitResults = limitResult.success ? limitResult.data : undefined
  const rangesResult = ArtistQuerySchema.shape.ranges.safeParse(
    searchParams.get('ranges') ?? undefined,
  )
  const ranges = rangesResult.success ? rangesResult.data : []
  const q = searchParams.get('q') ?? ''
  const sortResult = ArtistQuerySchema.shape.sortBy.safeParse(
    searchParams.get('sortBy') ?? undefined,
  )
  const sortBy = sortResult.success ? sortResult.data : 'name'
  const direction = searchParams.get('direction') === 'desc' ? 'desc' : 'asc'
  const selectedId =
    inspector?.root?.kind === 'artist' ? inspector.root.id : null
  const fieldsQuery = useQuery({
    queryKey: [collection, 'fields'],
    queryFn: () =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/${collection}/fields`,
        z.array(BrowseFieldSchema),
      ),
  })
  const { listening, listeningSort } = parseListeningParams(searchParams)
  const fields = [
    ...orderFields(fieldsQuery.data ?? artistBrowseFields, artistFieldOrder),
    listeningScrobblesField(listeningSort),
  ]
  const sortField = fields.find((field) => field.key === sortBy)
  const columnKeys = [
    ...new Set([
      'name',
      ...(searchParams.get('columns')?.split(',').map(canonicalBrowseKey) ??
        defaultArtistColumns),
    ]),
  ]
  const columnOrder = parseColumnOrder(searchParams.get('columnOrder'))
  const orderedFields = orderColumns(fields, columnOrder, 'name')
  const columns = orderedFields.filter((field) =>
    columnKeys.includes(field.key),
  )
  const widths = useColumnWidths(collection, (field: BrowseField) =>
    field.key === 'name' ? 260 : field.type === 'text' ? 180 : 110,
  )
  const requestedListeningPeriod =
    sortBy === listeningScrobblesKey ||
    columnKeys.includes(listeningScrobblesKey)
      ? (listeningSort ?? defaultListeningPeriod)
      : undefined
  const queryKey = JSON.stringify({
    q,
    filters,
    ranges,
    sortBy,
    direction,
    playlistIds,
    limitResults,
    listening,
    listeningSort: requestedListeningPeriod,
  })
  const scrollIdentity = `${collection}:${queryKey}:${view}`
  const mobile = viewport.width <= 700
  // A compact card is too narrow for tags or a value beside the album count.
  const compactCards = density === 'compact'
  const grid = itemGridGeometry({
    width: viewport.width,
    min: gridCardMin('artist', density),
    tags: !compactCards,
  })
  const rowHeight =
    view === 'grid'
      ? grid.rowHeight
      : view === 'list'
        ? listRowHeight
        : tableRowHeight
  const previousScrollTop = scroll.identity === scrollIdentity ? scroll.top : 0
  const scrollTop =
    view === 'grid' && gridLayout?.identity === scrollIdentity
      ? preserveGridScroll(previousScrollTop, gridLayout, grid)
      : previousScrollTop

  function setParams(updates: Record<string, string | null>, close = false) {
    const pathname = `/${collection}`
    const current = new URLSearchParams(window.location.search)
    const params = close ? withoutDetailEntries(pathname, current) : current
    for (const [key, value] of Object.entries(updates)) {
      if (value === null || value === '') params.delete(key)
      else params.set(key, value)
    }
    params.delete('page')
    replaceWorkspaceUrl(`${pathname}${params.size ? `?${params}` : ''}`, !close)
    try {
      window.localStorage.setItem(
        `browse:${collection}`,
        withoutDetailEntries(pathname, params).toString(),
      )
    } catch {
      /* URL state still works when browser storage is unavailable. */
    }
  }
  function addFilter(filter: BrowseFilter, keepOpen = false) {
    const next = withArtistFilter(filters, filter)
    setParams({ filters: JSON.stringify(next) }, !keepOpen)
  }
  const browseHref = `/${collection}?${searchParams}`
  function filterHref(filter: BrowseFilter) {
    return browseFilterHref(browseHref, withArtistFilter(filters, filter))
  }
  function changeFilters(next: BrowseFilter[]) {
    setParams({ filters: next.length ? JSON.stringify(next) : null })
  }
  function clearFilters() {
    setParams({
      q: null,
      filters: null,
      ranges: null,
      playlistIds: null,
      limitResults: null,
      listening: null,
    })
  }
  function changeListening(next: ListeningFilter | undefined) {
    setParams({ listening: next ? JSON.stringify(next) : null })
  }
  function openDetail(id: string, trigger?: HTMLElement) {
    inspector?.open({ kind: 'artist', id }, trigger)
  }
  function sort(key: string) {
    setParams({
      sortBy: key,
      direction: nextSortDirection(fields, key, { sortBy, direction }),
    })
  }

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(`browse:${collection}`)
      if (saved) restoreBrowsePreferences(`/${collection}?${saved}`)
    } catch {
      /* Ignore unavailable storage or malformed saved preferences. */
    }
    setReady(true)
  }, [restoreBrowsePreferences])
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

  const params = new URLSearchParams({
    q,
    filters: JSON.stringify(filters),
    ranges: JSON.stringify(ranges),
    sortBy,
    direction,
    playlistIds: JSON.stringify(playlistIds),
    ...(limitResults ? { limitResults: String(limitResults) } : {}),
    ...(listening ? { listening: JSON.stringify(listening) } : {}),
    ...(requestedListeningPeriod
      ? { listeningSort: JSON.stringify(requestedListeningPeriod) }
      : {}),
  })
  const query = useVirtualBrowse({
    apiBaseUrl,
    collection,
    identity: queryKey,
    params,
    enabled: ready,
    columns: view === 'grid' ? grid.columns : 1,
    rowHeight,
    scrollTop,
    viewportHeight: viewport.height,
    headerHeight:
      view === 'table' || (view === 'list' && !mobile) ? headerHeight : 0,
    itemSchema: ArtistSummarySchema,
  })
  const { total, slots, padTop, padBottom } = query
  const facets = useBrowseFacets(apiBaseUrl, collection, draft, ready)
  const titleFilters = matchingTitleFilters(
    facets.data ?? [],
    facets.search,
    'name',
  )
  const titleMatches = useQuery({
    queryKey: [collection, 'title-suggestions', titleFilters],
    enabled: ready && titleFilters.length > 0,
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({
        page: '1',
        size: '100',
        filters: JSON.stringify(titleFilters),
        sortBy: 'name',
        direction: 'asc',
      })
      return fetchApiData(
        apiBaseUrl,
        `/api/v1/${collection}/browse-page?${params}`,
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
      ? artistTitleSuggestions(titleMatches.data?.items ?? [])
      : []
  const options = (facets.data ?? []).filter(
    (option) =>
      !filters.some(
        (filter) =>
          filter.field === option.field && filter.value === option.value,
      ),
  )
  useEffect(() => {
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
      inspector?.replace({ kind: 'artist', id: next.id })
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  })

  function artistLink(item: ArtistSummary, className?: string) {
    return (
      <DetailLink
        kind="artist"
        id={item.id}
        className={className}
        title={item.name}
      >
        {item.name}
      </DetailLink>
    )
  }

  function artistTags(item: ArtistSummary, max = 2) {
    return (
      <BrowseTagBadges
        tags={textValues(getArtistBrowseValues(item).genre)}
        onFilter={addFilter}
        filterHref={filterHref}
        max={max}
      />
    )
  }

  function country(item: ArtistSummary) {
    return textValues(getArtistBrowseValues(item).country).join(', ')
  }

  function renderValue(item: ArtistSummary, field: BrowseField) {
    if (field.key === 'name')
      return (
        <span className="ds-cell-id">
          <ItemThumb
            kind="artist"
            src={item.artworkUrl}
            title={item.name}
            target={{ kind: 'artist', id: item.id }}
          />
          {artistLink(item, 'ds-cell-title')}
        </span>
      )
    const value = getArtistBrowseValues(item)[field.key]
    if (field.key === 'genre')
      return textValues(value).length ? artistTags(item) : <EmptyValue />
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
    return formatFieldValue(field, value)
  }

  function cardMeta(item: ArtistSummary) {
    const sorted = sortedValueLabel(
      sortField,
      getArtistBrowseValues(item)[sortBy],
    )
    return (
      <>
        <span>
          {formatItemCount(item.albumCount, { one: 'album', other: 'albums' })}
        </span>
        {!compactCards && (
          <span>
            {sortBy !== 'albumCount' && sortBy !== 'scrobbles' && sorted ? (
              sorted
            ) : item.scrobbleCount === undefined ? (
              <EmptyValue />
            ) : (
              formatItemCount(item.scrobbleCount, {
                one: 'scrobble',
                other: 'scrobbles',
              })
            )}
          </span>
        )}
      </>
    )
  }

  const activeFilterCount =
    Number(Boolean(q)) +
    Number(playlistIds.length > 0) +
    Number(Boolean(limitResults)) +
    filters.length +
    ranges.length +
    (listening?.rules.length ?? 0)
  const singlePlaylistId = playlistIds.length === 1 ? playlistIds[0] : undefined
  const filterPills =
    activeFilterCount > 0 ? (
      <>
        {playlistIds.length > 0 && (
          <BrowseFilterPill
            mode="required"
            destination={
              singlePlaylistId
                ? {
                    href: detailPageHref({
                      kind: 'playlist',
                      id: singlePlaylistId,
                    }),
                    label: 'Playlist',
                  }
                : undefined
            }
            removeLabel="Remove playlist filter"
            onRemove={() => setParams({ playlistIds: null })}
          >
            Playlists: {formatCount(playlistIds.length)} selected
          </BrowseFilterPill>
        )}
        {limitResults && (
          <BrowseFilterPill
            removeLabel="Remove limit"
            onRemove={() => setParams({ limitResults: null })}
          >
            Limit: {formatCount(limitResults)}
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
              : field
                ? formatFieldValue(field, value)
                : String(value)
          const label = `${field?.label ?? range.field}: ${bound(range.min)} to ${bound(range.max)}${range.includeMissing ? ' + missing' : ''}`
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
        <ListeningFilterPills
          library="artist"
          filter={listening}
          onChange={changeListening}
        />
      </>
    ) : null

  return (
    <section className="media-browser" aria-label={collection}>
      <div className="browse-main">
        <BrowseToolbar
          search={
            <AiSearch
              target={mediaAiSearchTarget('artist', fields)}
              queryIdentity={queryKey}
              autocomplete={{
                items: titleItems,
                itemKind: 'artist',
                titlesLoading,
                titlesError:
                  facets.isError ||
                  (titleFilters.length > 0 && titleMatches.isError),
                onOpenItem: openDetail,
                options,
                placeholder: 'Search artists, playlists, tags, countries...',
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
                setParams({ ...aiSearchParams(plan), playlistIds: null })
                setDraft('')
              }}
            />
          }
          sort={{
            key: sortBy,
            direction,
            options: fields,
            onChange: sort,
            onDirectionChange: (direction) => setParams({ direction }),
          }}
          filterCount={activeFilterCount}
          filters={
            <>
              {view === 'table' && (
                <BrowseColumnsSection>
                  <ColumnChoices
                    fields={orderedFields}
                    selected={columnKeys}
                    required="name"
                    onChange={(keys) => setParams({ columns: keys.join(',') })}
                    onOrderChange={(keys) =>
                      setParams({ columnOrder: columnOrderParam(keys, fields) })
                    }
                    onResetOrder={
                      hasCustomColumnOrder(orderedFields, fields, 'name')
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
              <ListeningControls
                apiBaseUrl={apiBaseUrl}
                library="artist"
                params={params}
                filter={listening}
                sortPeriod={listeningSort}
                total={query.hasTotal ? total : undefined}
                examples={slots
                  .flatMap(({ item }) => (item ? [item] : []))
                  .slice(0, 3)
                  .map((item) => ({
                    id: item.id,
                    title: item.name,
                    artworkUrl: item.artworkUrl,
                    by: formatItemCount(item.albumCount, {
                      one: 'album',
                      other: 'albums',
                    }),
                  }))}
                onFilterChange={changeListening}
                onSortPeriodChange={(period) =>
                  setParams({ listeningSort: JSON.stringify(period) })
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
              unfiltered={query.unfilteredTotal}
              noun={noun}
            />
          }
        />
        {filterPills && (
          <PlacedFilters railSlot={railSlot} onClear={clearFilters}>
            {filterPills}
          </PlacedFilters>
        )}
        <BrowseItemsStates
          query={query}
          total={total}
          noun="artists"
          filtered={activeFilterCount > 0}
          onClear={clearFilters}
        />
        <TableScroll
          className="browse-scroll bi-scroll"
          data-view={view}
          ref={scroller}
          role="region"
          aria-label={`${collection} ${view}`}
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
              {slots.map(({ item, index }) =>
                item ? (
                  <Card
                    key={item.id}
                    data-item-index={index}
                    selected={item.id === selectedId}
                    art={
                      <ItemArt
                        kind="artist"
                        src={item.artworkUrl}
                        title={item.name}
                        target={{ kind: 'artist', id: item.id }}
                      />
                    }
                    title={<CardTitle>{artistLink(item)}</CardTitle>}
                    by={country(item) || undefined}
                    meta={cardMeta(item)}
                    tags={compactCards ? undefined : artistTags(item, 1)}
                  />
                ) : (
                  <CardSkeleton key={`slot-${index}`} ratio="round" />
                ),
              )}
            </VirtualCards>
          ) : view === 'list' ? (
            <VirtualRows
              height={query.height}
              padTop={padTop}
              compact={mobile}
              head={
                <ListHead
                  title="Artist"
                  tags="Tags"
                  playWidth={0}
                  meta={
                    <>
                      <RowValue kind="num">Albums</RowValue>
                      <RowValue kind="num">Scrobbles</RowValue>
                      <RowValue kind="spark">All time</RowValue>
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
                    thumb={
                      <ItemThumb
                        kind="artist"
                        src={item.artworkUrl}
                        title={item.name}
                        target={{ kind: 'artist', id: item.id }}
                      />
                    }
                    title={<RowTitle>{artistLink(item)}</RowTitle>}
                    by={country(item)}
                    tags={artistTags(item, 1)}
                    meta={
                      <>
                        <RowValue kind="num">
                          {formatCount(item.albumCount)}
                        </RowValue>
                        <RowValue kind="num">
                          {item.scrobbleCount === undefined ? (
                            <EmptyValue />
                          ) : (
                            formatCount(item.scrobbleCount)
                          )}
                        </RowValue>
                        <RowValue kind="spark">
                          {item.listeningMonths && (
                            <Sparkline
                              values={item.listeningMonths}
                              label={`Scrobbles for ${item.name}, all time`}
                            />
                          )}
                        </RowValue>
                      </>
                    }
                  />
                ) : (
                  <RowSkeleton key={`slot-${index}`} ratio="round" />
                ),
              )}
            </VirtualRows>
          ) : (
            <table
              className="ds-table"
              data-layout="fixed"
              aria-label="Artists"
              aria-rowcount={query.hasTotal ? total + 1 : undefined}
              style={{
                width: columnsWidth(
                  columns.map((field) => widths.widthFor(field)),
                ),
              }}
            >
              <TableColumns
                widths={columns.map((field) => widths.widthFor(field))}
              />
              <TableHeader>
                <TableRow>
                  {columns.map((field) => (
                    <BrowseItemsHead
                      key={field.key}
                      field={field}
                      identity={field.key === 'name'}
                      sortBy={sortBy}
                      direction={direction}
                      onSort={sort}
                      resizer={widths.resizer(field)}
                    />
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {padTop > 0 && (
                  <tr className="bi-spacer" aria-hidden="true">
                    <td colSpan={columns.length} style={{ height: padTop }} />
                  </tr>
                )}
                {slots.map(({ item, index }) =>
                  item ? (
                    <TableRow
                      key={item.id}
                      data-item-index={index}
                      selected={item.id === selectedId}
                      aria-rowindex={index + 2}
                    >
                      {columns.map((field) => (
                        <TableCell
                          key={field.key}
                          align={field.type === 'number' ? 'end' : undefined}
                          sticky={field.key === 'name' ? 0 : undefined}
                          stickyEdge={field.key === 'name'}
                          title={formatFieldValue(
                            field,
                            getArtistBrowseValues(item)[field.key],
                          )}
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
                      colSpan={columns.length}
                      style={{ height: padBottom }}
                    />
                  </tr>
                )}
              </TableBody>
            </table>
          )}
        </TableScroll>
      </div>
    </section>
  )
}
