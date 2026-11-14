'use client'

import Link from 'next/link'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useSearchParams } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import {
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  Columns3,
  Grid2X2,
  Rows3,
  Search,
  X,
} from 'lucide-react'
import { Button } from '@repo/ui/components/ui/button'
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableScroll,
} from '@repo/ui/components/ui/table'
import {
  BrowseFieldSchema,
  canonicalBrowseKey,
  formatBrowseValue,
  type BrowseField,
  type BrowseFilter,
} from '@repo/schemas/browse'
import {
  SubscriptionItemPageSchema,
  SubscriptionItemSchema,
  getSubscriptionBrowseValues,
  subscriptionBrowseFields,
  subscriptionTypeLabels,
  type SubscriptionItem,
} from '@repo/schemas/subscriptions'
import { useConfig } from './providers'
import { fetchApiData } from '@/utils/api'
import { useVirtualBrowse } from '@/hooks/useVirtualBrowse'
import { useBrowseFacets } from '@/hooks/useBrowseFacets'
import { useRailSlot } from '@/hooks/useRailSlot'
import { matchingTitleFilters } from '@/utils/browse-suggestions'
import { preserveGridScroll } from '@/utils/media-grid'
import {
  aiSubscriptionSearchParams,
  subscriptionAiSearchTarget,
} from '@/utils/ai-search'
import {
  defaultSubscriptionColumns,
  formatCompactSubscriptionCount,
  formatSubscriptionDuration,
  formatSubscriptionPublished,
  hasSubscriptionFilters,
  isSubscriptionSort,
  parseSubscriptionBrowseState,
  savedSubscriptionSearch,
  subscriptionBrowseQuery,
  subscriptionCollection,
  subscriptionGridGeometry,
  subscriptionImportsHref,
  subscriptionOpenLabel,
  subscriptionRangeLabel,
  subscriptionSortLabels,
  subscriptionSortOptions,
  subscriptionTitleSuggestions,
  subscriptionsPath,
  updateSubscriptionSearch,
  withSubscriptionFilter,
} from '@/utils/subscriptions'
import { errorMessage } from './lastfm-sync'
import AiSearch from './ai-search'
import { BrowseFilterChips, RangeEditor } from './browse-controls'
import BrowseFilterPanel, { FilterPanelSection } from './browse-filter-panel'
import { FilterButton } from './filter-affordance'
import {
  SourceAvatar,
  SubscriptionItemDetails,
  SubscriptionThumbnail,
} from './subscription-item-details'
import styles from './subscription-browser.module.css'

const collection = subscriptionCollection
const WidthsSchema = z.record(z.string(), z.number().min(70).max(650))
/** `.browse-cell` height plus the row divider. */
const rowHeight = 36
const headerHeight = 24
const thumbColumnWidth = 70
const searchFieldOptions: Array<{ value: 'all' | 'title'; label: string }> = [
  { value: 'all', label: 'Titles and descriptions' },
  { value: 'title', label: 'Titles only' },
]

export default function SubscriptionBrowser() {
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
  const [widths, setWidths] = useState<Record<string, number>>({})
  const scroller = useRef<HTMLDivElement>(null)
  const inspector = useRef<HTMLElement>(null)
  const railSlot = useRailSlot()
  const openedHere = useRef(false)
  const detailTrigger = useRef<HTMLElement | null>(null)
  const resize = useRef<{ key: string; x: number; width: number } | null>(null)
  const state = parseSubscriptionBrowseState(new URLSearchParams(searchParams))
  const { q, filters, ranges, view } = state
  const { identity, params, sortBy, direction } = subscriptionBrowseQuery(state)
  const selectedId = searchParams.get('item')
  const fieldsQuery = useQuery({
    queryKey: [collection, 'fields'],
    queryFn: () =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/${collection}/fields`,
        z.array(BrowseFieldSchema),
      ),
  })
  const fields = fieldsQuery.data ?? subscriptionBrowseFields
  const columnFields = fields.filter((field) => field.key !== 'description')
  const columnKeys =
    state.columns?.map(canonicalBrowseKey) ?? defaultSubscriptionColumns
  const columns = columnFields.filter((field) => columnKeys.includes(field.key))
  const grid = subscriptionGridGeometry(viewport.width)
  const scrollIdentity = `${collection}:${identity}:${view}`
  const previousScrollTop = scroll.identity === scrollIdentity ? scroll.top : 0
  const scrollTop =
    view === 'grid' && gridLayout?.identity === scrollIdentity
      ? preserveGridScroll(previousScrollTop, gridLayout, grid)
      : previousScrollTop

  function setParams(updates: Record<string, string | null>, push = false) {
    const next = updateSubscriptionSearch(window.location.search, updates)
    const url = `${subscriptionsPath}${next.size ? `?${next}` : ''}`
    if (push) window.history.pushState(null, '', url)
    else window.history.replaceState(null, '', url)
    try {
      window.localStorage.setItem(
        `browse:${collection}`,
        savedSubscriptionSearch(next),
      )
    } catch {
      /* URL state still works when browser storage is unavailable. */
    }
  }
  function addFilter(filter: BrowseFilter) {
    setParams({
      filters: JSON.stringify(withSubscriptionFilter(filters, filter)),
      item: null,
    })
  }
  function changeFilters(next: BrowseFilter[]) {
    if (selectedId) openedHere.current = false
    setParams({ filters: next.length ? JSON.stringify(next) : null })
  }
  function clearFilters() {
    setParams({ q: null, fields: null, filters: null, ranges: null })
  }
  function closeDetail() {
    if (openedHere.current) {
      openedHere.current = false
      window.history.back()
    } else setParams({ item: null })
  }
  function openDetail(id: string, trigger?: HTMLElement) {
    detailTrigger.current = trigger ?? null
    openedHere.current = true
    setParams({ item: id }, true)
  }
  function sort(key: string) {
    setParams({
      sortBy: key,
      direction: sortBy === key && direction === 'desc' ? 'asc' : 'desc',
    })
  }
  function saveWidths(next: Record<string, number>) {
    setWidths(next)
    try {
      localStorage.setItem(`widths:${collection}`, JSON.stringify(next))
    } catch {
      /* Width changes remain usable for this session. */
    }
  }

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(`browse:${collection}`)
      if (!window.location.search && saved)
        window.history.replaceState(null, '', `${subscriptionsPath}?${saved}`)
      const parsed = WidthsSchema.safeParse(
        JSON.parse(window.localStorage.getItem(`widths:${collection}`) ?? '{}'),
      )
      if (parsed.success) setWidths(parsed.data)
    } catch {
      /* Ignore unavailable storage or malformed saved preferences. */
    }
    setReady(true)
  }, [])
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
    if (selectedId) {
      // The inspector covers the results, so it takes focus.
      inspector.current?.focus({ preventScroll: true })
      scroller.current
        ?.querySelector('[data-selected="true"]')
        ?.scrollIntoView({ block: 'nearest' })
    } else if (detailTrigger.current?.isConnected)
      detailTrigger.current.focus({ preventScroll: true })
  }, [selectedId])

  const query = useVirtualBrowse({
    apiBaseUrl,
    collection,
    identity,
    params,
    enabled: ready,
    columns: view === 'grid' ? grid.columns : 1,
    rowHeight: view === 'grid' ? grid.rowHeight : rowHeight,
    scrollTop,
    viewportHeight: viewport.height,
    headerHeight: view === 'list' ? headerHeight : 0,
    itemSchema: SubscriptionItemSchema,
  })
  const { total, slots, padTop, padBottom } = query
  const loadedItem = selectedId
    ? slots.find(({ item }) => item?.id === selectedId)?.item
    : undefined
  // A direct link to an item outside the loaded rows reads it on its own.
  const itemQuery = useQuery({
    queryKey: [collection, 'item', selectedId],
    enabled: ready && Boolean(selectedId) && !loadedItem,
    retry: false,
    queryFn: ({ signal }) =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/${collection}/${encodeURIComponent(selectedId ?? '')}`,
        SubscriptionItemSchema,
        { signal },
      ),
  })
  const selectedItem = loadedItem ?? itemQuery.data
  const facets = useBrowseFacets(apiBaseUrl, collection, draft, ready)
  const titleFilters = matchingTitleFilters(facets.data ?? [], facets.search)
  const titleMatches = useQuery({
    queryKey: [collection, 'title-suggestions', titleFilters],
    enabled: ready && titleFilters.length > 0,
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({
        page: '1',
        size: '100',
        filters: JSON.stringify(titleFilters),
        sortBy: 'title',
        direction: 'asc',
      })
      return fetchApiData(
        apiBaseUrl,
        `/api/v1/${collection}?${params}`,
        SubscriptionItemPageSchema,
        { signal },
      )
    },
  })
  const titlesLoading =
    Boolean(draft.trim()) &&
    (facets.isDebouncing ||
      facets.isPending ||
      (titleFilters.length > 0 && titleMatches.isPending))
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
      if (event.key === 'Escape') {
        if (selectedId && !document.querySelector('dialog[open]')) {
          event.preventDefault()
          closeDetail()
        }
        return
      }
      if (
        !selectedId ||
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
        target !== inspector.current
      )
        return
      const current = slots.findIndex(({ item }) => item?.id === selectedId)
      const next = slots[current + (event.key === 'ArrowDown' ? 1 : -1)]?.item
      if (current < 0 || !next) return
      event.preventDefault()
      setParams({ item: next.id })
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  })
  const widthFor = (field: BrowseField) =>
    widths[field.key] ??
    (field.key === 'title'
      ? 340
      : field.key === 'source'
        ? 200
        : field.key === 'genre'
          ? 220
          : field.type === 'text'
            ? 100
            : 110)

  function cellText(item: SubscriptionItem, field: BrowseField) {
    if (field.key === 'publishedAt')
      return formatSubscriptionPublished(
        item.publishedAt,
        item.publishedPrecision,
      )
    if (field.key === 'durationSec') return formatSubscriptionDuration(item)
    return formatBrowseValue(
      field,
      getSubscriptionBrowseValues(item)[field.key],
    )
  }

  function renderValue(item: SubscriptionItem, field: BrowseField) {
    if (field.key === 'title')
      return (
        <button
          type="button"
          className="table-title"
          onClick={(event) => openDetail(item.id, event.currentTarget)}
        >
          {item.title}
        </button>
      )
    const value = getSubscriptionBrowseValues(item)[field.key]
    if (field.type === 'text' && field.filterable) {
      const values = Array.isArray(value)
        ? value
        : typeof value === 'string'
          ? [value]
          : []
      if (!values.length) return '-'
      return (
        <span className="inline-values">
          {values.map((value) => (
            <FilterButton
              key={value}
              onClick={() => addFilter({ field: field.key, value })}
              title={`Filter ${field.label}: ${value}`}
            >
              {value}
            </FilterButton>
          ))}
        </span>
      )
    }
    return cellText(item, field)
  }

  const showFieldsChip = Boolean(q) && state.fields === 'title'
  const activeFilterCount =
    Number(Boolean(q)) + Number(showFieldsChip) + filters.length + ranges.length
  const activeFilters =
    activeFilterCount > 0 ? (
      <div className="active-filters">
        {q && (
          <FilterButton
            className="filter-pill"
            onClick={() => setParams({ q: null })}
          >
            Search: {q} <X size={12} />
          </FilterButton>
        )}
        {showFieldsChip && (
          <FilterButton
            className="filter-pill"
            onClick={() => setParams({ fields: null })}
          >
            Titles only <X size={12} />
          </FilterButton>
        )}
        <BrowseFilterChips
          filters={filters}
          fields={fields}
          onChange={changeFilters}
        />
        {ranges.map((range) => (
          <FilterButton
            key={range.field}
            className="filter-pill"
            onClick={() =>
              setParams({
                ranges: JSON.stringify(
                  ranges.filter((item) => item.field !== range.field),
                ),
              })
            }
          >
            {subscriptionRangeLabel(range, fields)} <X size={12} />
          </FilterButton>
        ))}
        <button className="clear-filters" onClick={clearFilters}>
          Clear all
        </button>
      </div>
    ) : null

  const empty = !query.isPending && !query.isError && total === 0
  return (
    <section
      className={`media-browser ${styles.browser}`}
      aria-label="Subscriptions"
    >
      <div className="browse-main">
        <div className="browse-toolbar">
          <AiSearch
            target={subscriptionAiSearchTarget}
            queryIdentity={identity}
            autocomplete={{
              items: titleItems,
              titlesLoading,
              titlesError:
                facets.isError ||
                (titleFilters.length > 0 && titleMatches.isError),
              onOpenItem: openDetail,
              options,
              placeholder: 'Search titles, channels, podcasts, tags...',
              value: draft,
              onValueChange: setDraft,
              onAddFilter: addFilter,
              onApplyText: (value) => {
                setParams({ q: value.slice(0, 200) || null, item: null })
                setDraft('')
              },
            }}
            onApply={(plan) => {
              setParams(aiSubscriptionSearchParams(plan))
              setDraft('')
            }}
          />
          <div className="browse-controls">
            <select
              aria-label="Sort by"
              value={sortBy}
              onChange={(event) => sort(event.target.value)}
            >
              {subscriptionSortOptions(q).map((option) => (
                <option key={option} value={option}>
                  {subscriptionSortLabels[option]}
                </option>
              ))}
            </select>
            {sortBy !== 'relevance' && (
              <Button
                variant="ghost"
                className="icon-button"
                aria-label={
                  direction === 'desc' ? 'Sort ascending' : 'Sort descending'
                }
                onClick={() =>
                  setParams({
                    sortBy,
                    direction: direction === 'asc' ? 'desc' : 'asc',
                  })
                }
              >
                {direction === 'desc' ? (
                  <ArrowDown size={16} />
                ) : (
                  <ArrowUp size={16} />
                )}
              </Button>
            )}
            <BrowseFilterPanel count={activeFilterCount}>
              {activeFilters && (
                <section
                  className="filter-panel-active"
                  aria-label="Active filters"
                >
                  <h3>Active filters</h3>
                  {activeFilters}
                </section>
              )}
              <FilterPanelSection
                title="Search"
                icon={<Search size={16} />}
                count={state.fields === 'title' ? 1 : 0}
              >
                <fieldset className="filter-panel-fields">
                  <legend className="sr-only">Search in</legend>
                  {searchFieldOptions.map(({ value, label }) => (
                    <label className="check-label" key={value}>
                      <input
                        type="radio"
                        name="subscription-search-fields"
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
              {view === 'list' && (
                <FilterPanelSection
                  title="Columns"
                  icon={<Columns3 size={16} />}
                >
                  <div className="filter-panel-columns">
                    {columnFields.map((field) => (
                      <label className="check-label" key={field.key}>
                        <input
                          type="checkbox"
                          checked={columnKeys.includes(field.key)}
                          disabled={field.key === 'title'}
                          onChange={() =>
                            setParams({
                              columns: (columnKeys.includes(field.key)
                                ? columnKeys.filter((key) => key !== field.key)
                                : [...columnKeys, field.key]
                              ).join(','),
                            })
                          }
                        />
                        {field.label}
                      </label>
                    ))}
                  </div>
                </FilterPanelSection>
              )}
            </BrowseFilterPanel>
            <div className="view-switch">
              <Button
                variant={view === 'grid' ? 'default' : 'ghost'}
                aria-label="Grid view"
                aria-pressed={view === 'grid'}
                onClick={() => setParams({ view: null })}
              >
                <Grid2X2 size={16} />
              </Button>
              <Button
                variant={view === 'list' ? 'default' : 'ghost'}
                aria-label="List view"
                aria-pressed={view === 'list'}
                onClick={() => setParams({ view: 'list' })}
              >
                <Rows3 size={16} />
              </Button>
            </div>
            <span className="browse-count" aria-live="polite">
              {query.isPending
                ? 'Loading...'
                : `${total.toLocaleString()} ${total === 1 ? 'item' : 'items'}`}
            </span>
          </div>
        </div>
        {railSlot && activeFilters
          ? createPortal(
              <>
                <h2 className="rail-heading">Filters</h2>
                {activeFilters}
              </>,
              railSlot,
            )
          : activeFilters}
        <TableScroll
          className="browse-scroll"
          data-view={view}
          ref={scroller}
          role="region"
          aria-label={`Subscriptions ${view}`}
          onScroll={(event) =>
            setScroll({
              identity: scrollIdentity,
              top: event.currentTarget.scrollTop,
            })
          }
        >
          {query.isError && (
            <div className="virtual-browse-error">
              <div role="alert" className="virtual-browse-error-message">
                Could not load this section.{' '}
                <Button onClick={query.retry}>Retry</Button>
              </div>
            </div>
          )}
          <span className="sr-only" role="status">
            {query.isFetching ? 'Loading items' : ''}
          </span>
          {empty &&
            (hasSubscriptionFilters(state) ? (
              <div className="browse-empty">
                No matches.{' '}
                <button onClick={clearFilters}>Clear filters</button>
              </div>
            ) : (
              <div className="browse-empty">
                Nothing synced yet. Sync channels and podcasts in{' '}
                <Link className="underline" href={subscriptionImportsHref}>
                  Imports
                </Link>
                .
              </div>
            ))}
          {view === 'grid' ? (
            <div
              className="virtual-browse-grid"
              style={{ height: Math.max(0, query.height - grid.gap) }}
            >
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: `repeat(${grid.columns}, minmax(0, 1fr))`,
                  gap: grid.gap,
                  gridAutoRows: grid.cardHeight,
                  position: 'absolute',
                  top: padTop,
                  left: 0,
                  right: 0,
                }}
              >
                {slots.map(({ item, index }) =>
                  item ? (
                    <SubscriptionCard
                      key={item.id}
                      item={item}
                      index={index}
                      height={grid.cardHeight}
                      selected={item.id === selectedId}
                      onOpen={(trigger) => openDetail(item.id, trigger)}
                      onFilter={addFilter}
                    />
                  ) : (
                    <div
                      key={`slot-${index}`}
                      className="virtual-browse-placeholder"
                      aria-hidden="true"
                      style={{ height: grid.cardHeight }}
                    >
                      <div
                        className={`${styles.thumb} virtual-browse-shimmer`}
                      />
                      <div className={styles.placeholderBody}>
                        <div className="virtual-browse-line virtual-browse-shimmer" />
                        <div className="virtual-browse-line virtual-browse-line-short virtual-browse-shimmer" />
                      </div>
                    </div>
                  ),
                )}
              </div>
            </div>
          ) : (
            <table
              className={`compact-table ${styles.table}`}
              aria-label="Subscriptions"
              aria-rowcount={total + 1}
              style={{
                width: columns.reduce(
                  (sum, field) => sum + widthFor(field),
                  thumbColumnWidth,
                ),
              }}
            >
              <colgroup>
                <col style={{ width: thumbColumnWidth }} />
                {columns.map((field) => (
                  <col key={field.key} style={{ width: widthFor(field) }} />
                ))}
              </colgroup>
              <TableHeader>
                <TableRow>
                  <TableHead>
                    <span className="sr-only">Open</span>
                  </TableHead>
                  {columns.map((field) => {
                    const sortable = isSubscriptionSort(field.key)
                    return (
                      <TableHead
                        key={field.key}
                        className={field.type === 'text' ? '' : 'numeric'}
                        aria-sort={
                          sortBy === field.key
                            ? direction === 'asc'
                              ? 'ascending'
                              : 'descending'
                            : 'none'
                        }
                      >
                        {sortable ? (
                          <button type="button" onClick={() => sort(field.key)}>
                            {field.label}
                            {sortBy === field.key
                              ? direction === 'asc'
                                ? ' ↑'
                                : ' ↓'
                              : ''}
                          </button>
                        ) : (
                          field.label
                        )}
                        <span
                          className="column-resizer"
                          role="separator"
                          aria-label={`Resize ${field.label}`}
                          aria-orientation="vertical"
                          tabIndex={0}
                          onKeyDown={(event) => {
                            if (
                              event.key === 'ArrowLeft' ||
                              event.key === 'ArrowRight'
                            ) {
                              event.preventDefault()
                              saveWidths({
                                ...widths,
                                [field.key]: Math.max(
                                  70,
                                  Math.min(
                                    650,
                                    widthFor(field) +
                                      (event.key === 'ArrowRight' ? 10 : -10),
                                  ),
                                ),
                              })
                            }
                          }}
                          onPointerDown={(event) => {
                            event.currentTarget.setPointerCapture(
                              event.pointerId,
                            )
                            resize.current = {
                              key: field.key,
                              x: event.clientX,
                              width: widthFor(field),
                            }
                          }}
                          onPointerMove={(event) => {
                            if (resize.current?.key === field.key)
                              setWidths({
                                ...widths,
                                [field.key]: Math.max(
                                  70,
                                  Math.min(
                                    650,
                                    resize.current.width +
                                      event.clientX -
                                      resize.current.x,
                                  ),
                                ),
                              })
                          }}
                          onPointerUp={() => {
                            resize.current = null
                            saveWidths(widths)
                          }}
                        />
                      </TableHead>
                    )
                  })}
                </TableRow>
              </TableHeader>
              <TableBody>
                {padTop > 0 && (
                  <TableRow aria-hidden="true">
                    <TableCell
                      colSpan={columns.length + 1}
                      style={{ height: padTop, padding: 0, border: 0 }}
                    />
                  </TableRow>
                )}
                {slots.map(({ item, index }) =>
                  item ? (
                    <TableRow
                      key={item.id}
                      data-item-index={index}
                      data-selected={item.id === selectedId}
                      aria-rowindex={index + 2}
                      onDoubleClick={(event) => {
                        if (
                          event.target instanceof Element &&
                          event.target.closest(
                            'a, button, input, select, textarea',
                          )
                        )
                          return
                        openDetail(
                          item.id,
                          event.currentTarget.querySelector<HTMLElement>(
                            '.table-title',
                          ) ?? undefined,
                        )
                      }}
                    >
                      <TableCell>
                        <a
                          className={styles.rowThumb}
                          href={item.url}
                          target="_blank"
                          rel="noreferrer"
                          aria-label={`${subscriptionOpenLabel(item.type)}: ${item.title} (opens in a new tab)`}
                        >
                          <SubscriptionThumbnail item={item} badges={false} />
                        </a>
                      </TableCell>
                      {columns.map((field) => (
                        <TableCell
                          key={field.key}
                          className={field.type === 'text' ? '' : 'numeric'}
                          title={cellText(item, field)}
                        >
                          <div className="browse-cell">
                            {renderValue(item, field)}
                          </div>
                        </TableCell>
                      ))}
                    </TableRow>
                  ) : (
                    <TableRow
                      key={`slot-${index}`}
                      aria-hidden="true"
                      className="virtual-browse-placeholder"
                    >
                      <TableCell>
                        <div className={styles.placeholderCell}>
                          <div
                            className={`${styles.thumb} virtual-browse-shimmer`}
                            style={{ width: 50 }}
                          />
                        </div>
                      </TableCell>
                      {columns.map((field) => (
                        <TableCell key={field.key}>
                          <div className={styles.placeholderCell}>
                            <div className="virtual-browse-line virtual-browse-shimmer" />
                          </div>
                        </TableCell>
                      ))}
                    </TableRow>
                  ),
                )}
                {padBottom > 0 && (
                  <TableRow aria-hidden="true">
                    <TableCell
                      colSpan={columns.length + 1}
                      style={{ height: padBottom, padding: 0, border: 0 }}
                    />
                  </TableRow>
                )}
              </TableBody>
            </table>
          )}
        </TableScroll>
      </div>
      {selectedId && (
        <SubscriptionItemDetails
          key={selectedId}
          ref={inspector}
          item={selectedItem}
          error={
            !selectedItem && itemQuery.isError
              ? errorMessage(itemQuery.error, 'Could not load this item.')
              : null
          }
          onRetry={() => itemQuery.refetch()}
          onClose={closeDetail}
          onFilter={addFilter}
        />
      )}
    </section>
  )
}

function SubscriptionCard({
  item,
  index,
  height,
  selected,
  onOpen,
  onFilter,
}: {
  item: SubscriptionItem
  index: number
  height: number
  selected: boolean
  onOpen: (trigger: HTMLElement) => void
  onFilter: (filter: BrowseFilter) => void
}) {
  const published = formatSubscriptionPublished(
    item.publishedAt,
    item.publishedPrecision,
  )
  const meta =
    item.type === 'youtube'
      ? `${item.viewCount === null ? 'Views hidden' : `${formatCompactSubscriptionCount(item.viewCount)} views`} · ${published}`
      : `${subscriptionTypeLabels[item.type]} · ${published}`
  return (
    <article
      className={styles.card}
      data-item-index={index}
      data-selected={selected}
      style={{ height }}
    >
      <button
        type="button"
        className={styles.cardThumb}
        tabIndex={-1}
        aria-hidden="true"
        onClick={(event) => onOpen(event.currentTarget)}
      >
        <SubscriptionThumbnail item={item} />
      </button>
      <div className={styles.cardBody}>
        <SourceAvatar src={item.sourceThumbnailUrl} />
        <div className="min-w-0">
          <button
            type="button"
            className={styles.title}
            title={item.title}
            onClick={(event) => onOpen(event.currentTarget)}
          >
            {item.title}
          </button>
          <FilterButton
            className={styles.channel}
            title={`Filter Channel: ${item.sourceTitle}`}
            onClick={() =>
              onFilter({ field: 'source', value: item.sourceTitle })
            }
          >
            {item.sourceTitle}
          </FilterButton>
          <div className={styles.meta}>{meta}</div>
        </div>
        <a
          className={styles.openLink}
          href={item.url}
          target="_blank"
          rel="noreferrer"
          aria-label={`${subscriptionOpenLabel(item.type)}: ${item.title} (opens in a new tab)`}
          title={subscriptionOpenLabel(item.type)}
        >
          <ArrowUpRight size={15} />
        </a>
      </div>
    </article>
  )
}
