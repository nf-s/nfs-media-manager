'use client'

import Link from 'next/link'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import {
  BrowseRangesParamSchema,
  canonicalBrowseKey,
  type BrowseFilter,
} from '@repo/schemas/browse'
import { selectionQueryFields } from '@repo/schemas/film-selection'
import {
  TrackPlayabilitySchema,
  trackPlayabilityLabels,
  type TrackMatchDiagnosticsQuery,
} from '@repo/schemas/match-diagnostics'
import { defaultListeningPeriod } from '@repo/schemas/listening'
import { TrackQuerySchema, type TrackListItem } from '@repo/schemas/tracks'
import { Notice, Skeleton } from '@repo/ui/components/ds/feedback'
import { Select } from '@repo/ui/components/ds/toolbar'
import { Button } from '@repo/ui/components/ui/button'
import {
  TableCell,
  TableHead,
  TableRow,
  TableState,
} from '@repo/ui/components/ui/table'
import {
  EMPTY_VALUE,
  formatAge,
  formatDateTime,
  formatItemCount,
} from '@repo/ui/lib/format'
import { useVirtualTable } from '@/hooks/useVirtualTable'
import { spotifyTrackUri } from '@/utils/album-links'
import { browseFilterHref, browseSearchHref } from '@/utils/browse-items'
import { embeddedBrowseHref } from '@/utils/embedded-browse'
import {
  clearCreatorScope,
  parseCreatorBrowseScope,
} from '@/utils/creator-browse'
import { updateJobSelection } from '@/utils/job-selection'
import {
  listeningScrobblesField,
  listeningScrobblesKey,
  parseListeningParams,
} from '@/utils/listening-filters'
import { loadTrackMatchDiagnosticsPage } from '@/utils/match-diagnostics'
import {
  orderedTrackBrowseFields,
  parseTrackFilters,
  withTrackFilter,
} from '@/utils/track-browse'
import { DetailLink } from './detail-link'
import {
  replaceWorkspaceUrl,
  useDetailInspector,
} from './detail-inspector-context'
import {
  providerFreshnessLabel,
  providerFreshnessOptions,
  providerFreshnessValue,
  selectionFieldWidth,
  updateProviderFreshness,
} from './film-selection-table'
import { ListeningControls } from './listening-controls'
import MetadataSelectionToolbar from './metadata-selection-toolbar'
import { useConfig } from './providers'
import {
  SecondaryCell,
  SecondaryColumnFilter,
  SecondaryTableHead,
  SecondaryTableScroll,
  SecondaryVirtualRows,
  useTableColumns,
} from './secondary-table'
import {
  SpotifyTrackSearchJobCell,
  SpotifyTrackSearchReview,
  SpotifyTrackSearchSelectionBar,
  isActiveSpotifyTrackSearch,
  useSpotifyTrackSearchStatusForPages,
} from './spotify-track-search'
import { TrackBrowseValue } from './track-browse-cells'
import { TrackBrowseSearch } from './track-browse-controls'

const selectionWidth = 36
const pageSize = 50
const searchColumn = 'spotifyLastSearch'
const searchColumnLabel = 'Spotify · Last searched'
/** Room for the search status, its result or Review matches, and its age. */
const searchColumnWidth = 260
const defaultColumns = ['title', 'artist', 'album', 'dateAdded']
const trackNoun = { one: 'track', other: 'tracks' }
const searchFreshnessOptions = providerFreshnessOptions.map((option) =>
  option.value === 'unscraped'
    ? { ...option, label: 'No successful search' }
    : option,
)

export default function TrackMetadataTable({
  filters: library,
}: {
  filters?: ReactNode
}) {
  const { apiBaseUrl } = useConfig()
  const path = usePathname()
  const params = useSearchParams()
  const inspector = useDetailInspector()
  const [pending, setPending] = useState(false)
  const [review, setReview] = useState<TrackListItem | null>(null)
  const [matched, setMatched] = useState<string | null>(null)
  const { listening, listeningSort } = parseListeningParams(params)
  const fields = [
    ...orderedTrackBrowseFields,
    listeningScrobblesField(listeningSort),
  ]
  const columns = useTableColumns('track-metadata-selection', [
    ...fields.map((field) => ({
      key: field.key,
      label: field.label,
      width: selectionFieldWidth(field),
      fill: field.key === 'title',
      defaultVisible: defaultColumns.includes(field.key),
      required: field.key === 'title',
    })),
    {
      key: searchColumn,
      label: searchColumnLabel,
      width: searchColumnWidth,
      required: true,
    },
  ])
  const visible = fields.filter((field) => columns.visible(field.key))
  const colSpan = visible.length + 2
  const layout = columns.layout([
    selectionWidth,
    ...visible.map((field) => field.key),
    searchColumn,
  ])
  const creator = parseCreatorBrowseScope(params, 'track')
  const q = params.get('q')?.slice(0, 200) ?? ''
  const filters = parseTrackFilters(params.get('filters'))
  const rangeParam = BrowseRangesParamSchema.safeParse(params.get('ranges'))
  const ranges = rangeParam.success ? rangeParam.data : []
  const freshParam = selectionQueryFields.freshness.safeParse(
    params.get('freshness') ?? undefined,
  )
  const freshness = freshParam.success
    ? freshParam.data.filter(
        (filter) => filter.provider === 'spotify' && filter.mode !== 'all',
      )
    : []
  const playabilityParam = TrackPlayabilitySchema.safeParse(
    params.get('playability'),
  )
  const playability = playabilityParam.success
    ? playabilityParam.data
    : 'unavailable'
  const limitParam = TrackQuerySchema.shape.limitResults.safeParse(
    params.get('limitResults') ?? undefined,
  )
  const limitResults = limitParam.success ? limitParam.data : undefined
  const requestedSort = canonicalBrowseKey(params.get('sortBy') ?? 'dateAdded')
  const sortBy =
    requestedSort === searchColumn ||
    fields.some((field) => field.key === requestedSort)
      ? requestedSort
      : 'dateAdded'
  const direction = params.get('direction') === 'asc' ? 'asc' : 'desc'
  const query: Omit<TrackMatchDiagnosticsQuery, 'page' | 'size'> = {
    q,
    filters,
    ranges,
    freshness,
    playability,
    sortBy,
    direction,
    limitResults,
    listening,
    listeningSort:
      sortBy === listeningScrobblesKey || columns.visible(listeningScrobblesKey)
        ? (listeningSort ?? defaultListeningPeriod)
        : undefined,
    view: 'spotify-search-metadata',
    ...creator,
  }
  const identity = JSON.stringify(query)
  const [selected, setSelected] = useState<string[]>([])
  const [anchor, setAnchor] = useState<string | null>(null)
  const selectAll = useRef<HTMLInputElement>(null)
  const tracks = useVirtualTable({
    queryKey: ['tracks', 'metadata-selection', identity],
    pageSize,
    loadPage: (page, size, signal) =>
      loadTrackMatchDiagnosticsPage(
        apiBaseUrl,
        { ...query, page, size },
        signal,
      ),
  })
  const status = useSpotifyTrackSearchStatusForPages(tracks.windowPageItems)
  const ids = tracks.loadedSlots.flatMap(({ item }) => {
    const { track } = item
    const job = track ? status.byId.get(track.id)?.job : undefined
    return track &&
      !item.spotifyAlternate &&
      !spotifyTrackUri(track.spotifyTrackId) &&
      !isActiveSpotifyTrackSearch(job)
      ? [track.id]
      : []
  })
  const checked = ids.length > 0 && ids.every((id) => selected.includes(id))
  const mixed = !checked && ids.some((id) => selected.includes(id))
  useEffect(() => {
    setSelected([])
    setAnchor(null)
  }, [identity])
  useEffect(() => {
    if (selectAll.current) selectAll.current.indeterminate = mixed
  }, [mixed])

  function setParams(updates: Record<string, string | null>) {
    if (pending) return
    const next = new URLSearchParams(window.location.search)
    for (const [key, value] of Object.entries(updates)) {
      if (value) next.set(key, value)
      else next.delete(key)
    }
    replaceWorkspaceUrl(`${path}${next.size ? `?${next}` : ''}`, true)
  }
  function addFilter(filter: BrowseFilter) {
    setParams({ filters: JSON.stringify(withTrackFilter(filters, filter)) })
  }
  const browseHref = embeddedBrowseHref(
    'tracks',
    { ...creator },
    new URLSearchParams(params),
  )
  function filterHref(filter: BrowseFilter) {
    return browseFilterHref(browseHref, withTrackFilter(filters, filter))
  }
  function sort(key: string) {
    setParams({
      sortBy: key,
      direction: key === sortBy && direction === 'desc' ? 'asc' : 'desc',
    })
  }
  function select(ids: string[], nextAnchor = anchor) {
    setSelected(ids)
    setAnchor(ids.length ? nextAnchor : null)
  }
  const filterChips = [
    ...freshness.map((filter) => ({
      key: `spotify:${providerFreshnessValue(filter)}`,
      label: `Spotify · ${filter.mode === 'unscraped' ? 'No successful search' : providerFreshnessLabel(filter)}`,
      remove: () =>
        setParams({
          freshness: JSON.stringify(
            freshness.filter((item) => item !== filter),
          ),
        }),
    })),
    ...(playability === 'all'
      ? []
      : [
          {
            key: 'playability',
            label: trackPlayabilityLabels[playability],
            remove: () => setParams({ playability: 'all' }),
          },
        ]),
    ...(creator
      ? [
          {
            key: 'creator',
            label: 'Artist filter',
            remove: () => setParams(clearCreatorScope),
          },
        ]
      : []),
  ]
  const listeningParams = new URLSearchParams({
    q,
    filters: JSON.stringify(filters),
    ranges: JSON.stringify(ranges),
    ...creator,
  })
  return (
    <div className="ops-fill">
      <MetadataSelectionToolbar
        disabled={pending}
        fields={fields}
        value={{ q, filters, ranges, limitResults, listening }}
        filterHref={(filter) => browseFilterHref(browseHref, [filter])}
        providerFilters={filterChips}
        onChange={(next) =>
          setParams({
            q: next.q,
            filters: JSON.stringify(next.filters),
            ranges: JSON.stringify(next.ranges),
            limitResults:
              next.limitResults === undefined
                ? null
                : String(next.limitResults),
            listening: next.listening ? JSON.stringify(next.listening) : null,
          })
        }
        onClear={() =>
          setParams({
            q: null,
            filters: null,
            ranges: null,
            freshness: null,
            playability: 'all',
            limitResults: null,
            listening: null,
            ...clearCreatorScope,
          })
        }
        search={
          <TrackBrowseSearch
            fields={fields}
            filters={filters}
            creator={creator}
            queryIdentity={identity}
            onOpenItem={(id, trigger) =>
              inspector?.open({ kind: 'track', id }, trigger)
            }
            onAddFilter={addFilter}
            filterHref={filterHref}
            searchHref={(value) => browseSearchHref(browseHref, { q: value })}
            setParams={setParams}
            disabled={pending}
          />
        }
        filters={
          <>
            {library}
            <Button asChild size="xs">
              <Link href="/tracks/spotify-match-audit">
                Spotify match audit
              </Link>
            </Button>
            <Select
              aria-label="Playability"
              value={playability}
              onChange={(event) =>
                setParams({ playability: event.target.value })
              }
            >
              {Object.entries(trackPlayabilityLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </>
        }
        count={
          tracks.hasTotal
            ? formatItemCount(tracks.total, trackNoun)
            : 'Counting...'
        }
        columns={columns.controls}
      >
        <ListeningControls
          apiBaseUrl={apiBaseUrl}
          library="track"
          params={listeningParams}
          filter={listening}
          sortPeriod={listeningSort}
          total={tracks.hasTotal ? tracks.total : undefined}
          examples={tracks.slots
            .flatMap(({ item }) => (item?.track ? [item.track] : []))
            .slice(0, 3)
            .map((track) => ({
              id: track.id,
              title: track.title,
              artworkUrl: track.artworkUrl,
              by: track.artists.join(', '),
            }))}
          onFilterChange={(next) =>
            setParams({ listening: next ? JSON.stringify(next) : null })
          }
          onSortPeriodChange={(period) =>
            setParams({ listeningSort: JSON.stringify(period) })
          }
        />
      </MetadataSelectionToolbar>
      {(tracks.isError || status.isError || matched) && (
        <div className="ops-notice">
          {tracks.isError && (
            <Notice
              tone="danger"
              action={
                <Button size="xs" onClick={tracks.retry}>
                  Retry
                </Button>
              }
            >
              Could not load tracks.
            </Notice>
          )}
          {status.isError && (
            <Notice
              tone="danger"
              action={
                <Button size="xs" onClick={status.retry}>
                  Retry
                </Button>
              }
            >
              Could not load Spotify search results.
            </Notice>
          )}
          {matched && (
            <p className="ds-muted" role="status">
              Spotify match saved.{' '}
              <DetailLink kind="track" id={matched} tab="sources">
                Open track
              </DetailLink>
            </p>
          )}
        </div>
      )}
      <SecondaryTableScroll
        ref={tracks.scroller}
        onScroll={tracks.onScroll}
        role="region"
        aria-label="Track metadata results"
        aria-busy={tracks.isFetching}
      >
        <table
          className="ds-table"
          aria-label="Track metadata"
          aria-rowcount={tracks.hasTotal ? tracks.total + 1 : undefined}
          {...layout.table}
        >
          {layout.colgroup}
          <thead>
            <TableRow>
              <TableHead sticky={0}>
                <input
                  ref={selectAll}
                  type="checkbox"
                  className="ds-check"
                  aria-label="Select all loaded tracks needing a Spotify match"
                  checked={checked}
                  disabled={pending || tracks.isError || !ids.length}
                  onChange={() =>
                    select(
                      checked ? [] : [...new Set([...selected, ...ids])],
                      null,
                    )
                  }
                />
              </TableHead>
              {visible.map((field) => (
                <SecondaryTableHead
                  key={field.key}
                  sortKey={field.key}
                  label={field.label}
                  sortBy={sortBy}
                  direction={direction}
                  onSort={sort}
                  disabled={pending}
                  align={field.type === 'number' ? 'end' : undefined}
                  sticky={field.key === 'title' ? selectionWidth : undefined}
                  stickyEdge={field.key === 'title'}
                  resizer={columns.resizer(field.key)}
                />
              ))}
              <SecondaryTableHead
                sortKey={searchColumn}
                label={searchColumnLabel}
                sortBy={sortBy}
                direction={direction}
                onSort={sort}
                disabled={pending}
                resizer={columns.resizer(searchColumn)}
                filter={
                  <SecondaryColumnFilter
                    label="Spotify search freshness"
                    options={searchFreshnessOptions}
                    value={freshness.map(providerFreshnessValue)}
                    onChange={(next) =>
                      setParams({
                        freshness: JSON.stringify(
                          updateProviderFreshness(freshness, 'spotify', next),
                        ),
                      })
                    }
                    disabled={pending}
                  />
                }
              />
            </TableRow>
          </thead>
          <tbody>
            {tracks.hasTotal && !tracks.total && (
              <TableState colSpan={colSpan}>No matching tracks.</TableState>
            )}
            {(!tracks.isError || tracks.hasTotal) && (
              <SecondaryVirtualRows
                window={tracks}
                colSpan={colSpan}
                renderRow={({ track }, index) => {
                  if (!track) return null
                  const search = status.byId.get(track.id)
                  const date = search?.lastSuccessfulAt
                  return (
                    <TableRow
                      key={track.id}
                      aria-rowindex={index + 2}
                      selected={selected.includes(track.id)}
                    >
                      <TableCell sticky={0}>
                        <input
                          type="checkbox"
                          className="ds-check"
                          aria-label={`Select ${track.title}`}
                          checked={selected.includes(track.id)}
                          disabled={
                            pending || tracks.isError || !ids.includes(track.id)
                          }
                          onChange={(event) => {
                            const shift =
                              'shiftKey' in event.nativeEvent &&
                              event.nativeEvent.shiftKey === true
                            select(
                              updateJobSelection(
                                selected,
                                ids,
                                track.id,
                                anchor,
                                shift,
                                event.target.checked,
                              ),
                              track.id,
                            )
                          }}
                        />
                      </TableCell>
                      {visible.map((field) => (
                        <TableCell
                          key={field.key}
                          align={field.type === 'number' ? 'end' : undefined}
                          sticky={
                            field.key === 'title' ? selectionWidth : undefined
                          }
                          stickyEdge={field.key === 'title'}
                        >
                          {field.key === 'title' ? (
                            <SecondaryCell text={track.title}>
                              <DetailLink kind="track" id={track.id}>
                                {track.title}
                              </DetailLink>
                            </SecondaryCell>
                          ) : (
                            <TrackBrowseValue
                              track={track}
                              field={field}
                              onFilter={addFilter}
                              filterHref={filterHref}
                            />
                          )}
                        </TableCell>
                      ))}
                      <TableCell>
                        <div className="secondary-cell-actions">
                          {!search ? (
                            status.isError ? (
                              EMPTY_VALUE
                            ) : (
                              <Skeleton width={40} height={12} />
                            )
                          ) : (
                            <SpotifyTrackSearchJobCell
                              job={search.job}
                              disabled={pending}
                              onReview={() => setReview(track)}
                            />
                          )}
                          {date && (
                            <time
                              className="ds-muted"
                              dateTime={date}
                              title={`Last successful search ${formatDateTime(date)}`}
                            >
                              {formatAge(date)}
                            </time>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                }}
              />
            )}
          </tbody>
        </table>
      </SecondaryTableScroll>
      <SpotifyTrackSearchSelectionBar
        selectedIds={selected}
        onSelect={select}
        onPendingChange={setPending}
        freshness={freshness.length ? freshness : undefined}
        disabled={tracks.isError}
        total={tracks.hasTotal ? tracks.total : undefined}
      />
      {review && (
        <SpotifyTrackSearchReview
          track={review}
          onClose={() => setReview(null)}
          onMatched={(id) => {
            setReview(null)
            setMatched(id)
          }}
        />
      )}
    </div>
  )
}
