'use client'

import { TrackArtistLinks } from './creator-links'
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
import { useSearchParams } from 'next/navigation'
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
import { Skeleton } from '@repo/ui/components/ds/feedback'
import { EMPTY_VALUE, formatCount, formatDate } from '@repo/ui/lib/format'
import {
  BrowseRangesParamSchema,
  canonicalBrowseKey,
  type BrowseField,
  type BrowseFilter,
} from '@repo/schemas/browse'
import {
  TrackListItemSchema,
  getTrackBrowseValues,
  type TrackListItem,
} from '@repo/schemas/tracks'
import { useConfig } from './providers'
import { useVirtualBrowse } from '@/hooks/useVirtualBrowse'
import { useRailSlot } from '@/hooks/useRailSlot'
import {
  defaultTrackColumns,
  formatTrackDuration,
  parseTrackFilters,
  withTrackFilter,
} from '@/utils/track-browse'
import {
  columnOrderParam,
  hasCustomColumnOrder,
  formatFieldValue,
  itemGridGeometry,
  nextSortDirection,
  orderColumns,
  parseColumnOrder,
  sortedValueLabel,
} from '@/utils/browse-items'
import { playlistFilter } from '@/utils/playlist-links'
import { RangeEditor } from './browse-controls'
import {
  TrackBrowseAlbum,
  TrackBrowseTags,
  TrackBrowseValue,
} from './track-browse-cells'
import {
  TrackBrowseFilterChips,
  TrackBrowseSearch,
  useTrackBrowseFields,
} from './track-browse-controls'
import BrowseToolbar, { BrowseColumnsSection } from './browse-toolbar'
import { LibraryTrackPlayButton } from './play-controls'
import { createBrowsePlaybackSource } from '@/utils/playback-source'
import {
  defaultBrowseView,
  gridCardMin,
  parseBrowseView,
  preserveGridScroll,
  restoreSavedBrowse,
} from '@/utils/media-grid'
import { useGridDensity } from '@/hooks/useGridDensity'
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
  useColumnWidths,
} from './browse-items'

const collection = 'tracks'
/** --ds-head, --ds-row-media and --ds-row. */
const headerHeight = 28
const listRowHeight = 48
const tableRowHeight = 32
const noun = { one: 'track', other: 'tracks' }

export default function TrackBrowser() {
  const { apiBaseUrl } = useConfig()
  const searchParams = useSearchParams()
  const [ready, setReady] = useState(false)
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
  const view = parseBrowseView(
    searchParams.get('view'),
    defaultBrowseView('track'),
  )
  const density = useGridDensity(searchParams.get('density'))
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
  const fields = useTrackBrowseFields()
  const sortField = fields.find((field) => field.key === sortBy)
  const columnKeys = [
    ...new Set([
      'title',
      ...(searchParams.get('columns')?.split(',').map(canonicalBrowseKey) ??
        defaultTrackColumns),
    ]),
  ]
  const columnOrder = parseColumnOrder(searchParams.get('columnOrder'))
  const orderedFields = orderColumns(fields, columnOrder, 'title')
  const columns = orderedFields.filter((field) =>
    columnKeys.includes(field.key),
  )
  const widths = useColumnWidths(collection, (field) =>
    field.key === 'title' ? 280 : field.type === 'text' ? 180 : 110,
  )
  const queryKey = JSON.stringify({
    q,
    filters,
    ranges,
    sortBy,
    direction,
    ...creator,
  })
  const scrollIdentity = `${collection}:${queryKey}:${view}`
  const mobile = viewport.width <= 700
  // A compact card is too narrow for tags or a value beside the year.
  const compactCards = density === 'compact'
  const grid = itemGridGeometry({
    width: viewport.width,
    min: gridCardMin('track', density),
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
    const next = withTrackFilter(filters, filter)
    setParams({ filters: JSON.stringify(next) }, !keepOpen)
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
      direction: nextSortDirection(fields, key, { sortBy, direction }),
    })
  }

  useEffect(() => {
    try {
      const saved = restoreSavedBrowse(window.localStorage, collection)
      if (!window.location.search && saved)
        window.history.replaceState(null, '', `/${collection}?${saved}`)
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
        ?.querySelector('[aria-selected="true"]')
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
    headerHeight:
      view === 'table' || (view === 'list' && !mobile) ? headerHeight : 0,
    itemSchema: TrackListItemSchema,
  })
  const { total, slots, padTop, padBottom } = query
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
      inspector?.replace({ kind: 'track', id: next.id })
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  })

  function playPair(
    item: TrackListItem,
    index: number,
    place: 'tile' | 'row' = 'row',
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
      <LibraryTrackPlayButton
        track={item}
        place={place}
        source={() =>
          query.isCounting
            ? query.resolveTotal(index).then(source)
            : source(total)
        }
      />
    )
  }

  function trackLink(item: TrackListItem, className?: string) {
    return (
      <DetailLink
        kind="track"
        id={item.id}
        className={className}
        title={item.title}
      >
        {item.title}
      </DetailLink>
    )
  }

  function renderValue(item: TrackListItem, field: BrowseField, index: number) {
    if (field.key === 'title')
      return (
        <span className="ds-cell-id">
          <ItemThumb
            kind="track"
            src={item.artworkUrl}
            title={item.title}
            target={{ kind: 'track', id: item.id }}
          />
          {trackLink(item, 'ds-cell-title')}
          {playPair(item, index)}
        </span>
      )
    return <TrackBrowseValue track={item} field={field} onFilter={addFilter} />
  }

  function cardMeta(item: TrackListItem) {
    const values = getTrackBrowseValues(item)
    const sorted =
      sortBy === 'releaseDate'
        ? null
        : sortedValueLabel(sortField, values[sortBy])
    return (
      <>
        <span>{item.releaseDate?.slice(0, 4) ?? EMPTY_VALUE}</span>
        {!compactCards && (
          <span>{sorted ?? formatTrackDuration(item.durationSec)}</span>
        )}
      </>
    )
  }

  const activeFilterCount =
    Number(Boolean(q)) +
    Number(Boolean(creator)) +
    filters.length +
    ranges.length
  const filterPills =
    activeFilterCount > 0 ? (
      <TrackBrowseFilterChips
        q={q}
        creator={creator}
        filters={filters}
        ranges={ranges}
        fields={fields}
        setParams={setParams}
      />
    ) : null

  return (
    <section className="media-browser" aria-label={collection}>
      <div className="browse-main">
        <BrowseToolbar
          search={
            <TrackBrowseSearch
              fields={fields}
              filters={filters}
              creator={creator}
              queryIdentity={queryKey}
              onOpenItem={openDetail}
              onAddFilter={addFilter}
              setParams={setParams}
              ready={ready}
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
              {view === 'table' && (
                <BrowseColumnsSection>
                  <ColumnChoices
                    fields={orderedFields}
                    selected={columnKeys}
                    required="title"
                    onChange={(keys) => setParams({ columns: keys.join(',') })}
                    onOrderChange={(keys) =>
                      setParams({ columnOrder: columnOrderParam(keys, fields) })
                    }
                    onResetOrder={
                      hasCustomColumnOrder(orderedFields, fields, 'title')
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
          noun="tracks"
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
                        kind="track"
                        src={item.artworkUrl}
                        title={item.title}
                        target={{ kind: 'track', id: item.id }}
                        overlay={playPair(item, index, 'tile')}
                      />
                    }
                    title={<CardTitle>{trackLink(item)}</CardTitle>}
                    by={<TrackArtistLinks track={item} />}
                    meta={cardMeta(item)}
                    tags={
                      compactCards ? undefined : (
                        <TrackBrowseTags track={item} onFilter={addFilter} />
                      )
                    }
                  />
                ) : (
                  <CardSkeleton key={`slot-${index}`} />
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
                  title="Track"
                  tags="Tags"
                  meta={
                    <>
                      <RowValue kind="num">Duration</RowValue>
                      <RowValue kind="num">Scrobbles</RowValue>
                      <RowValue kind="date">Added</RowValue>
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
                        kind="track"
                        src={item.artworkUrl}
                        title={item.title}
                        target={{ kind: 'track', id: item.id }}
                      />
                    }
                    title={<RowTitle>{trackLink(item)}</RowTitle>}
                    by={
                      <>
                        <TrackArtistLinks track={item} />
                        {(item.album || item.albumName) && (
                          <>
                            {' '}
                            · <TrackBrowseAlbum track={item} />
                          </>
                        )}
                      </>
                    }
                    play={playPair(item, index)}
                    tags={<TrackBrowseTags track={item} onFilter={addFilter} />}
                    meta={
                      <>
                        <RowValue kind="num">
                          {formatTrackDuration(item.durationSec)}
                        </RowValue>
                        <RowValue kind="num">
                          {formatCount(item.scrobbles)}
                        </RowValue>
                        <RowValue kind="date">
                          {formatDate(item.dateAdded)}
                        </RowValue>
                      </>
                    }
                  />
                ) : (
                  <RowSkeleton key={`slot-${index}`} />
                ),
              )}
            </VirtualRows>
          ) : (
            <table
              className="ds-table"
              data-layout="fixed"
              aria-label="Tracks"
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
                          sticky={field.key === 'title' ? 0 : undefined}
                          stickyEdge={field.key === 'title'}
                          title={formatFieldValue(
                            field,
                            getTrackBrowseValues(item)[field.key],
                          )}
                        >
                          {renderValue(item, field, index)}
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
      <DetailInspector
        track={{ onFilter: addFilter }}
        playlist={{
          filterTracks: (playlist) => filterByPlaylist(playlist.name),
        }}
      />
    </section>
  )
}
