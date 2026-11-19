'use client'

import Link from 'next/link'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import { Search } from 'lucide-react'
import { Button } from '@repo/ui/components/ui/button'
import {
  TableBody,
  TableCell,
  TableHeader,
  TableRow,
  TableScroll,
} from '@repo/ui/components/ui/table'
import { Card, CardTitle } from '@repo/ui/components/ds/card'
import {
  ListHead,
  ListRow,
  RowTitle,
  RowValue,
} from '@repo/ui/components/ds/list-row'
import { EmptyValue, Pill, PillLabel, Pills } from '@repo/ui/components/ds/pill'
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
import { useVirtualBrowse } from '@/hooks/useVirtualBrowse'
import { useBrowseFacets } from '@/hooks/useBrowseFacets'
import { useRailSlot } from '@/hooks/useRailSlot'
import { useGridDensity } from '@/hooks/useGridDensity'
import { useSubscriptionSource } from '@/hooks/useSubscriptionSource'
import { useColumnWidths } from '@/hooks/useColumnWidths'
import { matchingTitleFilters } from '@/utils/browse-suggestions'
import { gridCardMin, preserveGridScroll } from '@/utils/media-grid'
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
  updateSubscriptionSearch,
  withSubscriptionFilter,
} from '@/utils/subscriptions'
import {
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
import {
  replaceWorkspaceUrl,
  useDetailInspector,
} from './detail-inspector-context'
import { sameDetail, withoutDetailEntries } from '@/utils/detail-inspector'
import AiSearch from './ai-search'
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
  const page = subscriptionLibraryPages[library]
  const { collection, path: libraryPath, itemKind, sourceKind } = page
  const labels = subscriptionLibraryLabels[library]
  const mixes = library === 'mixes'
  const { apiBaseUrl } = useConfig()
  const searchParams = useSearchParams()
  const [ready, setReady] = useState(false)
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
  const railSlot = useRailSlot()
  const state = parseSubscriptionBrowseState(
    new URLSearchParams(searchParams),
    library,
  )
  const { q, filters, ranges, view, sourceId } = state
  const { identity, params, sortBy, direction } = subscriptionBrowseQuery(
    state,
    library,
  )
  const sourceTitle = useSubscriptionSource(sourceId, library).data?.source
    .title
  const selectedId =
    inspector?.root?.kind === itemKind ? inspector.root.id : null
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
  const widths = useColumnWidths(collection, (field: BrowseField) =>
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
    const next = updateSubscriptionSearch(window.location.search, updates)
    const params = close ? withoutDetailEntries(libraryPath, next) : next
    const url = `${libraryPath}${params.size ? `?${params}` : ''}`
    replaceWorkspaceUrl(url, !close)
    try {
      window.localStorage.setItem(
        `browse:${collection}`,
        savedSubscriptionSearch(withoutDetailEntries(libraryPath, params)),
      )
    } catch {
      /* URL state still works when browser storage is unavailable. */
    }
  }
  function addFilter(filter: BrowseFilter) {
    setParams(
      { filters: JSON.stringify(withSubscriptionFilter(filters, filter)) },
      true,
    )
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
      sourceId: null,
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
    try {
      const saved = window.localStorage.getItem(`browse:${collection}`)
      if (!window.location.search && saved)
        window.history.replaceState(null, '', `${libraryPath}?${saved}`)
    } catch {
      /* Ignore unavailable storage or malformed saved preferences. */
    }
    setReady(true)
  }, [collection, libraryPath])
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

  const query = useVirtualBrowse({
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
  const activeItem =
    inspector?.active?.kind === itemKind
      ? slots.find(({ item }) => item?.id === inspector.active?.id)?.item
      : undefined
  const facets = useBrowseFacets(apiBaseUrl, collection, draft, ready)
  const titleFilters = matchingTitleFilters(facets.data ?? [], facets.search)
  const titleMatches = useQuery({
    queryKey: [
      collection,
      'title-suggestions',
      titleFilters,
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
        max={2}
        storedNames
      />
    )
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
    Number(Boolean(sourceId)) +
    filters.length +
    ranges.length
  const filterPills =
    activeFilterCount > 0 ? (
      <>
        {sourceId && (
          <BrowseFilterPill
            mode="required"
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

  const autocomplete = {
    items: titleItems,
    titlesLoading,
    titlesError:
      facets.isError || (titleFilters.length > 0 && titleMatches.isError),
    onOpenItem: openDetail,
    options,
    placeholder: searchPlaceholders[library],
    value: draft,
    onFocus: facets.activate,
    onValueChange: setDraft,
    onAddFilter: addFilter,
    onApplyText: (value: string) => {
      setParams({ q: value.slice(0, 200) || null }, true)
      setDraft('')
    },
  }

  return (
    <section className="media-browser" aria-label={page.name}>
      <div className="browse-main">
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
          filters={
            <>
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
              noun={page.items}
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
          noun={page.plural}
          filtered={hasSubscriptionFilters(state)}
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
          className="browse-scroll bi-scroll"
          data-view={view}
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
                        badge={
                          mixes || duration === EMPTY_VALUE
                            ? undefined
                            : duration
                        }
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
                  playWidth={0}
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
              style={{
                width: columns.reduce(
                  (sum, field) => sum + widths.widthFor(field),
                  0,
                ),
              }}
            >
              <colgroup>
                {columns.map((field) => (
                  <col
                    key={field.key}
                    style={{ width: widths.widthFor(field) }}
                  />
                ))}
              </colgroup>
              <TableHeader>
                <TableRow>
                  {columns.map((field) => (
                    <BrowseItemsHead
                      key={field.key}
                      field={field}
                      identity={field.key === 'title'}
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
                          sticky={field.key === 'title' ? 0 : undefined}
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
      {mixes ? (
        <DetailInspector
          mix={{ initialItem: activeItem, onFilter: addFilter }}
        />
      ) : (
        <DetailInspector
          subscription={{ initialItem: activeItem, onFilter: addFilter }}
        />
      )}
    </section>
  )
}
