'use client'

import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query'
import {
  LastfmLinkReportSchema,
  type LastfmLinkGroup,
} from '@repo/schemas/lastfm'
import { Button } from '@repo/ui/components/ui/button'
import { Input } from '@repo/ui/components/ui/input'
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableState,
} from '@repo/ui/components/ui/table'
import { useInfiniteTableScroll } from '@/hooks/useInfiniteTableScroll'
import { fetchApiData } from '@/utils/api'
import {
  lastfmLinkFilter,
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
  type LastfmLinkFilter,
  type LastfmLinkSort,
} from '@/utils/lastfm-sync'
import { updateJobSelection } from '@/utils/job-selection'
import { scopedHref } from '@/utils/media-scope'
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
  SecondaryDataTable,
  SecondaryTableScroll,
  SecondaryTableHead,
  useTableColumns,
} from './secondary-table'

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
  return (
    <TableRow data-selected={checked || undefined}>
      <TableCell className="table-selection-cell">
        <input
          type="checkbox"
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
      {visible('artistName') && <TableCell>{group.artistName}</TableCell>}
      {visible('albumName') && <TableCell>{group.albumName ?? '-'}</TableCell>}
      {visible('scrobbles') && (
        <TableCell className="tabular-nums">
          {group.scrobbles.toLocaleString()}
        </TableCell>
      )}
      {visible('lastListenedAt') && (
        <TableCell className="whitespace-nowrap">
          <time dateTime={group.lastListenedAt}>
            {new Date(group.lastListenedAt).toLocaleDateString()}
          </time>
        </TableCell>
      )}
      {visible('reason') && (
        <TableCell>
          {lastfmLinkReasonLabels[group.reason]}
          {group.strategy && (
            <div className="muted">
              {lastfmLinkStrategyLabels[group.strategy]}
            </div>
          )}
        </TableCell>
      )}
      {visible('libraryAlbum') && (
        <TableCell>
          {linked && group.album ? (
            <Link href={`/albums/${group.album.id}`}>{group.album.title}</Link>
          ) : group.candidates.length ? (
            `${group.candidates.length} possible albums`
          ) : (
            '-'
          )}
        </TableCell>
      )}
      {visible('spotifySearch') && (
        <TableCell>
          {group.spotifySearch ? (
            <Link
              className="job-status underline underline-offset-2"
              data-status={group.spotifySearch.status}
              href={scopedHref(
                `/jobs?jobId=${encodeURIComponent(group.spotifySearch.jobId)}`,
                'album',
              )}
              title={group.spotifySearch.errorMessage ?? undefined}
            >
              {lastfmSpotifySearchLabel(group.spotifySearch)}
            </Link>
          ) : (
            <span className="muted">{lastfmSpotifySearchLabel(null)}</span>
          )}
        </TableCell>
      )}
      {visible('actions') && (
        <TableCell>
          {group.albumName !== null && (
            <div className="flex flex-wrap gap-1">
              <Button
                size="sm"
                variant="outline"
                aria-haspopup="dialog"
                onClick={() => onOpen('library')}
              >
                {linked ? 'Change' : 'Link'}
              </Button>
              {!linked && (
                <Button
                  size="sm"
                  variant="outline"
                  aria-haspopup="dialog"
                  onClick={() => onOpen('new')}
                >
                  Add new album
                </Button>
              )}
            </div>
          )}
        </TableCell>
      )}
    </TableRow>
  )
}

export default function LastfmLinks() {
  const columns = useTableColumns('lastfm-links', [
    ...lastfmLinkColumns,
    { key: 'actions', label: 'Actions' },
  ])
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const search = useSearchParams()
  const reason = lastfmLinkFilter(search.get('reason'))
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
  const links = useInfiniteQuery({
    queryKey: ['lastfm-links', reason, query, sortBy, sortDirection],
    initialPageParam: 1,
    placeholderData: keepPreviousData,
    queryFn: ({ pageParam, signal }) =>
      fetchApiData(
        apiBaseUrl,
        lastfmLinksPath({
          reason,
          q: query,
          page: pageParam,
          sortBy,
          sortDirection,
        }),
        LastfmLinkReportSchema,
        { signal },
      ),
    getNextPageParam: (last) =>
      last.page < last.pageCount ? last.page + 1 : undefined,
    refetchInterval: (result) =>
      result.state.data?.pages.some((page) =>
        page.items.some(
          (group) =>
            group.spotifySearch?.status === 'queued' ||
            group.spotifySearch?.status === 'running',
        ),
      )
        ? LASTFM_SYNC_POLL_MS
        : false,
  })
  const relink = useMutation({
    mutationFn: () => refreshScrobbleLinks(apiBaseUrl, client),
  })
  const { scroller, sentinel } = useInfiniteTableScroll({
    enabled:
      links.hasNextPage && !links.isFetching && !links.isError && !queuePending,
    fetchNextPage: links.fetchNextPage,
    resetKey: JSON.stringify([reason, query, sortBy, sortDirection]),
  })
  function clearSelection() {
    setSelectedIds([])
    setAnchor(null)
  }
  useEffect(() => {
    setSelectedIds([])
    setAnchor(null)
  }, [reason, query, sortBy, sortDirection])
  function setReason(value: LastfmLinkFilter | '') {
    clearSelection()
    const params = new URLSearchParams(window.location.search)
    if (value) params.set('reason', value)
    else params.delete('reason')
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
  const items = links.data?.pages.flatMap((page) => page.items) ?? []
  const ids = items.filter(canSearchLastfmGroup).map(lastfmLinkKey)
  const allChecked =
    ids.length > 0 && ids.every((id) => selectedIds.includes(id))
  const selectionDisabled =
    queuePending ||
    links.isPlaceholderData ||
    draft.trim() !== query ||
    links.isError
  useEffect(() => {
    if (all.current)
      all.current.indeterminate =
        !allChecked && ids.some((id) => selectedIds.includes(id))
  }, [allChecked, ids, selectedIds])
  const summary = links.data?.pages[0]?.summary
  const running = status.data?.state === 'running'
  return (
    <section aria-labelledby="scrobble-links-heading">
      <h2 id="scrobble-links-heading">Scrobble links</h2>
      <p className="muted">
        A scrobbled artist and album name links to one library album by title,
        credited artist and shared track titles. Edition, disc and format
        qualifiers are ignored. Link, Unlink and Change are kept across syncs;
        Automatic returns a name to automatic matching.
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
              value: (row) => lastfmLinkReasonLabels[row.reason],
              render: (row) => (
                <button
                  type="button"
                  className="underline underline-offset-2"
                  aria-pressed={reason === row.reason}
                  disabled={queuePending}
                  onClick={() => setReason(row.reason)}
                >
                  {lastfmLinkReasonLabels[row.reason]}
                </button>
              ),
            },
            {
              key: 'groups',
              label: 'Scrobbled names',
              value: (row) => row.groups,
              render: (row) => row.groups.toLocaleString(),
              className: 'numeric',
            },
            {
              key: 'scrobbles',
              label: 'Scrobbles',
              value: (row) => row.scrobbles,
              render: (row) => row.scrobbles.toLocaleString(),
              className: 'numeric',
            },
          ]}
        />
      )}
      <div className="form-actions my-3">
        <Button
          variant="outline"
          size="sm"
          disabled={relink.isPending || running || queuePending}
          onClick={() => relink.mutate()}
        >
          {relink.isPending ? 'Relinking...' : 'Relink'}
        </Button>
        <span className="muted">
          Links are recomputed after every sync. Relink applies library changes
          without contacting Last.fm.
        </span>
        {relink.isError && (
          <p role="alert">
            {errorMessage(relink.error, 'Could not relink scrobbles.')}
          </p>
        )}
      </div>
      <div className="job-toolbar">
        <select
          aria-label="Link status"
          value={reason}
          disabled={queuePending}
          onChange={(event) => setReason(lastfmLinkFilter(event.target.value))}
        >
          {lastfmLinkFilters.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <Input
          type="search"
          aria-label="Search scrobbled names"
          placeholder="Search artists or albums"
          value={draft}
          disabled={queuePending}
          maxLength={200}
          onChange={(event) => {
            setDraft(event.target.value)
            clearSelection()
          }}
        />
        <span className="muted">
          {links.data?.pages[0]?.totalCount.toLocaleString() ?? 0} names
        </span>
        {ids.length > 100 && (
          <Button
            variant="ghost"
            size="sm"
            disabled={selectionDisabled}
            onClick={() => {
              setSelectedIds(ids.slice(0, 100))
              setAnchor(null)
            }}
          >
            Select first 100
          </Button>
        )}
        {(links.isPlaceholderData || draft.trim() !== query) && (
          <span role="status" className="muted">
            Loading...
          </span>
        )}
      </div>
      {links.isError && items.length > 0 && !links.isFetchNextPageError && (
        <p role="alert">
          Could not load scrobble links.{' '}
          <button type="button" onClick={() => links.refetch()}>
            Retry
          </button>
        </p>
      )}
      <LastfmLinkWorkflow
        selection={selected}
        onSelectionChange={setSelected}
      />
      {columns.controls}
      <SecondaryTableScroll
        ref={scroller}
        className="table-scroll-bounded"
        role="region"
        aria-label="Scrobble links"
        aria-busy={links.isFetching}
      >
        <table className="compact-table" aria-label="Scrobble links">
          <TableHeader>
            <TableRow>
              <TableHead className="table-selection-cell">
                <input
                  ref={all}
                  type="checkbox"
                  aria-label="Select all loaded unlinked albums"
                  checked={allChecked}
                  disabled={selectionDisabled || !ids.length}
                  onChange={(event) => {
                    setSelectedIds(
                      event.target.checked
                        ? [...new Set([...selectedIds, ...ids])]
                        : selectedIds.filter((id) => !ids.includes(id)),
                    )
                    setAnchor(null)
                  }}
                />
              </TableHead>
              {lastfmLinkColumns
                .filter((column) => columns.visible(column.key))
                .map((column) => (
                  <SecondaryTableHead
                    key={column.key}
                    sortKey={column.key}
                    label={column.label}
                    sortBy={sortBy}
                    direction={sortDirection}
                    onSort={sort}
                    disabled={queuePending}
                  />
                ))}
              {columns.visible('actions') && <TableHead>Actions</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {!items.length && (
              <TableState colSpan={columns.count + 1} error={links.isError}>
                {links.isPending
                  ? 'Loading scrobble links...'
                  : links.isError
                    ? 'Could not load scrobble links.'
                    : 'No matching scrobbled names.'}
                {links.isError && (
                  <button
                    type="button"
                    className="ml-1 underline"
                    onClick={() => links.refetch()}
                  >
                    Retry
                  </button>
                )}
              </TableState>
            )}
            {items.map((group) => (
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
            ))}
          </TableBody>
        </table>
        <div ref={sentinel} className="py-2 text-center">
          {links.isFetchingNextPage && (
            <p role="status" className="muted">
              Loading more scrobble links...
            </p>
          )}
          {links.isFetchNextPageError && (
            <p role="alert">Could not load more scrobble links.</p>
          )}
          {links.hasNextPage && !links.isFetchingNextPage && (
            <Button
              type="button"
              variant="ghost"
              disabled={links.isFetching || queuePending}
              onClick={() => links.fetchNextPage({ cancelRefetch: false })}
            >
              {links.isFetchNextPageError
                ? 'Retry loading scrobble links'
                : 'Load more scrobble links'}
            </Button>
          )}
        </div>
      </SecondaryTableScroll>
      <LastfmSearchActions
        groups={items}
        selectedIds={selectedIds}
        onSelect={setSelectedIds}
        onPending={setQueuePending}
        disabled={selectionDisabled}
      />
    </section>
  )
}
