'use client'

import { PlaylistPlayButton } from './playlist-detail'
import { TrackArtistLinks } from './creator-links'
import { CreatorScopeChip } from './creator-scope-chip'
import {
  clearCreatorScope,
  parseCreatorBrowseScope,
} from '@/utils/creator-browse'

import { DetailInspector } from './detail-inspector'
import {
  replaceWorkspaceUrl,
  useDetailInspector,
} from './detail-inspector-context'
import { sameDetail, withoutDetailEntries } from '@/utils/detail-inspector'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useSearchParams } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import { X } from 'lucide-react'
import { Button } from '@repo/ui/components/ui/button'
import { TableScroll } from '@repo/ui/components/ui/table'
import { PaginatedDataSchema } from '@repo/schemas/common'
import {
  BrowseFieldSchema,
  BrowseRangesParamSchema,
  canonicalBrowseKey,
  formatBrowseValue,
  trackBrowseFields,
  type BrowseField,
  type BrowseFilter,
} from '@repo/schemas/browse'
import {
  TrackListItemSchema,
  getTrackBrowseValues,
  type TrackListItem,
} from '@repo/schemas/tracks'
import { useConfig } from './providers'
import { fetchApiData } from '@/utils/api'
import { useVirtualBrowse } from '@/hooks/useVirtualBrowse'
import { useBrowseFacets } from '@/hooks/useBrowseFacets'
import { useRailSlot } from '@/hooks/useRailSlot'
import { matchingTitleFilters } from '@/utils/browse-suggestions'
import {
  defaultTrackColumns,
  formatTrackDuration,
  parseTrackFilters,
  trackTitleSuggestions,
  withTrackFilter,
} from '@/utils/track-browse'
import { aiSearchParams, mediaAiSearchTarget } from '@/utils/ai-search'
import { playlistFilter } from '@/utils/playlist-links'
import AiSearch from './ai-search'
import {
  BrowseFilterChips,
  BrowseTagBadges,
  RangeEditor,
} from './browse-controls'
import BrowseToolbar, { BrowseColumnsSection } from './browse-toolbar'
import { FilterButton } from './filter-affordance'
import {
  AlbumReferencePlayButton,
  LibraryTrackPlayButton,
  LibraryTrackQueueButton,
} from './play-controls'
import { createBrowsePlaybackSource } from '@/utils/playback-source'
import {
  mediaGridGeometry,
  parseBrowseView,
  preserveGridScroll,
} from '@/utils/media-grid'
import { DetailLink } from './detail-link'
import MediaArtwork from './media-artwork'
import ServiceIconLinks from './service-icon-links'
import { trackServiceLinks } from '@/utils/track-links'
import styles from './media-browser.module.css'

const collection = 'tracks'
const PageSchema = PaginatedDataSchema(TrackListItemSchema)
const WidthsSchema = z.record(z.string(), z.number().min(70).max(650))
const headerHeight = 34
const artworkColumnWidth = 96
const listRowHeight = 68

export default function TrackBrowser() {
  const { apiBaseUrl } = useConfig()
  const searchParams = useSearchParams()
  const [ready, setReady] = useState(false)
  const [draft, setDraft] = useState('')
  const [scroll, setScroll] = useState({ identity: '', top: 0 })
  const [viewport, setViewport] = useState({ width: 1000, height: 800 })
  const [gridLayout, setGridLayout] = useState<{
    identity: string
    columns: number
    rowHeight: number
  } | null>(null)
  const [widths, setWidths] = useState<Record<string, number>>({})
  const scroller = useRef<HTMLDivElement>(null)
  const inspector = useDetailInspector()
  const railSlot = useRailSlot()
  const resize = useRef<{ key: string; x: number; width: number } | null>(null)
  const view = parseBrowseView(searchParams.get('view'), 'list')
  const filters = parseTrackFilters(searchParams.get('filters'))
  const creator = parseCreatorBrowseScope(searchParams, 'track')
  const rangesResult = BrowseRangesParamSchema.safeParse(
    searchParams.get('ranges'),
  )
  const ranges = rangesResult.success ? rangesResult.data : []
  const q = searchParams.get('q') ?? ''
  const sortBy = canonicalBrowseKey(searchParams.get('sortBy') ?? 'dateAdded')
  const direction = searchParams.get('direction') === 'asc' ? 'asc' : 'desc'
  // One drawer at a time: the playlist drawer covers the track drawer.
  const selectedId =
    inspector?.root?.kind === 'track' ? inspector.root.id : null
  const fieldsQuery = useQuery({
    queryKey: [collection, 'fields'],
    queryFn: () =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/${collection}/fields`,
        z.array(BrowseFieldSchema),
      ),
  })
  const fields = fieldsQuery.data ?? trackBrowseFields
  const columnKeys =
    searchParams.get('columns')?.split(',').map(canonicalBrowseKey) ??
    defaultTrackColumns
  const columns = fields.filter((field) => columnKeys.includes(field.key))
  const queryKey = JSON.stringify({
    q,
    filters,
    ranges,
    sortBy,
    direction,
    ...creator,
  })
  const scrollIdentity = `${collection}:${queryKey}:${view}`
  const grid = mediaGridGeometry({
    width: viewport.width,
    mediaType: 'album',
    density: 'standard',
    extraRow: false,
    tagsBelowArtwork: true,
  })
  const rowHeight =
    view === 'grid' ? grid.rowHeight : view === 'list' ? listRowHeight : 36
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
    const next = withTrackFilter(filters, filter)
    setParams({ filters: JSON.stringify(next) }, !keepOpen)
  }
  function changeFilters(next: BrowseFilter[]) {
    setParams({ filters: next.length ? JSON.stringify(next) : null })
  }
  function clearFilters() {
    setParams({ q: null, filters: null, ranges: null, ...clearCreatorScope })
  }
  function openDetail(id: string, trigger?: HTMLElement) {
    inspector?.open({ kind: 'track', id }, trigger)
  }
  function filterByPlaylist(name: string) {
    addFilter(playlistFilter(name))
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
    if (selectedId)
      scroller.current
        ?.querySelector('[data-selected="true"]')
        ?.scrollIntoView({ block: 'nearest' })
  }, [selectedId])

  const params = new URLSearchParams({
    q,
    filters: JSON.stringify(filters),
    ranges: JSON.stringify(ranges),
    sortBy,
    direction,
    ...creator,
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
    headerHeight: view === 'table' ? headerHeight : 0,
    itemSchema: TrackListItemSchema,
  })
  const { total, slots, padTop, padBottom } = query
  const facets = useBrowseFacets(apiBaseUrl, collection, draft, ready)
  const titleFilters = matchingTitleFilters(facets.data ?? [], facets.search)
  const titleMatches = useQuery({
    queryKey: [
      collection,
      'title-suggestions',
      titleFilters,
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
      ? trackTitleSuggestions(titleMatches.data?.items ?? [])
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
      inspector?.replace({ kind: 'track', id: next.id })
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  })
  const widthFor = (field: BrowseField) =>
    widths[field.key] ??
    (field.key === 'title' ? 260 : field.type === 'text' ? 180 : 115)

  function trackTitle(item: TrackListItem, className: string) {
    const title = (
      <button
        type="button"
        className={className}
        title={item.title}
        onClick={(event) => openDetail(item.id, event.currentTarget)}
      >
        {item.title}
      </button>
    )
    return className === 'tile-title' ? (
      title
    ) : (
      <div className={styles.itemTitleRow}>
        {title}
        <ServiceIconLinks links={trackServiceLinks(item)} />
      </div>
    )
  }

  function trackArtwork(item: TrackListItem, tile = false) {
    const imageClassName = tile
      ? 'aspect-square object-cover w-full'
      : 'list-thumb-image'
    return (
      <button
        type="button"
        className={tile ? 'art-button' : 'list-thumb art-button'}
        aria-label={`Open details for ${item.title}`}
        onClick={(event) => openDetail(item.id, event.currentTarget)}
      >
        <MediaArtwork
          src={item.artworkUrl}
          alt=""
          fallbackLabel={tile ? item.title : ''}
          imageClassName={imageClassName}
          fallbackClassName={
            tile ? `aspect-square ${styles.fallback}` : imageClassName
          }
        />
      </button>
    )
  }

  function trackPlayControls(
    item: TrackListItem,
    index: number,
    className?: string,
  ) {
    const source = (length: number) =>
      createBrowsePlaybackSource({
        apiBaseUrl,
        collection: 'tracks',
        params,
        href: `/tracks?${searchParams.size ? searchParams : params}`,
        label: 'Tracks',
        total: length,
        startIndex: index,
        initialItem: item,
      })
    return (
      <div className={className}>
        <LibraryTrackPlayButton
          track={item}
          source={() =>
            query.isCounting
              ? query.resolveTotal(index).then(source)
              : source(total)
          }
        />
        <LibraryTrackQueueButton track={item} />
      </div>
    )
  }

  function trackAlbum(item: TrackListItem) {
    return item.album ? (
      <span className={styles.trackAlbum}>
        <AlbumReferencePlayButton id={item.album.id} title={item.album.title} />
        <DetailLink
          kind="album"
          id={item.album.id}
          title={`Open ${item.album.title} in the album library`}
        >
          {item.albumName ?? item.album.title}
        </DetailLink>
      </span>
    ) : item.albumName ? (
      <span className="quiet" title="Not in the album library">
        {item.albumName}
      </span>
    ) : null
  }

  function artistFilters(item: TrackListItem) {
    return <TrackArtistLinks track={item} />
  }

  function renderValue(item: TrackListItem, field: BrowseField) {
    if (field.key === 'artist') return artistFilters(item)
    if (field.key === 'title') return trackTitle(item, 'table-title')
    if (field.key === 'album') return trackAlbum(item) ?? '-'
    if (field.key === 'genre')
      return (
        <BrowseTagBadges
          tags={item.albumTags}
          artistTags={item.artistTags}
          onFilter={addFilter}
        />
      )
    if (field.key === 'albumTag' || field.key === 'artistTag')
      return (
        <BrowseTagBadges
          field={field.key}
          tags={field.key === 'albumTag' ? item.albumTags : item.artistTags}
          onFilter={addFilter}
        />
      )
    if (field.key === 'durationSec')
      return formatTrackDuration(item.durationSec)
    if (field.key === 'playlist')
      return (
        <span className="inline-values">
          {item.playlists.map((playlist) => (
            <span key={playlist.id} className="inline-flex items-center gap-1">
              <PlaylistPlayButton playlist={playlist} />
              <DetailLink
                kind="playlist"
                id={playlist.id}
                title={`Open ${playlist.name}`}
              >
                {playlist.name}
              </DetailLink>
            </span>
          ))}
        </span>
      )
    const value = getTrackBrowseValues(item)[field.key]
    if (field.type === 'text' && field.filterable) {
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

  const activeFilterCount =
    Number(Boolean(q)) +
    Number(Boolean(creator)) +
    filters.length +
    ranges.length
  const activeFilters =
    activeFilterCount > 0 ? (
      <div className="active-filters">
        {creator && (
          <CreatorScopeChip
            scope={creator}
            onRemove={() => setParams(clearCreatorScope)}
          />
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
        <button className="clear-filters" onClick={clearFilters}>
          Clear all
        </button>
      </div>
    ) : null

  return (
    <section
      className={`media-browser ${styles.browser}`}
      aria-label={collection}
    >
      <div className="browse-main">
        <BrowseToolbar
          search={
            <AiSearch
              target={mediaAiSearchTarget('track', fields)}
              queryIdentity={queryKey}
              autocomplete={{
                items: titleItems,
                titlesLoading,
                titlesError:
                  facets.isError ||
                  (titleFilters.length > 0 && titleMatches.isError),
                onOpenItem: openDetail,
                options,
                placeholder: 'Search titles, artists, albums, playlists...',
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
              {activeFilters && (
                <section
                  className="filter-panel-active"
                  aria-label="Active filters"
                >
                  <h3>Active filters</h3>
                  {activeFilters}
                </section>
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
              `${total.toLocaleString()} ${total === 1 ? 'track' : 'tracks'}`
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
                className={`media-grid ${styles.grid}`}
                data-mobile={grid.mobile}
                style={{
                  gridTemplateColumns: `repeat(${grid.columns}, minmax(0, 1fr))`,
                  gridAutoRows: grid.cardHeight,
                  gap: grid.gap,
                  position: 'absolute',
                  top: padTop,
                  left: 0,
                  right: 0,
                }}
              >
                {slots.map(({ item, index }) =>
                  item ? (
                    <article
                      className="media-tile"
                      key={item.id}
                      data-item-index={index}
                      data-selected={item.id === selectedId}
                    >
                      <div className="tile-artwork">
                        {trackArtwork(item, true)}
                        {trackPlayControls(
                          item,
                          index,
                          `tile-play ${styles.trackTileControls}`,
                        )}
                        <div className={styles.trackTileLinks}>
                          <ServiceIconLinks links={trackServiceLinks(item)} />
                        </div>
                      </div>
                      {trackTitle(item, 'tile-title')}
                      <div className="tile-byline">
                        <span>{artistFilters(item)}</span>
                        <span>{formatTrackDuration(item.durationSec)}</span>
                      </div>
                      <BrowseTagBadges
                        tags={item.albumTags}
                        artistTags={item.artistTags}
                        onFilter={addFilter}
                      />
                    </article>
                  ) : (
                    <div
                      key={`slot-${index}`}
                      className="virtual-browse-placeholder"
                      aria-hidden="true"
                    >
                      <div className="aspect-square virtual-browse-shimmer" />
                      <div className="virtual-browse-line virtual-browse-shimmer" />
                      <div className="virtual-browse-line virtual-browse-line-short virtual-browse-shimmer" />
                    </div>
                  ),
                )}
              </div>
            </div>
          ) : view === 'list' ? (
            <div
              className="virtual-browse-grid"
              style={{ height: query.height }}
            >
              <div
                className={`media-list ${styles.trackRows}`}
                style={{ top: padTop }}
              >
                {slots.map(({ item, index }) =>
                  item ? (
                    <article
                      className="list-row"
                      key={item.id}
                      data-item-index={index}
                      data-selected={item.id === selectedId}
                      style={{ height: listRowHeight }}
                    >
                      {trackArtwork(item)}
                      <div className={styles.listContent}>
                        <div className={styles.listTitle}>
                          {trackTitle(item, 'table-title')}
                        </div>
                        <div className={`list-byline ${styles.trackByline}`}>
                          <span
                            className="inline-values"
                            title={item.artists.join(', ')}
                          >
                            {artistFilters(item)}
                          </span>
                          {trackAlbum(item)}
                        </div>
                        <BrowseTagBadges
                          tags={item.albumTags}
                          artistTags={item.artistTags}
                          onFilter={addFilter}
                        />
                      </div>
                      <span className={styles.trackDuration}>
                        {formatTrackDuration(item.durationSec)}
                      </span>
                      {trackPlayControls(item, index, styles.trackRowControls)}
                    </article>
                  ) : (
                    <div
                      key={`slot-${index}`}
                      className="list-row virtual-browse-placeholder"
                      aria-hidden="true"
                      style={{ height: listRowHeight }}
                    >
                      <div className="list-thumb list-thumb-image virtual-browse-shimmer" />
                      <div className="virtual-browse-line virtual-browse-shimmer" />
                    </div>
                  ),
                )}
              </div>
            </div>
          ) : (
            <table
              className="browse-table"
              aria-rowcount={query.hasTotal ? total + 1 : undefined}
              style={{
                width: columns.reduce(
                  (sum, field) => sum + widthFor(field),
                  artworkColumnWidth,
                ),
              }}
            >
              <colgroup>
                <col style={{ width: artworkColumnWidth }} />
                {columns.map((field) => (
                  <col key={field.key} style={{ width: widthFor(field) }} />
                ))}
              </colgroup>
              <thead>
                <tr>
                  <th>
                    <span className="sr-only">Artwork and playback</span>
                  </th>
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
                </tr>
              </thead>
              <tbody>
                {padTop > 0 && (
                  <tr aria-hidden="true">
                    <td
                      colSpan={columns.length + 1}
                      style={{ height: padTop, padding: 0, border: 0 }}
                    />
                  </tr>
                )}
                {slots.map(({ item, index }) =>
                  item ? (
                    <tr
                      key={item.id}
                      className="group"
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
                      <td>
                        <div
                          className={`browse-cell ${styles.trackTableArtwork}`}
                        >
                          {trackArtwork(item)}
                          {trackPlayControls(
                            item,
                            index,
                            styles.trackRowControls,
                          )}
                        </div>
                      </td>
                      {columns.map((field) => (
                        <td
                          key={field.key}
                          className={field.type === 'text' ? '' : 'numeric'}
                          title={
                            field.key === 'durationSec'
                              ? formatTrackDuration(item.durationSec)
                              : formatBrowseValue(
                                  field,
                                  getTrackBrowseValues(item)[field.key],
                                )
                          }
                        >
                          <div
                            className={
                              ['title', 'album', 'genre'].includes(field.key)
                                ? 'browse-cell flex items-center'
                                : 'browse-cell'
                            }
                          >
                            {renderValue(item, field)}
                          </div>
                        </td>
                      ))}
                    </tr>
                  ) : (
                    <tr
                      key={`slot-${index}`}
                      aria-hidden="true"
                      className="virtual-browse-placeholder"
                    >
                      <td />
                      {columns.map((field) => (
                        <td key={field.key}>
                          <div className="virtual-browse-line virtual-browse-shimmer" />
                        </td>
                      ))}
                    </tr>
                  ),
                )}
                {padBottom > 0 && (
                  <tr aria-hidden="true">
                    <td
                      colSpan={columns.length + 1}
                      style={{ height: padBottom, padding: 0, border: 0 }}
                    />
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </TableScroll>
      </div>
      <DetailInspector
        track={{ onFilter: addFilter }}
        playlist={{
          filterTracks: (playlist) => filterByPlaylist(playlist.name),
        }}
      />
    </section>
  )
}
