'use client'

import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useSearchParams } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import { ArrowDown, ArrowUp, Columns3, X } from 'lucide-react'
import { Button } from '@repo/ui/components/ui/button'
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
import { usePlaylistDrawer } from '@/hooks/usePlaylistDrawer'
import { matchingTitleFilters } from '@/utils/browse-suggestions'
import {
  albumHref,
  defaultTrackColumns,
  formatTrackDuration,
  parseTrackFilters,
  trackTitleSuggestions,
  withTrackFilter,
} from '@/utils/track-browse'
import { aiSearchParams, mediaAiSearchTarget } from '@/utils/ai-search'
import { playlistFilter, playlistHref } from '@/utils/playlist-links'
import AiSearch from './ai-search'
import { BrowseFilterChips, RangeEditor } from './browse-controls'
import BrowseFilterPanel, { FilterPanelSection } from './browse-filter-panel'
import { FilterButton } from './filter-affordance'
import {
  LibraryTrackPlayButton,
  LibraryTrackQueueButton,
} from './play-controls'
import { usePlayback } from './playback-provider'
import { PlaylistDrawer } from './playlist-detail'
import TrackDetailView from './track-detail'
import LastfmTracksImport from './lastfm-tracks-import'
import styles from './media-browser.module.css'

const collection = 'tracks'
const PageSchema = PaginatedDataSchema(TrackListItemSchema)
const WidthsSchema = z.record(z.string(), z.number().min(70).max(650))
const rowHeight = 36
const headerHeight = 34
const playColumnWidth = 68
/** URL parameters of the open drawers; changing them keeps the page and is not saved. */
const drawerParams = ['item', 'playlist', 'tab']

export default function TrackBrowser() {
  const { apiBaseUrl } = useConfig()
  const searchParams = useSearchParams()
  const [ready, setReady] = useState(false)
  const [draft, setDraft] = useState('')
  const [scroll, setScroll] = useState({ identity: '', top: 0 })
  const [viewportHeight, setViewportHeight] = useState(800)
  const [widths, setWidths] = useState<Record<string, number>>({})
  const scroller = useRef<HTMLDivElement>(null)
  const inspector = useRef<HTMLElement>(null)
  const railSlot = useRailSlot()
  const openedHere = useRef(false)
  const detailTrigger = useRef<HTMLElement | null>(null)
  const resize = useRef<{ key: string; x: number; width: number } | null>(null)
  const playlistDrawer = usePlaylistDrawer({ replaces: ['item'] })
  const playable = usePlayback().enabled
  const filters = parseTrackFilters(searchParams.get('filters'))
  const rangesResult = BrowseRangesParamSchema.safeParse(
    searchParams.get('ranges'),
  )
  const ranges = rangesResult.success ? rangesResult.data : []
  const q = searchParams.get('q') ?? ''
  const sortBy = canonicalBrowseKey(searchParams.get('sortBy') ?? 'dateAdded')
  const direction = searchParams.get('direction') === 'asc' ? 'asc' : 'desc'
  // One drawer at a time: the playlist drawer covers the track drawer.
  const selectedId = playlistDrawer.playlistId ? null : searchParams.get('item')
  const detailParams = new URLSearchParams(searchParams)
  for (const key of drawerParams) detailParams.delete(key)
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
  const queryKey = JSON.stringify({ q, filters, ranges, sortBy, direction })
  const scrollIdentity = `${collection}:${queryKey}`
  const scrollTop = scroll.identity === scrollIdentity ? scroll.top : 0

  function setParams(updates: Record<string, string | null>, push = false) {
    const params = new URLSearchParams(window.location.search)
    for (const [key, value] of Object.entries(updates)) {
      if (value === null || value === '') params.delete(key)
      else params.set(key, value)
    }
    if (Object.keys(updates).some((key) => !drawerParams.includes(key)))
      params.delete('page')
    const url = `/${collection}${params.size ? `?${params}` : ''}`
    if (push) window.history.pushState(null, '', url)
    else window.history.replaceState(null, '', url)
    const saved = new URLSearchParams(params)
    for (const key of drawerParams) saved.delete(key)
    try {
      window.localStorage.setItem(`browse:${collection}`, saved.toString())
    } catch {
      /* URL state still works when browser storage is unavailable. */
    }
  }
  function addFilter(filter: BrowseFilter, keepOpen = false) {
    const next = withTrackFilter(filters, filter)
    // Closing must not navigate back to the filter state from before the drawer opened.
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
    setParams({ item: id, playlist: null, tab: null }, true)
  }
  function filterByPlaylist(name: string) {
    playlistDrawer.forget()
    setParams({
      filters: JSON.stringify(withTrackFilter(filters, playlistFilter(name))),
      playlist: null,
      tab: null,
    })
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
      if (entry) setViewportHeight(entry.contentRect.height)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 })
  }, [scrollIdentity])
  useEffect(() => {
    if (selectedId) {
      // The inspector covers the results, so it takes focus.
      inspector.current?.focus({ preventScroll: true })
      scroller.current
        ?.querySelector('[data-selected="true"]')
        ?.scrollIntoView({ block: 'nearest' })
    } else if (!playlistDrawer.playlistId && detailTrigger.current?.isConnected)
      detailTrigger.current.focus({ preventScroll: true })
  }, [selectedId, playlistDrawer.playlistId])

  const params = new URLSearchParams({
    q,
    filters: JSON.stringify(filters),
    ranges: JSON.stringify(ranges),
    sortBy,
    direction,
  })
  const query = useVirtualBrowse({
    apiBaseUrl,
    collection,
    identity: queryKey,
    params,
    enabled: ready,
    columns: 1,
    rowHeight,
    scrollTop,
    viewportHeight,
    headerHeight,
    itemSchema: TrackListItemSchema,
  })
  const { total, slots, padTop, padBottom } = query
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
    (field.key === 'title' ? 260 : field.type === 'text' ? 180 : 115)

  function renderValue(item: TrackListItem, field: BrowseField) {
    if (field.key === 'title')
      return (
        <button
          className="table-title"
          onClick={(event) => openDetail(item.id, event.currentTarget)}
        >
          {item.title}
        </button>
      )
    if (field.key === 'album') {
      if (!item.albumName) return '-'
      return item.album ? (
        <Link
          href={albumHref(item.album.id)}
          title={`Open ${item.album.title} in the album library`}
        >
          {item.albumName}
        </Link>
      ) : (
        <span className="quiet" title="Not in the album library">
          {item.albumName}
        </span>
      )
    }
    if (field.key === 'durationSec')
      return formatTrackDuration(item.durationSec)
    if (field.key === 'playlist')
      return (
        <span className="inline-values">
          {item.playlists.map((playlist) => (
            <button
              type="button"
              key={playlist.id}
              onClick={(event) =>
                playlistDrawer.open(playlist.id, event.currentTarget)
              }
              title={`Open ${playlist.name}`}
            >
              {playlist.name}
            </button>
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

  const activeFilterCount = Number(Boolean(q)) + filters.length + ranges.length
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
        <button
          className="clear-filters"
          onClick={() => setParams({ q: null, filters: null, ranges: null })}
        >
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
        <div className="browse-toolbar">
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
            <LastfmTracksImport />
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
              <FilterPanelSection title="Columns" icon={<Columns3 size={16} />}>
                <div className="filter-panel-columns">
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
                </div>
              </FilterPanelSection>
            </BrowseFilterPanel>
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
          data-view="table"
          ref={scroller}
          tabIndex={0}
          role="region"
          aria-label={`${collection} table`}
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
                  setParams({ q: null, filters: null, ranges: null })
                }
              >
                Clear filters
              </button>
            </div>
          )}
          <table
            className="browse-table"
            aria-rowcount={total + 1}
            style={{
              width: columns.reduce(
                (sum, field) => sum + widthFor(field),
                playable ? playColumnWidth : 0,
              ),
            }}
          >
            <colgroup>
              {playable && <col style={{ width: playColumnWidth }} />}
              {columns.map((field) => (
                <col key={field.key} style={{ width: widthFor(field) }} />
              ))}
            </colgroup>
            <thead>
              <tr>
                {playable && (
                  <th>
                    <span className="sr-only">Play</span>
                  </th>
                )}
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
                    colSpan={columns.length + Number(playable)}
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
                    {playable && (
                      <td>
                        <div className="browse-cell">
                          <LibraryTrackPlayButton track={item} />
                          <LibraryTrackQueueButton track={item} />
                        </div>
                      </td>
                    )}
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
                        <div className="browse-cell">
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
                    {playable && <td />}
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
                    colSpan={columns.length + Number(playable)}
                    style={{ height: padBottom, padding: 0, border: 0 }}
                  />
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      {selectedId && (
        <>
          <div className="inspector-backdrop" onClick={closeDetail} />
          <aside
            ref={inspector}
            tabIndex={-1}
            aria-label="Track details"
            className="media-inspector"
          >
            <div className="detail-topbar">
              <a
                href={`/${collection}/${encodeURIComponent(selectedId)}${detailParams.size ? `?${detailParams}` : ''}`}
              >
                Open page
              </a>
              <button aria-label="Close details" onClick={closeDetail}>
                <X size={18} />
              </button>
            </div>
            <div className="inspector-scroll">
              <TrackDetailView
                key={selectedId}
                id={selectedId}
                onFilter={addFilter}
                onOpenPlaylist={playlistDrawer.open}
              />
            </div>
          </aside>
        </>
      )}
      {playlistDrawer.playlistId && (
        <PlaylistDrawer
          id={playlistDrawer.playlistId}
          tab={playlistDrawer.tab}
          topbar={
            <Link href={playlistHref(playlistDrawer.playlistId)}>
              Open in Playlists
            </Link>
          }
          onClose={playlistDrawer.close}
          onTabChange={playlistDrawer.setTab}
          onOpenTrack={openDetail}
          filterTracks={(playlist) => filterByPlaylist(playlist.name)}
        />
      )}
    </section>
  )
}
