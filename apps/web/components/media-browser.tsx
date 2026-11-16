'use client'

import { DetailInspector } from './detail-inspector'
import { CreatorLinks } from './creator-links'
import { FilmCollectionLinks } from './film-collection-links'
import { CreatorScopeChip } from './creator-scope-chip'
import {
  clearCreatorScope,
  parseCreatorBrowseScope,
} from '@/utils/creator-browse'
import {
  replaceWorkspaceUrl,
  useDetailInspector,
} from './detail-inspector-context'
import { sameDetail, withoutDetailEntries } from '@/utils/detail-inspector'

import Link from 'next/link'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useSearchParams } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import { ListMusic, Settings2, X } from 'lucide-react'
import { Button } from '@repo/ui/components/ui/button'
import { TableScroll } from '@repo/ui/components/ui/table'
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
import { AlbumInlinePlayButton, TilePlayControls } from './play-controls'
import { createBrowsePlaybackSource } from '@/utils/playback-source'
import ManualMediaAdd from './manual-media-add'
import {
  BrowseFilterChips,
  BrowseTagBadges,
  RangeEditor,
} from './browse-controls'
import { ListeningControls } from './listening-controls'
import BrowseToolbar, { BrowseColumnsSection } from './browse-toolbar'
import { FilterPanelSection } from './browse-filter-panel'
import {
  formatListeningPeriod,
  formatListeningRule,
} from '@/utils/listening-filters'
import { AlbumSpotifyLink } from './service-icon-links'
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
import DetailProviderLinks from './detail-provider-links'
import {
  compactRatingStripWidth,
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
]
const defaultFilmColumns = [
  'title',
  'director',
  'releaseDate',
  'dateAdded',
  'genre',
  'source',
  'watched',
]

const overlayLabels = { ratings: 'Ratings', sort: 'Sort value', tags: 'Tags' }

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
  const inspector = useDetailInspector()
  const railSlot = useRailSlot()
  const resize = useRef<{ key: string; x: number; width: number } | null>(null)
  const filters = parseFilters(searchParams.get('filters'))
  const creator = parseCreatorBrowseScope(searchParams, mediaType)
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
  const selectedId =
    inspector?.root?.kind === mediaType ? inspector.root.id : null
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
    ...creator,
  })
  // With both overlays on, the sort value and provider marks sit on the artwork.
  const tileExtraRow =
    !overlays.includes('sort') || !overlays.includes('ratings')
  const tagsBelowArtwork = mediaType === 'album' && !overlays.includes('tags')
  const grid = mediaGridGeometry({
    width: viewport.width,
    mediaType,
    density,
    extraRow: tileExtraRow,
    tagsBelowArtwork,
  })
  const scrollIdentity = `${collection}:${queryKey}:${view}`
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
    const next = filters.some((item) => sameBrowseFilter(item, filter))
      ? filters
      : [...filters, filter]
    setParams({ filters: JSON.stringify(next) }, !keepOpen)
  }
  function changeFilters(next: BrowseFilter[]) {
    setParams({ filters: next.length ? JSON.stringify(next) : null })
  }
  function clearFilters() {
    setParams({
      q: null,
      filters: null,
      ranges: null,
      limitResults: null,
      listening: null,
      ...clearCreatorScope,
    })
  }
  function openDetail(id: string, trigger?: HTMLElement) {
    inspector?.open({ kind: mediaType, id }, trigger)
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
    if (selectedId)
      scroller.current
        ?.querySelector('[data-selected="true"]')
        ?.scrollIntoView({ block: 'nearest' })
  }, [selectedId])

  const gridColumns = grid.columns
  const rowHeight =
    view === 'table'
      ? 36
      : view === 'list'
        ? grid.mobile
          ? mediaType === 'album'
            ? 84
            : 64
          : mediaType === 'album'
            ? 64
            : 48
        : grid.rowHeight
  const params = new URLSearchParams({
    q,
    filters: JSON.stringify(filters),
    ranges: JSON.stringify(ranges),
    sortBy,
    direction,
    ...creator,
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
    queryKey: [
      collection,
      'title-suggestions',
      titleFilters,
      includeArchived,
      ...(creator ? [creator] : []),
    ],
    enabled: ready && titleFilters.length > 0,
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({
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
        !target.closest('.browse-scroll, .detail-topbar') &&
        !target.matches('.media-inspector')
      )
        return
      const current = slots.findIndex(({ item }) => item?.id === selectedId)
      const next = slots[current + (event.key === 'ArrowDown' ? 1 : -1)]?.item
      if (current < 0 || !next) return
      event.preventDefault()
      inspector?.replace({ kind: mediaType, id: next.id })
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  })
  const columnCount = columns.length + 1
  const providersWidth = compactRatingStripWidth(fields) + 72
  const widthFor = (field: BrowseField) =>
    widths[field.key] ??
    (field.key === 'title' ? 260 : field.type === 'text' ? 180 : 115)

  function renderValue(item: AlbumListItem | FilmListItem, field: BrowseField) {
    if (item.mediaType === 'film' && field.key === 'collection')
      return <FilmCollectionLinks item={item} />
    const values = getBrowseValues(item)
    const value = values[field.key]
    if (['artist', 'director', 'actor'].includes(field.key))
      return (
        <CreatorLinks
          creators={item.credits.filter((credit) => credit.role === field.key)}
          kind={field.key === 'artist' ? 'artist' : 'person'}
        />
      )
    if (
      item.mediaType === 'album' &&
      ['genre', 'albumTag', 'artistTag'].includes(field.key)
    )
      return (
        <BrowseTagBadges
          field={field.key}
          tags={
            field.key === 'genre'
              ? item.tags.map((tag) => tag.name)
              : Array.isArray(value)
                ? value
                : []
          }
          artistTags={field.key === 'genre' ? item.artistTags : undefined}
          onFilter={addFilter}
        />
      )
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
        {item.mediaType === 'film' && sortBy === 'collection' ? (
          <FilmCollectionLinks item={item} />
        ) : (
          formatBrowseValue(sortField, getBrowseValues(item)[sortBy])
        )}
      </span>
    )
  }
  function providerGroup(
    item: AlbumListItem | FilmListItem,
    context: 'poster' | 'table',
    highlightKey?: string,
    hideSpotify = false,
  ) {
    return (
      <DetailProviderLinks
        fields={fields}
        values={getBrowseValues(item)}
        links={item.links}
        references={item.providerReferences}
        spotifyUrl={
          item.mediaType === 'album' ? albumSpotifyDestination(item) : undefined
        }
        hideSpotify={hideSpotify}
        context={context}
        highlightKey={highlightKey}
      />
    )
  }
  function titleControl(item: AlbumListItem | FilmListItem, className: string) {
    return item.mediaType === 'album' ? (
      <div
        className={`${styles.itemTitleRow} ${className === 'tile-title' ? styles.tileTitleRow : ''}`}
      >
        <AlbumTitle
          item={item}
          className={className}
          onOpenDetails={(event) => openDetail(item.id, event.currentTarget)}
        />
        <AlbumSpotifyLink item={item} />
      </div>
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
  function albumPlaybackSource(item: AlbumListItem, index: number) {
    const source = (length: number) =>
      createBrowsePlaybackSource({
        apiBaseUrl,
        collection: 'albums',
        params,
        href: `/albums?${searchParams.size ? searchParams : params}`,
        label: 'Albums',
        total: length,
        startIndex: index,
        initialItem: item,
      })
    return query.isCounting
      ? query.resolveTotal(index).then(source)
      : source(total)
  }
  function creatorButtons(item: AlbumListItem | FilmListItem) {
    const creatorField = item.mediaType === 'album' ? 'artist' : 'director'
    return (
      <CreatorLinks
        creators={item.credits.filter((credit) => credit.role === creatorField)}
        kind={item.mediaType === 'album' ? 'artist' : 'person'}
      />
    )
  }
  const activeFilterCount =
    Number(Boolean(q)) +
    Number(Boolean(creator)) +
    filters.length +
    ranges.length +
    (listening?.rules.length ?? 0) +
    Number(Boolean(limitResults))
  const hasActiveFilters = activeFilterCount > 0
  const activeFilters = hasActiveFilters ? (
    <div className="active-filters">
      {creator && (
        <CreatorScopeChip
          scope={creator}
          film={mediaType === 'film'}
          onRemove={() => setParams(clearCreatorScope)}
        />
      )}
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
      <button className="clear-filters" onClick={clearFilters}>
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
        <BrowseToolbar
          actions={
            <>
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
            </>
          }
          search={
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
                onFocus: facets.activate,
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
                            ...clearCreatorScope,
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
                <BrowseColumnsSection>
                  {fields.map((field) => (
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
                </BrowseColumnsSection>
              )}
            </>
          }
          view={view}
          onViewChange={(next) => setParams({ view: next })}
          count={
            query.countError ? (
              <button
                type="button"
                className="underline"
                onClick={query.retryCount}
              >
                Retry count
              </button>
            ) : !query.isCounting ? (
              `${total.toLocaleString()} ${collection}`
            ) : query.isPending ? (
              'Loading...'
            ) : (
              'Counting...'
            )
          }
        />
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
          {query.hasTotal && !query.isError && total === 0 && (
            <div className="browse-empty">
              No matches. <button onClick={clearFilters}>Clear filters</button>
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
                  const hideSpotify =
                    item.mediaType === 'album' &&
                    Boolean(albumSpotifyDestination(item))
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
                        {overlays.includes('tags') && (
                          <BrowseTagBadges
                            tags={item.tags.map((tag) => tag.name)}
                            artistTags={
                              item.mediaType === 'album'
                                ? item.artistTags
                                : undefined
                            }
                            className="tile-tags"
                            onFilter={addFilter}
                          />
                        )}
                        {overlays.includes('ratings') &&
                          providerGroup(
                            item,
                            'poster',
                            overlays.includes('sort') ? sortRating : undefined,
                            hideSpotify,
                          )}
                        {item.mediaType === 'album' && (
                          <TilePlayControls
                            album={item}
                            source={() => albumPlaybackSource(item, index)}
                          />
                        )}
                      </div>
                      {titleControl(item, 'tile-title')}
                      <div className="tile-byline">
                        <span>{creatorButtons(item)}</span>
                        <span>{item.releaseDate?.slice(0, 4)}</span>
                      </div>
                      {tagsBelowArtwork && (
                        <BrowseTagBadges
                          tags={item.tags.map((tag) => tag.name)}
                          artistTags={
                            item.mediaType === 'album'
                              ? item.artistTags
                              : undefined
                          }
                          onFilter={addFilter}
                        />
                      )}
                      {tileExtraRow && (
                        <div className="tile-extra">
                          {!overlays.includes('sort') && sortValue(item)}
                          {!overlays.includes('ratings') &&
                            providerGroup(
                              item,
                              'table',
                              sortRating,
                              hideSpotify,
                            )}
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
                className={`media-list ${mediaType} ${styles.mediaRows}`}
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
                        style={{ height: rowHeight }}
                      >
                        <div className="list-thumb virtual-browse-shimmer" />
                        <div className="virtual-browse-line virtual-browse-shimmer" />
                      </div>
                    )
                  return (
                    <article
                      className="list-row"
                      key={item.id}
                      data-item-index={index}
                      data-selected={item.id === selectedId}
                      style={{ height: rowHeight }}
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
                      <div className={styles.listContent}>
                        <div className={styles.listTitle}>
                          {item.mediaType === 'album' && (
                            <AlbumInlinePlayButton
                              album={item}
                              source={() => albumPlaybackSource(item, index)}
                            />
                          )}
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
                        {item.mediaType === 'album' && (
                          <BrowseTagBadges
                            tags={item.tags.map((tag) => tag.name)}
                            artistTags={
                              item.mediaType === 'album'
                                ? item.artistTags
                                : undefined
                            }
                            onFilter={addFilter}
                          />
                        )}
                      </div>
                      <div className={styles.listProviders}>
                        {providerGroup(
                          item,
                          'table',
                          sortRating,
                          item.mediaType === 'album' &&
                            Boolean(albumSpotifyDestination(item)),
                        )}
                      </div>
                    </article>
                  )
                })}
              </div>
            </div>
          ) : (
            <table
              className="browse-table"
              aria-rowcount={query.hasTotal ? total + 1 : undefined}
              style={{
                width: columns.reduce(
                  (sum, field) => sum + widthFor(field),
                  providersWidth,
                ),
              }}
            >
              <colgroup>
                {columns.map((field) => (
                  <col key={field.key} style={{ width: widthFor(field) }} />
                ))}
                <col style={{ width: providersWidth }} />
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
                  <th>Providers</th>
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
                            className={`browse-cell ${item.mediaType === 'album' && (field.key === 'title' || field.key === 'genre') ? 'flex items-center gap-2' : ''}`}
                          >
                            {field.key === 'title' &&
                            item.mediaType === 'album' ? (
                              <>
                                <AlbumInlinePlayButton
                                  album={item}
                                  source={() =>
                                    albumPlaybackSource(item, index)
                                  }
                                />
                                {titleControl(item, 'table-title')}
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
                        {providerGroup(
                          item,
                          'table',
                          sortRating,
                          item.mediaType === 'album' &&
                            columns.some((field) => field.key === 'title') &&
                            Boolean(albumSpotifyDestination(item)),
                        )}
                      </td>
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
        </TableScroll>
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
      <DetailInspector
        media={{
          onFilter:
            inspector?.active?.kind === mediaType ? addFilter : undefined,
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
    </section>
  )
}
