'use client'

import { DetailLink } from './detail-link'
import { AlbumReferencePlayButton } from './play-controls'
import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { Link2, Plus } from 'lucide-react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  LastfmLinkReportSchema,
  type LastfmLinkGroup,
} from '@repo/schemas/lastfm'
import { Button } from '@repo/ui/components/ui/button'
import { Section } from '@repo/ui/components/ds/facts'
import { Notice, Skeleton } from '@repo/ui/components/ds/feedback'
import { Status } from '@repo/ui/components/ds/status'
import {
  Toolbar,
  ToolbarCount,
  ToolbarEnd,
} from '@repo/ui/components/ds/toolbar'
import {
  EMPTY_VALUE,
  formatCount,
  formatDate,
  formatDateTime,
  formatItemCount,
} from '@repo/ui/lib/format'
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableState,
} from '@repo/ui/components/ui/table'
import { useVirtualTable } from '@/hooks/useVirtualTable'
import { fetchApiData } from '@/utils/api'
import {
  lastfmLinkFilterValues,
  lastfmLinkFilters,
  lastfmLinkColumns,
  lastfmLinkKey,
  lastfmLinkSort,
  lastfmLinkSortDirection,
  lastfmLinkReasonLabels,
  lastfmLinkStrategyLabels,
  lastfmLinkSummaryRows,
  lastfmLinksPath,
  lastfmSpotifySearchLabel,
  canSearchLastfmGroup,
  LASTFM_SYNC_POLL_MS,
  LASTFM_LINKS_PAGE_SIZE,
  type LastfmLinkFilter,
  type LastfmLinkSort,
} from '@/utils/lastfm-sync'
import { updateJobSelection } from '@/utils/job-selection'
import {
  errorMessage,
  refreshScrobbleLinks,
  useLastfmSyncStatus,
} from './lastfm-sync'
import {
  LastfmLinkWorkflow,
  type LastfmLinkPanelMode,
} from './lastfm-link-panel'
import LastfmSearchActions from './lastfm-search-actions'
import { useConfig } from './providers'
import {
  SecondaryColumnFilter,
  SecondaryTableFrame,
  SecondaryCell,
  SecondaryDataTable,
  SecondaryTableSearch,
  SecondaryTableSelectionBar,
  SecondaryVirtualRows,
  SecondaryTableScroll,
  SecondaryTableHead,
  useTableColumns,
} from './secondary-table'
import { runStatusStates } from '@/utils/run-status'

const NAMES = { one: 'name', other: 'names' }
/** Width of the selection column; the artist name is pinned after it. */
const CHECK_WIDTH = 36
/** Room for the two row actions: Link album and Add new album. */
const ACTIONS_WIDTH = 80
const linkColumnWidths: Record<LastfmLinkSort, number> = {
  artistName: 180,
  albumName: 200,
  scrobbles: 90,
  lastListenedAt: 110,
  reason: 120,
  libraryAlbum: 200,
  spotifySearch: 140,
}
const linkColumns = lastfmLinkColumns.map((column) => ({
  ...column,
  width: linkColumnWidths[column.key],
}))

function LinkRow({
  group,
  onOpen,
  checked,
  disabled,
  onSelect,
  visible,
}: {
  group: LastfmLinkGroup
  visible: (key: string) => boolean
  onOpen: (mode: LastfmLinkPanelMode) => void
  checked: boolean
  disabled: boolean
  onSelect: (checked: boolean, shift: boolean) => void
}) {
  const linked = group.reason === 'linked' || group.reason === 'manual'
  const reason = lastfmLinkReasonLabels[group.reason]
  const strategy = group.strategy
    ? lastfmLinkStrategyLabels[group.strategy]
    : undefined
  const libraryAlbum =
    linked && group.album
      ? group.album.title
      : group.candidates.length
        ? `${formatCount(group.candidates.length)} possible albums`
        : EMPTY_VALUE
  return (
    <TableRow selected={checked}>
      <TableCell sticky={0}>
        <input
          type="checkbox"
          className="ds-check"
          aria-label={`Select ${group.artistName} — ${group.albumName ?? 'No album'}`}
          checked={checked}
          disabled={disabled || !canSearchLastfmGroup(group)}
          onChange={(event) =>
            onSelect(
              event.target.checked,
              'shiftKey' in event.nativeEvent &&
                event.nativeEvent.shiftKey === true,
            )
          }
        />
      </TableCell>
      {visible('artistName') && (
        <TableCell sticky={CHECK_WIDTH} stickyEdge>
          <SecondaryCell text={group.artistName}>
            {group.artistName}
          </SecondaryCell>
        </TableCell>
      )}
      {visible('albumName') && (
        <TableCell>
          <SecondaryCell>{group.albumName ?? EMPTY_VALUE}</SecondaryCell>
        </TableCell>
      )}
      {visible('scrobbles') && (
        <TableCell align="end">{formatCount(group.scrobbles)}</TableCell>
      )}
      {visible('lastListenedAt') && (
        <TableCell>
          <time
            dateTime={group.lastListenedAt}
            title={formatDateTime(group.lastListenedAt)}
          >
            {formatDate(group.lastListenedAt)}
          </time>
        </TableCell>
      )}
      {visible('reason') && (
        <TableCell>
          <SecondaryCell
            text={reason}
            label={`Link status for ${group.artistName} — ${group.albumName ?? 'No album'}`}
            details={strategy}
          >
            {reason}
          </SecondaryCell>
        </TableCell>
      )}
      {visible('libraryAlbum') && (
        <TableCell>
          <SecondaryCell text={libraryAlbum}>
            {linked && group.album ? (
              <span className="ds-cell-id">
                <DetailLink kind="album" id={group.album.id}>
                  {group.album.title}
                </DetailLink>
                <AlbumReferencePlayButton
                  id={group.album.id}
                  title={group.album.title}
                />
              </span>
            ) : (
              libraryAlbum
            )}
          </SecondaryCell>
        </TableCell>
      )}
      {visible('spotifySearch') && (
        <TableCell>
          <SecondaryCell
            text={lastfmSpotifySearchLabel(group.spotifySearch)}
            label={`Spotify search details for ${group.artistName} — ${group.albumName ?? 'No album'}`}
            details={group.spotifySearch?.errorMessage}
          >
            {group.spotifySearch ? (
              <DetailLink kind="job" id={group.spotifySearch.jobId}>
                <Status state={runStatusStates[group.spotifySearch.status]}>
                  {lastfmSpotifySearchLabel(group.spotifySearch)}
                </Status>
              </DetailLink>
            ) : (
              <Status state="never">{lastfmSpotifySearchLabel(null)}</Status>
            )}
          </SecondaryCell>
        </TableCell>
      )}
      {visible('actions') && (
        <TableCell align="end">
          {group.albumName !== null && (
            <span className="ds-cell-actions">
              <Button
                variant="ghost"
                size="xs"
                icon
                aria-label={linked ? 'Change album link' : 'Link album'}
                title={linked ? 'Change album link' : 'Link album'}
                aria-haspopup="dialog"
                onClick={() => onOpen('library')}
              >
                <Link2 className="ds-i" aria-hidden="true" />
              </Button>
              {!linked && (
                <Button
                  variant="ghost"
                  size="xs"
                  icon
                  aria-label="Add new album"
                  title="Add new album"
                  aria-haspopup="dialog"
                  onClick={() => onOpen('new')}
                >
                  <Plus className="ds-i" aria-hidden="true" />
                </Button>
              )}
            </span>
          )}
        </TableCell>
      )}
    </TableRow>
  )
}

export default function LastfmLinks() {
  const columns = useTableColumns('lastfm-links', [
    ...linkColumns,
    { key: 'actions', label: 'Actions' },
  ])
  const shownColumns = linkColumns.filter((column) =>
    columns.visible(column.key),
  )
  const layout = columns.layout([
    CHECK_WIDTH,
    ...shownColumns.map((column) => column.key),
    ...(columns.visible('actions') ? [ACTIONS_WIDTH] : []),
  ])
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const search = useSearchParams()
  const reasons = lastfmLinkFilterValues(
    search.get('reasons'),
    search.get('reason'),
  )
  const reasonsKey = JSON.stringify(reasons)
  const sortBy = lastfmLinkSort(search.get('sortBy'))
  const sortDirection = lastfmLinkSortDirection(search.get('sortDirection'))
  const [draft, setDraft] = useState(search.get('q') ?? '')
  const [query, setQuery] = useState(search.get('q') ?? '')
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [anchor, setAnchor] = useState<string | null>(null)
  const [queuePending, setQueuePending] = useState(false)
  const all = useRef<HTMLInputElement>(null)
  const [selected, setSelected] = useState<{
    group: LastfmLinkGroup
    mode: LastfmLinkPanelMode
  } | null>(null)
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const next = draft.trim()
      setQuery(next)
      const params = new URLSearchParams(window.location.search)
      if (next) params.set('q', next)
      else params.delete('q')
      window.history.replaceState(
        null,
        '',
        `${window.location.pathname}?${params}`,
      )
    }, 250)
    return () => window.clearTimeout(timer)
  }, [draft])
  const status = useLastfmSyncStatus()
  const links = useVirtualTable({
    queryKey: ['lastfm-links', reasonsKey, query, sortBy, sortDirection],
    pageSize: LASTFM_LINKS_PAGE_SIZE,
    enabled: !queuePending,
    loadPage: (page, size, signal) =>
      fetchApiData(
        apiBaseUrl,
        lastfmLinksPath({
          reasons,
          q: query,
          page,
          size,
          sortBy,
          sortDirection,
        }),
        LastfmLinkReportSchema,
        { signal },
      ),
    refetchInterval: (page) =>
      page?.items.some(
        (group) =>
          group.spotifySearch?.status === 'queued' ||
          group.spotifySearch?.status === 'running',
      )
        ? LASTFM_SYNC_POLL_MS
        : false,
  })
  const relink = useMutation({
    mutationFn: () => refreshScrobbleLinks(apiBaseUrl, client),
  })
  function clearSelection() {
    setSelectedIds([])
    setAnchor(null)
  }
  useEffect(() => {
    setSelectedIds([])
    setAnchor(null)
  }, [reasonsKey, query, sortBy, sortDirection])
  function setReasons(value: LastfmLinkFilter[]) {
    clearSelection()
    const params = new URLSearchParams(window.location.search)
    if (value.length) params.set('reasons', JSON.stringify(value))
    else params.delete('reasons')
    params.delete('reason')
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}?${params}`,
    )
  }
  function sort(key: LastfmLinkSort) {
    clearSelection()
    const params = new URLSearchParams(window.location.search)
    params.set('sortBy', key)
    params.set(
      'sortDirection',
      sortBy === key && sortDirection === 'asc' ? 'desc' : 'asc',
    )
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}?${params}`,
    )
  }
  const items = [
    ...new Map(
      links.loadedSlots.map(({ item }) => [lastfmLinkKey(item), item]),
    ).values(),
  ]
  const ids = items.filter(canSearchLastfmGroup).map(lastfmLinkKey)
  const allChecked =
    ids.length > 0 && ids.every((id) => selectedIds.includes(id))
  const selectionDisabled =
    queuePending || links.isPending || draft.trim() !== query || links.isError
  useEffect(() => {
    if (all.current)
      all.current.indeterminate =
        !allChecked && ids.some((id) => selectedIds.includes(id))
  }, [allChecked, ids, selectedIds])
  const summary = links.firstPage?.summary
  const running = status.data?.state === 'running'
  return (
    <>
      <div className="ds-panelpad">
        <Section title="Scrobble links">
          <p className="ds-help">
            A scrobbled artist and album name links to one library album by
            title, credited artist and shared track titles. Edition, disc and
            format qualifiers are ignored. Link, Unlink and Change are kept
            across syncs; Automatic returns a name to automatic matching.
          </p>
          {summary && (
            <SecondaryDataTable
              id="lastfm-link-summary"
              label="Scrobble link summary"
              rows={lastfmLinkSummaryRows(summary)}
              rowKey={(row) => row.reason}
              defaultSort={{ key: 'reason', direction: 'asc' }}
              columns={[
                {
                  key: 'reason',
                  label: 'Status',
                  width: 220,
                  fill: true,
                  value: (row) => lastfmLinkReasonLabels[row.reason],
                  render: (row) => (
                    <Button
                      variant="link"
                      size="xs"
                      type="button"
                      disabled={queuePending}
                      onClick={() =>
                        setReasons(
                          reasons.includes(row.reason)
                            ? reasons.filter((reason) => reason !== row.reason)
                            : [...reasons, row.reason],
                        )
                      }
                      aria-pressed={reasons.includes(row.reason)}
                    >
                      {lastfmLinkReasonLabels[row.reason]}
                    </Button>
                  ),
                },
                {
                  key: 'groups',
                  label: 'Scrobbled names',
                  width: 140,
                  align: 'end',
                  value: (row) => row.groups,
                  render: (row) => formatCount(row.groups),
                },
                {
                  key: 'scrobbles',
                  label: 'Scrobbles',
                  width: 100,
                  align: 'end',
                  value: (row) => row.scrobbles,
                  render: (row) => formatCount(row.scrobbles),
                },
              ]}
            />
          )}
          <span className="sec-line">
            <Button
              disabled={relink.isPending || running || queuePending}
              onClick={() => relink.mutate()}
            >
              {relink.isPending ? 'Relinking...' : 'Relink'}
            </Button>
            <span className="ds-help">
              Links are recomputed after every sync. Relink applies library
              changes without contacting Last.fm.
            </span>
          </span>
          {relink.isError && (
            <Notice tone="danger">
              {errorMessage(relink.error, 'Could not relink scrobbles.')}
            </Notice>
          )}
          {links.isError && links.total > 0 && (
            <Notice
              tone="danger"
              action={
                <Button size="xs" onClick={links.retry}>
                  Retry
                </Button>
              }
            >
              Could not load scrobble links.
            </Notice>
          )}
        </Section>
      </div>
      <LastfmLinkWorkflow
        selection={selected}
        onSelectionChange={setSelected}
      />
      <Toolbar>
        <SecondaryTableSearch
          label="Search scrobbled names"
          placeholder="Search artists or albums"
          value={draft}
          disabled={queuePending}
          maxLength={200}
          onChange={(value) => {
            setDraft(value)
            clearSelection()
          }}
        />
        <ToolbarCount>
          {links.isPending || draft.trim() !== query ? (
            <Skeleton width={64} height={12} />
          ) : (
            formatItemCount(links.total, NAMES)
          )}
        </ToolbarCount>
        {columns.controls && <ToolbarEnd>{columns.controls}</ToolbarEnd>}
      </Toolbar>
      <SecondaryTableFrame>
        <SecondaryTableScroll
          ref={links.scroller}
          onScroll={links.onScroll}
          className="sec-bounded"
          role="region"
          aria-label="Scrobble links"
          aria-busy={links.isFetching}
        >
          <table
            className="ds-table"
            aria-label="Scrobble links"
            {...layout.table}
          >
            {layout.colgroup}
            <TableHeader>
              <TableRow>
                <TableHead sticky={0}>
                  <input
                    ref={all}
                    type="checkbox"
                    className="ds-check"
                    aria-label="Select all loaded unlinked albums"
                    checked={allChecked}
                    disabled={selectionDisabled || !ids.length}
                    onChange={(event) => {
                      setSelectedIds(
                        event.target.checked
                          ? [...new Set([...selectedIds, ...ids])]
                          : [],
                      )
                      setAnchor(null)
                    }}
                  />
                </TableHead>
                {shownColumns.map((column) => (
                  <SecondaryTableHead
                    key={column.key}
                    sortKey={column.key}
                    label={column.label}
                    align={column.key === 'scrobbles' ? 'end' : undefined}
                    sticky={
                      column.key === 'artistName' ? CHECK_WIDTH : undefined
                    }
                    stickyEdge={column.key === 'artistName'}
                    filter={
                      column.key === 'reason' ? (
                        <SecondaryColumnFilter
                          label="Link status"
                          options={lastfmLinkFilters.filter(
                            (
                              option,
                            ): option is {
                              value: LastfmLinkFilter
                              label: string
                            } => option.value !== '',
                          )}
                          value={reasons}
                          onChange={setReasons}
                          disabled={queuePending}
                        />
                      ) : undefined
                    }
                    sortBy={sortBy}
                    direction={sortDirection}
                    onSort={sort}
                    disabled={queuePending}
                    resizer={columns.resizer(column.key)}
                  />
                ))}
                {columns.visible('actions') && (
                  <TableHead align="end">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {!links.total && (
                <TableState colSpan={columns.count + 1} error={links.isError}>
                  {links.isPending ? (
                    <Skeleton width="40%" height={12} />
                  ) : links.isError ? (
                    <>
                      Could not load scrobble links.{' '}
                      <Button size="xs" onClick={links.retry}>
                        Retry
                      </Button>
                    </>
                  ) : (
                    'No scrobbled names match.'
                  )}
                </TableState>
              )}
              {(!links.isError || links.hasTotal) && (
                <SecondaryVirtualRows
                  window={links}
                  colSpan={columns.count + 1}
                  renderRow={(group) => (
                    <LinkRow
                      key={lastfmLinkKey(group)}
                      group={group}
                      visible={columns.visible}
                      checked={selectedIds.includes(lastfmLinkKey(group))}
                      disabled={selectionDisabled}
                      onSelect={(checked, shift) => {
                        const id = lastfmLinkKey(group)
                        setSelectedIds(
                          updateJobSelection(
                            selectedIds,
                            ids,
                            id,
                            anchor,
                            shift,
                            checked,
                          ),
                        )
                        setAnchor(id)
                      }}
                      onOpen={(mode) => setSelected({ group, mode })}
                    />
                  )}
                />
              )}
            </TableBody>
          </table>
        </SecondaryTableScroll>
        <SecondaryTableSelectionBar
          selectedCount={selectedIds.length}
          total={ids.length}
          hideWhenEmpty
        >
          <LastfmSearchActions
            groups={items}
            selectedIds={selectedIds}
            onSelect={setSelectedIds}
            onPending={setQueuePending}
            disabled={selectionDisabled}
          />
        </SecondaryTableSelectionBar>
      </SecondaryTableFrame>
    </>
  )
}
