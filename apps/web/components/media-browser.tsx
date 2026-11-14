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
  Columns3,
  Grid2X2,
  ListMusic,
  Settings2,
  Rows3,
  Table2,
  X,
} from 'lucide-react'
import { Button } from '@repo/ui/components/ui/button'
import { SavedViewSchema } from '@repo/schemas/imports'
import {
  ListeningFilterParamSchema,
  ListeningPeriodParamSchema,
  defaultListeningPeriod,
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
  sameBrowseFilter,
  type BrowseField,
  type BrowseFilter,
} from '@repo/schemas/browse'
import { useConfig } from './providers'
import { fetchApiData } from '@/utils/api'
import { useVirtualBrowse } from '@/hooks/useVirtualBrowse'
import { useBrowseFacets } from '@/hooks/useBrowseFacets'
import AiSearch from './ai-search'
import { aiSearchParams, mediaAiSearchTarget } from '@/utils/ai-search'
import MediaArtwork from './media-artwork'
import MediaDetail from './media-detail'
import { TilePlayControls } from './play-controls'
import ManualMediaAdd from './manual-media-add'
import { BrowseFilterChips, RangeEditor } from './browse-controls'
import { ListeningControls } from './listening-controls'
import BrowseFilterPanel, { FilterPanelSection } from './browse-filter-panel'
import {
  formatListeningPeriod,
  formatListeningRule,
} from '@/utils/listening-filters'
import ServiceLinks from './service-icon-links'
import AlbumTitle from './album-title'
import { albumSpotifyDestination } from '@/utils/album-links'
import {
  artworkOverlays,
  formatArtworkOverlays,
  mediaGridGeometry,
  parseArtworkOverlays,
  parseBrowseView,
  parseGridDensity,
  preserveGridScroll,
} from '@/utils/media-grid'
import { useRailSlot } from '@/hooks/useRailSlot'
import styles from './media-browser.module.css'
import { FilterButton } from './filter-affordance'
import ProviderRatings from './provider-ratings'
import {
  compactRatingStripWidth,
  getDetailProviderLinks,
  isCompactRating,
} from '@/utils/provider-ratings'
import {
  matchingTitleFilters,
  titleSuggestions,
} from '@/utils/browse-suggestions'

const PageSchema = PaginatedDataSchema(
  z.union([AlbumListItemSchema, FilmListItemSchema]),
)
const WidthsSchema = z.record(z.string(), z.number().min(70).max(650))
const defaultAlbumColumns = [
  'title',
  'artist',
  'releaseDate',
  'dateAdded',
  'genre',
  'ratingRymValue',
  'scrobbles',
  'links',
]
const defaultFilmColumns = [
  'title',
  'director',
  'releaseDate',
  'dateAdded',
  'genre',
  'source',
  'watched',
  'links',
]

const overlayLabels = { ratings: 'Ratings', sort: 'Sort value', tags: 'Tags' }
const visibleTileTags = 3

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

export default function MediaBrowser({
  mediaType,
}: {
  mediaType: 'album' | 'film'
}) {
  const collection = mediaType === 'album' ? 'albums' : 'films'
  const { apiBaseUrl } = useConfig()
  const searchParams = useSearchParams()
  const [ready, setReady] = useState(false)
  const [draft, setDraft] = useState('')
  const [adding, setAdding] = useState(false)
  const [scroll, setScroll] = useState({ identity: '', top: 0 })
  const [gridLayout, setGridLayout] = useState<{
    identity: string
    columns: number
    rowHeight: number
  } | null>(null)
  const [viewport, setViewport] = useState({ width: 1000, height: 800 })
  const [widths, setWidths] = useState<Record<string, number>>({})
  const scroller = useRef<HTMLDivElement>(null)
  const browser = useRef<HTMLElement>(null)
  const inspector = useRef<HTMLElement>(null)
  const railSlot = useRailSlot()
  const openedHere = useRef(false)
  const detailTrigger = useRef<HTMLElement | null>(null)
  const resize = useRef<{ key: string; x: number; width: number } | null>(null)
  const filters = parseFilters(searchParams.get('filters'))
  const rangesResult = BrowseRangesParamSchema.safeParse(
    searchParams.get('ranges'),
  )
  const ranges = rangesResult.success ? rangesResult.data : []
  const listeningResult = ListeningFilterParamSchema.safeParse(
    searchParams.get('listening'),
  )
  const listening =
    mediaType === 'album' && listeningResult.success
      ? listeningResult.data
      : undefined
  const listeningSortResult = ListeningPeriodParamSchema.safeParse(
    searchParams.get('listeningSort'),
  )
  const listeningSort =
    mediaType === 'album' && listeningSortResult.success
      ? listeningSortResult.data
      : undefined
  const listeningPeriod = listeningSort ?? defaultListeningPeriod
  const q = searchParams.get('q') ?? ''
  const includeArchived = searchParams.get('includeArchived') === 'true'
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
  const view = parseBrowseView(searchParams.get('view'))
  const overlays = parseArtworkOverlays(searchParams.get('overlays'), mediaType)
  const density = parseGridDensity(searchParams.get('density'))
  const selectedId = searchParams.get('item')
  const detailParams = new URLSearchParams(searchParams)
  detailParams.delete('item')
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
      ? [
          ...baseFields,
          {
            key: 'listeningScrobbles',
            label: `Scrobbles, ${formatListeningPeriod(listeningPeriod)}`,
            type: 'number',
            filterable: false,
          },
        ]
      : baseFields
  const columnKeys =
    searchParams.get('columns')?.split(',').map(canonicalBrowseKey) ??
    (mediaType === 'album' ? defaultAlbumColumns : defaultFilmColumns)
  const columns = fields.filter((field) => columnKeys.includes(field.key))
  const sortField = fields.find((field) => field.key === sortBy)
  const requestedListeningPeriod =
    mediaType === 'album' &&
    (sortBy === 'listeningScrobbles' ||
      columnKeys.includes('listeningScrobbles'))
      ? listeningPeriod
      : undefined
  const queryKey = JSON.stringify({
    q,
    filters,
    ranges,
    sortBy,
    direction,
    includeArchived,
    limitResults,
    listening,
    listeningSort: requestedListeningPeriod,
  })
  // With both overlays on, the sort value and links sit on the artwork.
  const tileExtraRow =
    !overlays.includes('sort') || !overlays.includes('ratings')
  const grid = mediaGridGeometry({
    width: viewport.width,
    mediaType,
    density,
    extraRow: tileExtraRow,
  })
  const scrollIdentity = `${collection}:${queryKey}:${view}`
  const previousScrollTop = scroll.identity === scrollIdentity ? scroll.top : 0
  const scrollTop =
    view === 'grid' && gridLayout?.identity === scrollIdentity
      ? preserveGridScroll(previousScrollTop, gridLayout, grid)
      : previousScrollTop

  function setParams(updates: Record<string, string | null>, push = false) {
    const params = new URLSearchParams(window.location.search)
    for (const [key, value] of Object.entries(updates)) {
      if (value === null || value === '') params.delete(key)
      else params.set(key, value)
    }
    if (Object.keys(updates).some((key) => key !== 'item'))
      params.delete('page')
    const url = `/${collection}${params.size ? `?${params}` : ''}`
    if (push) window.history.pushState(null, '', url)
    else window.history.replaceState(null, '', url)
    const saved = new URLSearchParams(params)
    saved.delete('item')
    try {
      window.localStorage.setItem(`browse:${collection}`, saved.toString())
    } catch {
      /* URL state still works when browser storage is unavailable. */
    }
  }
  function addFilter(filter: BrowseFilter, keepOpen = false) {
    const next = filters.some((item) => sameBrowseFilter(item, filter))
      ? filters
      : [...filters, filter]
    // Closing must not navigate back to the filter state from before the modal opened.
    if (keepOpen && next !== filters) openedHere.current = false
    setParams({
      filters: JSON.stringify(next),
      ...(keepOpen ? {} : { item: null }),
    })
  }
  function changeFilters(next: BrowseFilter[]) {
    if (selectedId) openedHere.current = false
    setParams({ filters: next.length ? JSON.stringify(next) : null })
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
        window.history.replaceState(null, '', `/${collection}?${saved}`)
      const parsed = WidthsSchema.safeParse(
        JSON.parse(window.localStorage.getItem(`widths:${collection}`) ?? '{}'),
      )
      if (parsed.success) setWidths(parsed.data)
    } catch {
      /* Ignore unavailable storage or malformed saved preferences. */
    }
    setReady(true)
  }, [collection])
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

  const gridColumns = grid.columns
  const rowHeight =
    view === 'table'
      ? 36
      : view === 'list'
        ? grid.mobile
          ? 52
          : 44
        : grid.rowHeight
  const params = new URLSearchParams({
    q,
    filters: JSON.stringify(filters),
    ranges: JSON.stringify(ranges),
    sortBy,
    direction,
  })
  if (includeArchived) params.set('includeArchived', 'true')
  if (limitResults) params.set('limitResults', limitResults)
  if (listening) params.set('listening', JSON.stringify(listening))
  if (requestedListeningPeriod)
    params.set('listeningSort', JSON.stringify(requestedListeningPeriod))
  const query = useVirtualBrowse({
    apiBaseUrl,
    collection,
    identity: queryKey,
    params,
    enabled: ready,
    columns: view === 'grid' ? gridColumns : 1,
    rowHeight,
    scrollTop,
    viewportHeight: viewport.height,
    headerHeight: view === 'table' ? 34 : 0,
  })
  const { total, slots, padTop, padBottom } = query
  const selectedItem = slots.find(({ item }) => item?.id === selectedId)?.item
  const selectedListeningCount =
    selectedItem?.mediaType === 'album'
      ? selectedItem.listeningScrobbles
      : undefined
  const facets = useBrowseFacets(apiBaseUrl, collection, draft, ready)
  const titleFilters = matchingTitleFilters(facets.data ?? [], facets.search)
  const titleMatches = useQuery({
    queryKey: [collection, 'title-suggestions', titleFilters, includeArchived],
    enabled: ready && titleFilters.length > 0,
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({
        page: '1',
        size: '100',
        filters: JSON.stringify(titleFilters),
        sortBy: 'title',
        direction: 'asc',
        includeArchived: String(includeArchived),
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
    Boolean(draft.trim()) &&
    (facets.isDebouncing ||
      facets.isPending ||
      (titleFilters.length > 0 && titleMatches.isPending))
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
          '.toolbar-popover[open]',
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
        } else if (selectedId && !document.querySelector('dialog[open]')) {
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
      // Arrow keys keep their usual meaning inside forms, tabs and the detail body.
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
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  })
  const columnCount =
    columns.length + 1 + (columnKeys.includes('links') ? 1 : 0)
  const ratingsWidth = compactRatingStripWidth(fields)
  const widthFor = (field: BrowseField) =>
    widths[field.key] ??
    (field.key === 'title' ? 260 : field.type === 'text' ? 180 : 115)

  function renderValue(item: AlbumListItem | FilmListItem, field: BrowseField) {
    const values = getBrowseValues(item)
    const value = values[field.key]
    if (field.type === 'text' && field.filterable && field.key !== 'title') {
      const values = Array.isArray(value)
        ? value
        : typeof value === 'string'
          ? [value]
          : []
      return (
        <span className="inline-values">
          {values.map((value) => (
            <FilterButton
              type="button"
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
    return formatBrowseValue(field, value)
  }

  const sortRating =
    sortField?.rating && isCompactRating({ display: sortField.rating })
      ? sortField.key
      : undefined
  const showsSortValue =
    sortField !== undefined &&
    sortRating === undefined &&
    !['title', 'artist', 'director', 'releaseDate'].includes(sortBy)
  function sortValue(item: AlbumListItem | FilmListItem, className?: string) {
    if (!sortField || !showsSortValue) return null
    return (
      <span
        className={className}
        title={sortBy === 'dateAdded' ? item.dateAddedSource : sortField.label}
      >
        {sortBy === 'dateAdded' ? 'Added ' : ''}
        {formatBrowseValue(sortField, getBrowseValues(item)[sortBy])}
      </span>
    )
  }
  function itemRatings(item: AlbumListItem | FilmListItem) {
    return getDetailProviderLinks(
      fields,
      getBrowseValues(item),
      item.links,
      undefined,
      item.providerReferences,
    )
  }
  function titleControl(item: AlbumListItem | FilmListItem, className: string) {
    return item.mediaType === 'album' ? (
      <AlbumTitle
        item={item}
        className={className}
        onOpenDetails={(event) => openDetail(item.id, event.currentTarget)}
      />
    ) : (
      <button
        className={className}
        onClick={(event) => openDetail(item.id, event.currentTarget)}
        title={item.title}
      >
        {item.title}
        {filmIdentificationStatus(item.providerReferences) === 'Needs ID' && (
          <span className="needs-id">Needs ID</span>
        )}
      </button>
    )
  }
  function creatorButtons(item: AlbumListItem | FilmListItem) {
    const creatorField = item.mediaType === 'album' ? 'artist' : 'director'
    const creator = getBrowseValues(item)[creatorField]
    return (Array.isArray(creator) ? creator : []).map((name) => (
      <FilterButton
        key={name}
        title={`Filter ${creatorField}: ${name}`}
        onClick={() => addFilter({ field: creatorField, value: name })}
      >
        {name}
      </FilterButton>
    ))
  }
  const activeFilterCount =
    Number(Boolean(q)) +
    filters.length +
    ranges.length +
    (listening?.rules.length ?? 0) +
    Number(Boolean(limitResults))
  const hasActiveFilters = activeFilterCount > 0
  const activeFilters = hasActiveFilters ? (
    <div className="active-filters">
      {limitResults && (
        <FilterButton
          className="filter-pill"
          onClick={() => setParams({ limitResults: null })}
        >
          Top {limitResults} <X size={12} />
        </FilterButton>
      )}
      {q && (
        <FilterButton
          className="filter-pill"
          onClick={() => setParams({ q: null })}
        >
          Search: {q} <X size={12} />
        </FilterButton>
      )}
      <BrowseFilterChips
        filters={filters}
        fields={fields}
        onChange={changeFilters}
      />
      {ranges.map((range) => {
        const field = fields.find((field) => field.key === range.field)
        const bound = (value: number | undefined) =>
          value === undefined
            ? '*'
            : field?.type === 'date'
              ? formatBrowseValue(field, value)
              : value
        return (
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
            {field?.label}: {bound(range.min)} to {bound(range.max)}
            {range.includeMissing ? ' + missing' : ''} <X size={12} />
          </FilterButton>
        )
      })}
      {listening?.rules.map((rule, index) => (
        <FilterButton
          key={`listening:${index}`}
          className="filter-pill"
          aria-label={`Remove listening rule: ${formatListeningRule(rule)}`}
          onClick={() => {
            const rules = listening.rules.filter((_, i) => i !== index)
            setParams({
              listening: rules.length
                ? JSON.stringify({ ...listening, rules })
                : null,
            })
          }}
        >
          {listening.match === 'all' ? 'Required' : 'Any'} ·{' '}
          {formatListeningRule(rule)} <X size={12} />
        </FilterButton>
      ))}
      <button
        className="clear-filters"
        onClick={() =>
          setParams({
            q: null,
            filters: null,
            ranges: null,
            limitResults: null,
            listening: null,
          })
        }
      >
        Clear all
      </button>
    </div>
  ) : null

  return (
    <section
      className={`media-browser ${styles.browser}`}
      aria-label={collection}
      ref={browser}
    >
      <div className="browse-main">
        <div className="browse-toolbar">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setAdding(true)}
          >
            Add {mediaType}
          </Button>
          {mediaType === 'film' && (
            <Link className="browse-refresh" href="/jobs?refresh=films">
              Refresh
            </Link>
          )}
          <AiSearch
            key={mediaType}
            target={mediaAiSearchTarget(mediaType, fields)}
            queryIdentity={queryKey}
            autocomplete={{
              items: titleItems,
              titlesLoading,
              titlesError:
                facets.isError ||
                (titleFilters.length > 0 && titleMatches.isError),
              onOpenItem: openDetail,
              options,
              placeholder: 'Search titles, people, tags, sources...',
              value: draft,
              onValueChange: setDraft,
              onAddFilter: addFilter,
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
          <div className="browse-controls">
            <select
              aria-label="Sort by"
              value={sortBy}
              onChange={(event) => sort(event.target.value)}
            >
              {fields.map((field) => (
                <option key={field.key} value={field.key}>
                  {field.label}
                </option>
              ))}
            </select>
            <Button
              variant="ghost"
              className="icon-button"
              aria-label={
                direction === 'desc' ? 'Sort ascending' : 'Sort descending'
              }
              onClick={() =>
                setParams({ direction: direction === 'asc' ? 'desc' : 'asc' })
              }
            >
              {direction === 'desc' ? (
                <ArrowDown size={16} />
              ) : (
                <ArrowUp size={16} />
              )}
            </Button>
            <BrowseFilterPanel count={activeFilterCount}>
              {hasActiveFilters && (
                <section
                  className="filter-panel-active"
                  aria-label="Active filters"
                >
                  <h3>Active filters</h3>
                  {activeFilters}
                </section>
              )}
              <FilterPanelSection
                title="Views"
                icon={<Settings2 size={16} />}
                defaultOpen
              >
                <div className="filter-panel-fields">
                  {view === 'grid' && (
                    <label>
                      Grid density
                      <select
                        aria-label="Grid density"
                        value={density}
                        onChange={(event) =>
                          setParams({
                            density: parseGridDensity(event.target.value),
                          })
                        }
                      >
                        <option value="compact">Compact</option>
                        <option value="standard">Standard</option>
                        <option value="roomy">Roomy</option>
                      </select>
                    </label>
                  )}
                  {view === 'grid' && (
                    <fieldset className="overlay-options">
                      <legend>On artwork</legend>
                      {artworkOverlays.map((overlay) => (
                        <label className="check-label" key={overlay}>
                          <input
                            type="checkbox"
                            checked={overlays.includes(overlay)}
                            onChange={(event) =>
                              setParams({
                                overlays: formatArtworkOverlays(
                                  artworkOverlays.filter((key) =>
                                    key === overlay
                                      ? event.target.checked
                                      : overlays.includes(key),
                                  ),
                                ),
                              })
                            }
                          />
                          {overlayLabels[overlay]}
                        </label>
                      ))}
                    </fieldset>
                  )}
                  <label className="check-label">
                    <input
                      type="checkbox"
                      checked={includeArchived}
                      onChange={(event) =>
                        setParams({
                          includeArchived: event.target.checked ? 'true' : null,
                        })
                      }
                    />
                    Include archived imports
                  </label>
                </div>
              </FilterPanelSection>
              {mediaType === 'album' && (
                <FilterPanelSection
                  title="Smart playlists"
                  icon={<ListMusic size={16} />}
                >
                  <label>
                    Saved view
                    <select
                      aria-label="Smart playlist"
                      value=""
                      onChange={(event) => {
                        const view = savedViews.data?.find(
                          (view) => view.name === event.target.value,
                        )
                        if (view)
                          setParams({
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
                    </select>
                  </label>
                  {savedViews.isError && (
                    <p role="alert">
                      Saved views unavailable.{' '}
                      <button onClick={() => savedViews.refetch()}>
                        Retry
                      </button>
                    </p>
                  )}
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
                  presentation="panel"
                  filter={listening}
                  sortPeriod={listeningSort}
                  sorting={sortBy === 'listeningScrobbles'}
                  onFilterChange={(filter) =>
                    setParams({
                      listening: filter ? JSON.stringify(filter) : null,
                    })
                  }
                  onSortChange={(period) =>
                    setParams({
                      sortBy: 'listeningScrobbles',
                      listeningSort: JSON.stringify(period),
                    })
                  }
                />
              )}
              {view === 'table' && (
                <FilterPanelSection
                  title="Columns"
                  icon={<Columns3 size={16} />}
                >
                  <div className="filter-panel-columns">
                    {[...fields, { key: 'links', label: 'Links' }].map(
                      (field) => (
                        <label className="check-label" key={field.key}>
                          <input
                            type="checkbox"
                            checked={columnKeys.includes(field.key)}
                            disabled={field.key === 'title'}
                            onChange={() =>
                              setParams({
                                columns: (columnKeys.includes(field.key)
                                  ? columnKeys.filter(
                                      (key) => key !== field.key,
                                    )
                                  : [...columnKeys, field.key]
                                ).join(','),
                              })
                            }
                          />
                          {field.label}
                        </label>
                      ),
                    )}
                  </div>
                </FilterPanelSection>
              )}
            </BrowseFilterPanel>
            <div className="view-switch">
              <Button
                variant={view === 'grid' ? 'default' : 'ghost'}
                aria-label="Grid view"
                aria-pressed={view === 'grid'}
                onClick={() => setParams({ view: 'grid' })}
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
              <Button
                variant={view === 'table' ? 'default' : 'ghost'}
                aria-label="Table view"
                aria-pressed={view === 'table'}
                onClick={() => setParams({ view: 'table' })}
              >
                <Table2 size={16} />
              </Button>
            </div>
            <span className="browse-count" aria-live="polite">
              {query.isPending
                ? 'Loading...'
                : `${total.toLocaleString()} ${collection}`}
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
        <div
          className="browse-scroll"
          data-view={view}
          ref={scroller}
          tabIndex={0}
          role="region"
          aria-label={`${collection} ${view}`}
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
          {!query.isPending && !query.isError && total === 0 && (
            <div className="browse-empty">
              No matches.{' '}
              <button
                onClick={() =>
                  setParams({
                    q: null,
                    filters: null,
                    ranges: null,
                    limitResults: null,
                  })
                }
              >
                Clear filters
              </button>
            </div>
          )}
          {view === 'grid' ? (
            <div
              className="virtual-browse-grid"
              style={{ height: Math.max(0, query.height - grid.gap) }}
            >
              <div
                className={`media-grid ${mediaType} ${styles.grid}`}
                data-mobile={grid.mobile}
                style={{
                  gridTemplateColumns: `repeat(${gridColumns}, minmax(0, 1fr))`,
                  gap: grid.gap,
                  gridAutoRows: grid.cardHeight,
                  position: 'absolute',
                  top: padTop,
                  left: 0,
                  right: 0,
                }}
              >
                {slots.map(({ item, index }) => {
                  if (!item)
                    return (
                      <div
                        key={`slot-${index}`}
                        className="virtual-browse-placeholder"
                        aria-hidden="true"
                        style={{ height: grid.cardHeight }}
                      >
                        <div
                          className={`virtual-browse-shimmer ${mediaType === 'album' ? 'aspect-square' : 'aspect-[2/3]'}`}
                        />
                        <div className="virtual-browse-line virtual-browse-shimmer" />
                        <div className="virtual-browse-line virtual-browse-line-short virtual-browse-shimmer" />
                      </div>
                    )
                  const values = getBrowseValues(item)
                  const provider = itemRatings(item)
                  const tags = Array.isArray(values.genre) ? values.genre : []
                  const serviceLinks = (
                    <ServiceLinks
                      hideSpotify={
                        item.mediaType === 'album' &&
                        Boolean(albumSpotifyDestination(item))
                      }
                      item={{ ...item, links: provider.links }}
                    />
                  )
                  return (
                    <article
                      className="media-tile"
                      key={item.id}
                      data-item-index={index}
                      data-selected={item.id === selectedId}
                      style={{ height: grid.cardHeight }}
                    >
                      <div className="tile-artwork">
                        <button
                          className="art-button"
                          aria-label={`Open details for ${item.title}`}
                          onClick={(event) =>
                            openDetail(item.id, event.currentTarget)
                          }
                        >
                          <MediaArtwork
                            src={item.artworkUrl}
                            alt={item.title}
                            fallbackLabel={item.title}
                            imageClassName={
                              mediaType === 'album'
                                ? 'aspect-square object-cover w-full'
                                : 'aspect-[2/3] object-cover w-full'
                            }
                            fallbackClassName={`${mediaType === 'album' ? 'aspect-square' : 'aspect-[2/3]'} ${styles.fallback}`}
                          />
                        </button>
                        {overlays.includes('sort') &&
                          sortValue(item, 'tile-sort')}
                        {overlays.includes('tags') && tags.length > 0 && (
                          <div className="tile-tags" title={tags.join(', ')}>
                            {tags.slice(0, visibleTileTags).map((tag) => (
                              <FilterButton
                                key={tag}
                                title={`Filter genre: ${tag}`}
                                onClick={() =>
                                  addFilter({ field: 'genre', value: tag })
                                }
                              >
                                {tag}
                              </FilterButton>
                            ))}
                            {tags.length > visibleTileTags && (
                              <span>+{tags.length - visibleTileTags}</span>
                            )}
                          </div>
                        )}
                        {overlays.includes('ratings') && (
                          <ProviderRatings
                            ratings={provider.ratings}
                            context="poster"
                            highlightKey={
                              overlays.includes('sort') ? sortRating : undefined
                            }
                          >
                            {serviceLinks}
                          </ProviderRatings>
                        )}
                        {item.mediaType === 'album' && (
                          <TilePlayControls album={item} />
                        )}
                      </div>
                      {titleControl(item, 'tile-title')}
                      <div className="tile-byline">
                        <span>{creatorButtons(item)}</span>
                        <span>{item.releaseDate?.slice(0, 4)}</span>
                      </div>
                      {tileExtraRow && (
                        <div className="tile-extra">
                          {!overlays.includes('sort') && sortValue(item)}
                          {!overlays.includes('ratings') && serviceLinks}
                        </div>
                      )}
                    </article>
                  )
                })}
              </div>
            </div>
          ) : view === 'list' ? (
            <div
              className="virtual-browse-grid"
              style={{ height: query.height }}
            >
              <div
                className={`media-list ${mediaType}`}
                data-mobile={grid.mobile}
                style={{ top: padTop }}
              >
                {slots.map(({ item, index }) => {
                  if (!item)
                    return (
                      <div
                        key={`slot-${index}`}
                        className="list-row virtual-browse-placeholder"
                        aria-hidden="true"
                      >
                        <div className="list-thumb virtual-browse-shimmer" />
                        <div className="virtual-browse-line virtual-browse-shimmer" />
                      </div>
                    )
                  const provider = itemRatings(item)
                  return (
                    <article
                      className="list-row"
                      key={item.id}
                      data-item-index={index}
                      data-selected={item.id === selectedId}
                      style={
                        grid.mobile
                          ? undefined
                          : {
                              gridTemplateColumns: `32px minmax(0, 2fr) minmax(0, 1.6fr) ${ratingsWidth}px 132px`,
                            }
                      }
                    >
                      <button
                        className="list-thumb art-button"
                        aria-label={`Open details for ${item.title}`}
                        onClick={(event) =>
                          openDetail(item.id, event.currentTarget)
                        }
                      >
                        <MediaArtwork
                          src={item.artworkUrl}
                          alt=""
                          fallbackLabel=""
                          imageClassName="list-thumb-image"
                          fallbackClassName="list-thumb-image"
                        />
                      </button>
                      <div className="list-title">
                        {titleControl(item, 'table-title')}
                      </div>
                      <div className="list-byline">
                        <span className="inline-values">
                          {creatorButtons(item)}
                        </span>
                        <span className="list-year">
                          {item.releaseDate?.slice(0, 4)}
                        </span>
                        {sortValue(item, 'list-sort')}
                      </div>
                      <ProviderRatings
                        ratings={provider.ratings}
                        context="table"
                        highlightKey={sortRating}
                      />
                      <ServiceLinks
                        hideSpotify={
                          item.mediaType === 'album' &&
                          Boolean(albumSpotifyDestination(item))
                        }
                        item={{ ...item, links: provider.links }}
                      />
                    </article>
                  )
                })}
              </div>
            </div>
          ) : (
            <table
              className="browse-table"
              aria-rowcount={total + 1}
              style={{
                width: columns.reduce(
                  (sum, field) => sum + widthFor(field),
                  ratingsWidth + (columnKeys.includes('links') ? 220 : 0),
                ),
              }}
            >
              <colgroup>
                {columns.map((field) => (
                  <col key={field.key} style={{ width: widthFor(field) }} />
                ))}
                <col style={{ width: ratingsWidth }} />
                {columnKeys.includes('links') && <col style={{ width: 220 }} />}
              </colgroup>
              <thead>
                <tr>
                  {columns.map((field) => (
                    <th
                      key={field.key}
                      aria-sort={
                        sortBy === field.key
                          ? direction === 'asc'
                            ? 'ascending'
                            : 'descending'
                          : 'none'
                      }
                    >
                      <button onClick={() => sort(field.key)}>
                        {field.label}
                        {sortBy === field.key
                          ? direction === 'asc'
                            ? ' ↑'
                            : ' ↓'
                          : ''}
                      </button>
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
                          event.currentTarget.setPointerCapture(event.pointerId)
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
                    </th>
                  ))}
                  <th>Ratings</th>
                  {columnKeys.includes('links') && <th>Links</th>}
                </tr>
              </thead>
              <tbody>
                {padTop > 0 && (
                  <tr aria-hidden="true">
                    <td
                      colSpan={columnCount}
                      style={{ height: padTop, padding: 0, border: 0 }}
                    />
                  </tr>
                )}
                {slots.map(({ item, index }) =>
                  item ? (
                    <tr
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
                      {columns.map((field) => (
                        <td
                          key={field.key}
                          className={field.type === 'text' ? '' : 'numeric'}
                          title={
                            field.key === 'dateAdded'
                              ? item.dateAddedSource
                              : formatBrowseValue(
                                  field,
                                  getBrowseValues(item)[field.key],
                                )
                          }
                        >
                          <div
                            className={`browse-cell ${field.key === 'title' && item.mediaType === 'album' ? 'flex items-center gap-2' : ''}`}
                          >
                            {field.key === 'title' &&
                            item.mediaType === 'album' ? (
                              <>
                                <AlbumTitle
                                  item={item}
                                  className="table-title min-w-0 flex-1 truncate"
                                  onOpenDetails={(event) =>
                                    openDetail(item.id, event.currentTarget)
                                  }
                                />
                                <button
                                  className="shrink-0 text-xs quiet"
                                  aria-label={`Open details for ${item.title}`}
                                  onClick={(event) => {
                                    event.stopPropagation()
                                    openDetail(item.id, event.currentTarget)
                                  }}
                                  onDoubleClick={(event) =>
                                    event.stopPropagation()
                                  }
                                >
                                  Open details
                                </button>
                              </>
                            ) : field.key === 'title' ? (
                              <button
                                className="table-title"
                                onClick={(event) =>
                                  openDetail(item.id, event.currentTarget)
                                }
                              >
                                {item.title}
                                {item.mediaType === 'film' &&
                                  filmIdentificationStatus(
                                    item.providerReferences,
                                  ) === 'Needs ID' && (
                                    <span className="needs-id">Needs ID</span>
                                  )}
                              </button>
                            ) : (
                              renderValue(item, field)
                            )}
                          </div>
                        </td>
                      ))}
                      <td>
                        <ProviderRatings
                          ratings={
                            getDetailProviderLinks(
                              fields,
                              getBrowseValues(item),
                              item.links,
                              undefined,
                              item.providerReferences,
                            ).ratings
                          }
                          context="table"
                        />
                      </td>
                      {columnKeys.includes('links') && (
                        <td>
                          <div className="browse-cell">
                            <ServiceLinks
                              hideSpotify={
                                columns.some(
                                  (field) => field.key === 'title',
                                ) &&
                                item.mediaType === 'album' &&
                                Boolean(albumSpotifyDestination(item))
                              }
                              item={{
                                ...item,
                                links: getDetailProviderLinks(
                                  fields,
                                  getBrowseValues(item),
                                  item.links,
                                  undefined,
                                  item.providerReferences,
                                ).links,
                              }}
                            />
                          </div>
                        </td>
                      )}
                    </tr>
                  ) : (
                    <tr
                      key={`slot-${index}`}
                      aria-hidden="true"
                      className="virtual-browse-placeholder"
                    >
                      {Array.from({ length: columnCount }, (_, column) => (
                        <td key={column}>
                          <div className="virtual-browse-line virtual-browse-shimmer" />
                        </td>
                      ))}
                    </tr>
                  ),
                )}
                {padBottom > 0 && (
                  <tr aria-hidden="true">
                    <td
                      colSpan={columnCount}
                      style={{ height: padBottom, padding: 0, border: 0 }}
                    />
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </div>
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
      {selectedId && (
        <>
          <div className="inspector-backdrop" onClick={closeDetail} />
          <aside
            ref={inspector}
            tabIndex={-1}
            aria-label="Media details"
            className="media-inspector"
          >
            <div className="detail-topbar">
              <a
                href={`/${collection}/${selectedId}${detailParams.size ? `?${detailParams}` : ''}`}
              >
                Open page
              </a>
              <button aria-label="Close details" onClick={closeDetail}>
                <X size={18} />
              </button>
            </div>
            <div className="inspector-scroll">
              <MediaDetail
                key={selectedId}
                mediaType={mediaType}
                id={selectedId}
                onFilter={addFilter}
                onFiltersChange={changeFilters}
                highlightField={sortBy}
                browseMetric={
                  sortField?.key === 'listeningScrobbles' &&
                  selectedListeningCount !== undefined
                    ? { field: sortField, value: selectedListeningCount }
                    : undefined
                }
              />
            </div>
          </aside>
        </>
      )}
    </section>
  )
}
