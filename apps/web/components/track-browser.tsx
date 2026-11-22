'use client'

import { useRestoreBrowsePreferences } from './workspace-tab-context'
import { TrackArtistLinks } from './creator-links'
import {
  clearCreatorScope,
  parseCreatorBrowseScope,
  type CreatorBrowseScope,
} from '@/utils/creator-browse'

import ManualMediaAdd from './manual-media-add'
import { DetailInspector } from './detail-inspector'
import { DetailListFrame } from './detail-list-frame'
import { useDetailInspector } from './detail-inspector-context'
import { sameDetail } from '@/utils/detail-inspector'
import { fitDetailList } from '@/utils/detail-list-space'

import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import Link from 'next/link'
import { useQueryClient } from '@tanstack/react-query'
import { Button } from '@repo/ui/components/ui/button'
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TablePartSlot,
  TablePartTitle,
  TablePartToggle,
  TableRow,
  TableScroll,
  columnWidth,
} from '@repo/ui/components/ui/table'
import { Card, CardTitle } from '@repo/ui/components/ds/card'
import { ProviderMark } from '@repo/ui/components/ds/pill'
import {
  List,
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
  useEmbeddedBrowse,
  usePageBrowse,
  type BrowseHost,
} from '@/hooks/useBrowseHost'
import { embeddedScrollClass } from '@/utils/embedded-browse'
import {
  orderedTrackBrowseFields,
  defaultTrackColumns,
  formatTrackDuration,
  parseTrackFilters,
  trackGroupingEnabled,
  withTrackFilter,
} from '@/utils/track-browse'
import {
  browseFilterHref,
  browseSearchHref,
  columnOrderParam,
  hasCustomColumnOrder,
  formatFieldValue,
  gridRowGap,
  itemGridGeometry,
  nextSortDirection,
  orderColumns,
  parseColumnOrder,
  sortedValueLabel,
} from '@/utils/browse-items'
import { playlistFilter } from '@/utils/playlist-links'
import {
  defaultListeningPeriod,
  type ListeningFilter,
} from '@repo/schemas/listening'
import {
  listeningScrobblesField,
  listeningScrobblesKey,
  parseListeningParams,
} from '@/utils/listening-filters'
import { RangeEditor } from './browse-controls'
import { ListeningControls, ListeningFilterPills } from './listening-controls'
import {
  TrackBrowseAlbum,
  TrackBrowseTags,
  TrackBrowseValue,
} from './track-browse-cells'
import {
  TrackBrowseFilterChips,
  TrackBrowseSearch,
} from './track-browse-controls'
import BrowseToolbar, { BrowseColumnsSection } from './browse-toolbar'
import {
  RecordingVersionsPager,
  RecordingVersionsStatus,
  RecordingVersionsToggle,
  useTrackRecordingVersions,
} from './track-recording-versions'
import { LibraryTrackPlayButton } from './play-controls'
import {
  RowSelectAll,
  RowSelectRow,
  rowSelectionWidth,
  useRowSelection,
} from './merge-bar'
import { TrackMergeBar } from './track-merge-bar'
import { providerLogoUrl } from '@/utils/provider-logos'
import {
  createBrowsePlaybackSource,
  createPendingTrackBrowseSource,
  type TrackBrowsePage,
} from '@/utils/playback-source'
import {
  defaultBrowseView,
  gridCardMin,
  parseBrowseView,
  preserveGridScroll,
  restoreSavedBrowse,
} from '@/utils/media-grid'
import { useGridDensity } from '@/hooks/useGridDensity'
import { useColumnWidths } from '@/hooks/useColumnWidths'
import { DetailLink } from './detail-link'
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

const collection = 'tracks'
/** --ds-head, --ds-row-media and --ds-row. */
const headerHeight = 28
const listRowHeight = 48
const tableRowHeight = 32
const noun = { one: 'track', other: 'tracks' }

/** The provider whose mark stands before a version's title. */
function versionMark(item: TrackListItem) {
  const provider =
    item.spotifyTrackId !== null
      ? { id: 'spotify', name: 'Spotify' }
      : item.sources.includes('lastfm')
        ? { id: 'lastfm', name: 'Last.fm' }
        : null
  return provider ? (
    <ProviderMark
      name={provider.name}
      src={providerLogoUrl(provider.id)}
      hidden
    />
  ) : (
    <ProviderMark name="Library" hidden />
  )
}

/**
 * The identity cell of a version's part row: the provider mark, the title,
 * Shown on the version the record's row is shown as, then the play pair.
 */
export function TrackVersionTitle({
  track,
  shown,
}: {
  track: TrackListItem
  shown: boolean
}) {
  return (
    <span className="ds-cell-id">
      <TablePartTitle mark={versionMark(track)}>
        <DetailLink kind="track" id={track.id} title={track.title}>
          {track.title}
        </DetailLink>
        {shown && (
          <>
            {' '}
            <span className="ds-cell-sub">Shown</span>
          </>
        )}
      </TablePartTitle>
      <LibraryTrackPlayButton track={track} />
    </span>
  )
}

export default function TrackBrowser() {
  return <TrackBrowse host={usePageBrowse(collection)} />
}

/**
 * The Tracks browser inside a detail, held to one creator's tracks. It has
 * every control of the Tracks page; Show in Tracks shows the same result there.
 */
export function EmbeddedTrackBrowser({
  creator,
  storage,
}: {
  creator: CreatorBrowseScope
  /** Names the list's view and column widths in browser storage. */
  storage: string
}) {
  const host = useEmbeddedBrowse(
    collection,
    {
      scope: creator,
      storage,
      mediaType: 'album',
      sort: { key: 'title', direction: 'asc' },
    },
    defaultBrowseView('track'),
  )
  return <TrackBrowse host={host} scope={creator} />
}

function TrackBrowse({
  host,
  scope,
}: {
  host: BrowseHost
  /** The creator a list inside a detail is held to. */
  scope?: CreatorBrowseScope
}) {
  const { apiBaseUrl } = useConfig()
  const { embedded } = host
  const searchParams = host.params
  const restoreBrowsePreferences = useRestoreBrowsePreferences()
  const [adding, setAdding] = useState(false)
  const [ready, setReady] = useState(embedded)
  const [scroll, setScroll] = useState({ identity: '', top: 0 })
  const [viewport, setViewport] = useState({ width: 1000, height: 800 })
  const [gridLayout, setGridLayout] = useState<{
    identity: string
    columns: number
    rowHeight: number
  } | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const detailList = useRef<HTMLDivElement>(null)
  const inspector = useDetailInspector()
  const pageRail = useRailSlot()
  // Inside a detail the active filters sit in a row above the results.
  const railSlot = embedded ? null : pageRail
  const view = parseBrowseView(
    searchParams.get('view'),
    defaultBrowseView('track'),
  )
  const density = useGridDensity(searchParams.get('density'))
  const filters = parseTrackFilters(searchParams.get('filters'))
  const creator = scope ?? parseCreatorBrowseScope(searchParams, 'track')
  const rangesResult = BrowseRangesParamSchema.safeParse(
    searchParams.get('ranges'),
  )
  const ranges = rangesResult.success ? rangesResult.data : []
  const q = searchParams.get('q') ?? ''
  const sortBy = canonicalBrowseKey(searchParams.get('sortBy') ?? 'dateAdded')
  const direction = searchParams.get('direction') === 'asc' ? 'asc' : 'desc'
  const groupRecordings = trackGroupingEnabled(
    sortBy,
    searchParams.get('groupRecordings'),
  )
  // One drawer at a time: the playlist drawer covers the track drawer.
  const selectedId =
    !embedded && inspector?.root?.kind === 'track' ? inspector.root.id : null
  const { listening, listeningSort } = parseListeningParams(searchParams)
  const fields = [
    ...orderedTrackBrowseFields,
    listeningScrobblesField(listeningSort),
  ]
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
  const widths = useColumnWidths(
    host.storage,
    (field: BrowseField) =>
      field.key === 'title' ? 280 : field.type === 'text' ? 180 : 110,
    // Leave room for the title, disclosure and playback controls on grouped rows.
    groupRecordings ? { title: 180 } : undefined,
  )
  const selectionColumnWidth = columnWidth(rowSelectionWidth)
  const fieldWidths = columns.map((field) => {
    const width = columnWidth(widths.widthFor(field))
    // Keep part of the horizontally scrolling columns visible beside the pinned selection and title.
    return groupRecordings && field.key === 'title'
      ? `min(${width}, max(0px, ${viewport.width}px - ${selectionColumnWidth} - 2 * var(--ds-8)))`
      : width
  })
  const tableWidths = [selectionColumnWidth, ...fieldWidths]
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
    listening,
    listeningSort: requestedListeningPeriod,
    ...(groupRecordings ? { groupRecordings } : {}),
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
    host.update((params) => {
      if (
        Object.hasOwn(updates, 'sortBy') &&
        canonicalBrowseKey(updates.sortBy ?? 'dateAdded') !== sortBy
      )
        params.delete('groupRecordings')
      for (const [key, value] of Object.entries(updates)) {
        if (value === null || value === '') params.delete(key)
        else params.set(key, value)
      }
    }, close)
  }
  function addFilter(filter: BrowseFilter, keepOpen = false) {
    const next = withTrackFilter(filters, filter)
    setParams({ filters: JSON.stringify(next) }, !keepOpen)
  }
  const browseHref = host.browseHref ?? `/${collection}?${searchParams}`
  function filterHref(filter: BrowseFilter) {
    return browseFilterHref(browseHref, withTrackFilter(filters, filter))
  }
  function artistFilterHref(value: string) {
    return filterHref({ field: 'artist', value })
  }
  function clearFilters() {
    setParams({
      q: null,
      filters: null,
      ranges: null,
      listening: null,
      ...(scope ? {} : clearCreatorScope),
    })
  }
  function changeListening(next: ListeningFilter | undefined) {
    setParams({ listening: next ? JSON.stringify(next) : null })
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
    // The saved Browse state belongs to the Tracks page.
    if (embedded) return
    try {
      const saved = restoreSavedBrowse(window.localStorage, collection)
      if (saved) restoreBrowsePreferences(`/${collection}?${saved}`)
    } catch {
      /* Ignore unavailable storage or malformed saved preferences. */
    }
    setReady(true)
  }, [embedded, restoreBrowsePreferences])
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
    if (embedded && detailList.current) return fitDetailList(detailList.current)
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
    // Ticked table rows are selected too; the open track's row is marked.
    if (selectedId)
      scroller.current
        ?.querySelector('tr[data-open], [aria-selected="true"]:not(tr)')
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
  if (groupRecordings) params.set('groupRecordings', 'true')
  if (listening) params.set('listening', JSON.stringify(listening))
  if (requestedListeningPeriod)
    params.set('listeningSort', JSON.stringify(requestedListeningPeriod))
  const versions = useTrackRecordingVersions(apiBaseUrl, queryKey, params)
  const expanded = versions.expanded
  const gridRow = expanded ? Math.floor(expanded.index / grid.columns) : -1
  const versionsHeight =
    versions.rowCount * (view === 'table' ? tableRowHeight : listRowHeight)
  const extraRowHeights = expanded
    ? new Map([
        [
          view === 'grid' ? gridRow : expanded.index,
          versionsHeight + (view === 'grid' ? gridRowGap : 0),
        ],
      ])
    : undefined
  const queryClient = useQueryClient()
  const query = useVirtualBrowse({
    performanceScreen: embedded ? undefined : 'tracks',
    apiBaseUrl,
    collection,
    identity: queryKey,
    params,
    enabled: ready,
    columns: view === 'grid' ? grid.columns : 1,
    rowHeight,
    scrollTop,
    viewportHeight: viewport.height,
    extraRowHeights,
    headerHeight:
      view === 'table' || (view === 'list' && !mobile) ? headerHeight : 0,
    itemSchema: TrackListItemSchema,
  })
  const { total, slots, padTop, padBottom } = query
  const expandedSlot = slots.find(
    ({ index }) => index === expanded?.index,
  )?.item
  const expandedVisible =
    expandedSlot?.id === expanded?.id && Boolean(expandedSlot?.recordingGroup)
  const collapseVersions = versions.collapse
  useEffect(() => {
    if (expandedSlot && !expandedVisible) collapseVersions()
  }, [collapseVersions, expandedSlot, expandedVisible])
  // The loaded table rows in order, with open release versions under their track.
  const loadedIds = [
    ...new Set(
      slots.flatMap(({ item }) =>
        item
          ? [
              item.id,
              ...(expanded?.id === item.id
                ? versions.items.map((version) => version.id)
                : []),
            ]
          : [],
      ),
    ),
  ]
  const selection = useRowSelection(loadedIds)
  // Another search, filter, sort, scope or view lists other tracks.
  const [selectionIdentity, setSelectionIdentity] = useState(scrollIdentity)
  if (selectionIdentity !== scrollIdentity) {
    setSelectionIdentity(scrollIdentity)
    selection.clear()
  }
  const gridPanelAfter = Math.min(query.end, (gridRow + 1) * grid.columns) - 1
  const gridRowTemplate = expandedVisible
    ? `repeat(${gridRow - query.start / grid.columns + 1}, ${grid.cardHeight}px) ${versionsHeight}px`
    : undefined
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
      const visibleIds = slots.flatMap(({ item }) => [
        item?.id,
        ...(expanded && expanded.id === item?.id
          ? versions.items
              .filter((version) => version.id !== expanded.id)
              .map((version) => version.id)
          : []),
      ])
      const current = visibleIds.indexOf(selectedId)
      const next = visibleIds[current + (event.key === 'ArrowDown' ? 1 : -1)]
      if (current < 0 || !next) return
      event.preventDefault()
      inspector?.replace({ kind: 'track', id: next })
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  })

  function playPair(
    item: TrackListItem,
    index: number,
    place: 'tile' | 'row' = 'row',
  ) {
    const href =
      host.browseHref ?? `/tracks?${searchParams.size ? searchParams : params}`
    const sourceOptions = {
      apiBaseUrl,
      params,
      href,
      label: 'Tracks',
      startIndex: index,
      initialItem: item,
    }
    return (
      <LibraryTrackPlayButton
        track={item}
        place={place}
        source={() =>
          query.hasTotal && query.conflictingPage === undefined
            ? createBrowsePlaybackSource({
                ...sourceOptions,
                collection: 'tracks',
                total,
              })
            : createPendingTrackBrowseSource(
                {
                  ...sourceOptions,
                  getCachedPage: (page) =>
                    queryClient.getQueryData<TrackBrowsePage>([
                      collection,
                      'browse',
                      queryKey,
                      page,
                    ]),
                },
                () => query.resolveTotal(index),
              )
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

  function titleWithVersions(
    item: TrackListItem,
    index: number | undefined,
    title: ReactNode,
  ) {
    return item.recordingGroup && index !== undefined ? (
      <span className="ds-cell-id gap-[var(--ds-1)]">
        {title}
        <RecordingVersionsToggle
          track={item}
          index={index}
          versions={versions}
        />
      </span>
    ) : (
      title
    )
  }

  /** The chevron that opens a grouped row's versions, or its space. */
  function versionsPartToggle(item: TrackListItem, index: number) {
    const group = item.recordingGroup
    if (!group) return <TablePartSlot />
    const open = expanded?.id === item.id
    const label = `${open ? 'Hide' : 'Show'} ${group.versionCount} release versions for ${item.title}`
    return (
      <TablePartToggle
        open={open}
        label={label}
        title={label}
        onOpenChange={() => versions.toggle(item.id, index)}
      />
    )
  }

  function renderValue(
    item: TrackListItem,
    field: BrowseField,
    index: number,
    part: boolean,
  ) {
    if (field.key === 'title' && part)
      return <TrackVersionTitle track={item} shown={item.id === expanded?.id} />
    if (field.key === 'title')
      return (
        <span className="ds-cell-id">
          {groupRecordings && versionsPartToggle(item, index)}
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
    return (
      <TrackBrowseValue
        track={item}
        field={field}
        onFilter={addFilter}
        filterHref={filterHref}
      />
    )
  }

  function renderTrackTableRow(
    item: TrackListItem,
    index: number,
    rowIndex: number,
    part = false,
  ) {
    const open = item.id === selectedId && (!part || expanded?.id !== item.id)
    return (
      <TableRow
        key={item.id}
        data-item-index={part ? undefined : index}
        data-open={open ? '' : undefined}
        selected={open || selection.has(item.id)}
        aria-rowindex={rowIndex}
        part={part}
      >
        <TableCell sticky={0}>
          <RowSelectRow selection={selection} id={item.id} title={item.title} />
        </TableCell>
        {columns.map((field) => (
          <TableCell
            key={field.key}
            align={field.type === 'number' ? 'end' : undefined}
            sticky={field.key === 'title' ? rowSelectionWidth : undefined}
            stickyEdge={field.key === 'title'}
            title={formatFieldValue(
              field,
              getTrackBrowseValues(item)[field.key],
            )}
          >
            {renderValue(item, field, index, part)}
          </TableCell>
        ))}
      </TableRow>
    )
  }

  function renderTrackListRow(item: TrackListItem, index?: number) {
    const child = index === undefined
    return (
      <ListRow
        key={item.id}
        data-item-index={index}
        selected={
          item.id === selectedId && (!child || expanded?.id !== item.id)
        }
        thumb={
          <ItemThumb
            kind="track"
            src={item.artworkUrl}
            title={item.title}
            target={{ kind: 'track', id: item.id }}
          />
        }
        title={titleWithVersions(
          item,
          index,
          <RowTitle>{trackLink(item)}</RowTitle>,
        )}
        by={
          child ? (
            item.album || item.albumName ? (
              <TrackBrowseAlbum track={item} filterHref={filterHref} />
            ) : (
              'Release unknown'
            )
          ) : (
            <>
              <TrackArtistLinks track={item} fallbackHref={artistFilterHref} />
              {(item.album || item.albumName) && (
                <>
                  {' '}
                  · <TrackBrowseAlbum track={item} filterHref={filterHref} />
                </>
              )}
            </>
          )
        }
        play={
          child ? (
            <LibraryTrackPlayButton track={item} />
          ) : (
            playPair(item, index)
          )
        }
        tags={
          <TrackBrowseTags
            track={item}
            onFilter={addFilter}
            filterHref={filterHref}
          />
        }
        meta={
          <>
            <RowValue kind="num">
              {formatTrackDuration(item.durationSec)}
            </RowValue>
            <RowValue kind="num">{formatCount(item.scrobbles)}</RowValue>
            <RowValue kind="date">{formatDate(item.dateAdded)}</RowValue>
          </>
        }
      />
    )
  }

  function renderVersionList(inGrid = false) {
    function renderControls(content: ReactNode) {
      return <ListRow thumb={<span />} title={content} />
    }
    return (
      <List
        role="group"
        aria-label="Release versions"
        compact={mobile}
        style={inGrid ? { gridColumn: '1 / -1' } : undefined}
      >
        {versions.items.length
          ? versions.items.map((item) => renderTrackListRow(item))
          : renderControls(<RecordingVersionsStatus versions={versions} />)}
        {versions.needsPager &&
          renderControls(<RecordingVersionsPager versions={versions} />)}
      </List>
    )
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

  // The creator a list inside a detail is held to is not a filter.
  const creatorFilter = scope ? undefined : creator
  const activeFilterCount =
    Number(Boolean(q)) +
    Number(Boolean(creatorFilter)) +
    filters.length +
    ranges.length +
    (listening?.rules.length ?? 0)
  const filterPills =
    activeFilterCount > 0 ? (
      <>
        <TrackBrowseFilterChips
          q={q}
          creator={creatorFilter}
          filters={filters}
          ranges={ranges}
          fields={fields}
          setParams={setParams}
          filterHref={(filter) => browseFilterHref(browseHref, [filter])}
        />
        <ListeningFilterPills
          library="track"
          filter={listening}
          onChange={changeListening}
        />
      </>
    ) : null

  return (
    <section
      className={embedded ? undefined : 'media-browser'}
      aria-label={collection}
    >
      <div className={embedded ? undefined : 'browse-main'}>
        <BrowseToolbar
          addActions={
            !embedded && (
              <Button type="button" onClick={() => setAdding(true)}>
                Add track
              </Button>
            )
          }
          search={
            <TrackBrowseSearch
              fields={fields}
              filters={filters}
              creator={creator}
              queryIdentity={queryKey}
              onOpenItem={openDetail}
              onAddFilter={addFilter}
              filterHref={filterHref}
              searchHref={(value) => browseSearchHref(browseHref, { q: value })}
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
          viewOptions={
            <label className="ds-checkrow">
              <input
                type="checkbox"
                className="ds-check"
                checked={groupRecordings}
                onChange={(event) =>
                  setParams({
                    groupRecordings: String(event.currentTarget.checked),
                  })
                }
              />
              Group recordings
            </label>
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
                library="track"
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
                    by: <TrackArtistLinks track={item} />,
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
              unfiltered={embedded ? undefined : query.unfilteredTotal}
              noun={noun}
            />
          }
          end={
            host.browseHref && (
              <Button variant="link" asChild>
                <Link href={host.browseHref}>Show in Tracks</Link>
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
        {filterPills && !embedded && (
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
        <DetailListFrame framed={embedded} frame={detailList}>
          <TableScroll
            className={`browse-scroll bi-scroll${embedded ? ` ${embeddedScrollClass}` : ''}`}
            data-view={view}
            data-inspector-scroll={embedded ? '' : undefined}
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
                rowTemplate={gridRowTemplate}
              >
                {slots.map(({ item, index }) => (
                  <Fragment key={item?.id ?? `slot-${index}`}>
                    {item ? (
                      <Card
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
                        title={titleWithVersions(
                          item,
                          index,
                          <CardTitle>{trackLink(item)}</CardTitle>,
                        )}
                        by={
                          <TrackArtistLinks
                            track={item}
                            fallbackHref={artistFilterHref}
                          />
                        }
                        meta={cardMeta(item)}
                        tags={
                          compactCards ? undefined : (
                            <TrackBrowseTags
                              track={item}
                              onFilter={addFilter}
                              filterHref={filterHref}
                            />
                          )
                        }
                      />
                    ) : (
                      <CardSkeleton />
                    )}
                    {expandedVisible &&
                      index === gridPanelAfter &&
                      renderVersionList(true)}
                  </Fragment>
                ))}
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
                    <Fragment key={item.id}>
                      {renderTrackListRow(item, index)}
                      {expanded?.id === item.id && renderVersionList()}
                    </Fragment>
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
                aria-rowcount={
                  query.hasTotal
                    ? total + 1 + (expanded ? versions.rowCount : 0)
                    : undefined
                }
                style={{ width: `calc(${tableWidths.join(' + ')})` }}
              >
                <colgroup>
                  <col style={{ width: selectionColumnWidth }} />
                  {columns.map((field, index) => (
                    <col
                      key={field.key}
                      style={{ width: fieldWidths[index] }}
                    />
                  ))}
                </colgroup>
                <TableHeader>
                  <TableRow>
                    <TableHead sticky={0}>
                      <RowSelectAll
                        selection={selection}
                        label="Select loaded tracks"
                        disabled={!loadedIds.length}
                      />
                    </TableHead>
                    {columns.map((field) => (
                      <BrowseItemsHead
                        key={field.key}
                        field={field}
                        identity={field.key === 'title'}
                        sticky={rowSelectionWidth}
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
                      <td
                        colSpan={tableWidths.length}
                        style={{ height: padTop }}
                      />
                    </tr>
                  )}
                  {slots.map(({ item, index }) => {
                    if (!item)
                      return (
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
                      )
                    const rowIndex =
                      index +
                      2 +
                      (expanded && index > expanded.index
                        ? versions.rowCount
                        : 0)
                    return (
                      <Fragment key={item.id}>
                        {renderTrackTableRow(item, index, rowIndex)}
                        {expanded?.id === item.id &&
                          (versions.items.length ? (
                            versions.items.map((version, offset) =>
                              renderTrackTableRow(
                                version,
                                index,
                                rowIndex + offset + 1,
                                true,
                              ),
                            )
                          ) : (
                            <TableRow child aria-rowindex={rowIndex + 1}>
                              <TableCell
                                colSpan={tableWidths.length}
                                className="ds-muted"
                              >
                                <RecordingVersionsStatus versions={versions} />
                              </TableCell>
                            </TableRow>
                          ))}
                        {expanded?.id === item.id && versions.needsPager && (
                          <TableRow
                            child
                            aria-rowindex={rowIndex + versions.rowCount}
                          >
                            <TableCell colSpan={tableWidths.length}>
                              <RecordingVersionsPager versions={versions} />
                            </TableCell>
                          </TableRow>
                        )}
                      </Fragment>
                    )
                  })}
                  {padBottom > 0 && (
                    <tr className="bi-spacer" aria-hidden="true">
                      <td
                        colSpan={tableWidths.length}
                        style={{ height: padBottom }}
                      />
                    </tr>
                  )}
                </TableBody>
              </table>
            )}
          </TableScroll>
          {view === 'table' && (
            <TrackMergeBar
              selection={selection}
              total={query.hasTotal ? total : undefined}
            />
          )}
        </DetailListFrame>
      </div>
      {adding && (
        <ManualMediaAdd
          mediaType="track"
          onClose={() => setAdding(false)}
          onAdded={(id) => {
            setAdding(false)
            openDetail(id)
          }}
        />
      )}
      {!embedded && (
        <DetailInspector
          track={{ onFilter: addFilter, filterHref }}
          playlist={{
            filterTracks: (playlist) => filterByPlaylist(playlist.name),
          }}
        />
      )}
    </section>
  )
}
