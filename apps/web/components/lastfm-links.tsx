'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query'
import {
  LastfmLinkReportSchema,
  LastfmSyncStatusSchema,
  type LastfmLinkGroup,
} from '@repo/schemas/lastfm'
import { Button } from '@repo/ui/components/ui/button'
import { Input } from '@repo/ui/components/ui/input'
import { TableScroll, TableState } from '@repo/ui/components/ui/table'
import { useInfiniteTableScroll } from '@/hooks/useInfiniteTableScroll'
import { fetchApiData } from '@/utils/api'
import {
  lastfmLinkFilter,
  lastfmLinkFilters,
  lastfmLinkReasonLabels,
  lastfmLinkStrategyLabels,
  lastfmLinkSummaryRows,
  lastfmLinksPath,
  type LastfmLinkFilter,
} from '@/utils/lastfm-sync'
import {
  errorMessage,
  invalidateScrobbleLinks,
  useLastfmSyncStatus,
} from './lastfm-sync'
import { AlbumPicker, useLastfmLinkUpdate } from './lastfm-link-controls'
import { useConfig } from './providers'

function LinkRow({ group }: { group: LastfmLinkGroup }) {
  const update = useLastfmLinkUpdate()
  const [picking, setPicking] = useState(false)
  const albumName = group.albumName
  const linked = group.reason === 'linked' || group.reason === 'manual'
  const link = (albumId: string) => {
    if (albumName !== null)
      update.mutate(
        { action: 'link', artistName: group.artistName, albumName, albumId },
        { onSuccess: () => setPicking(false) },
      )
  }
  return (
    <tr>
      <td>{group.artistName}</td>
      <td>{albumName ?? '-'}</td>
      <td className="tabular-nums">{group.scrobbles.toLocaleString()}</td>
      <td className="whitespace-nowrap">
        <time dateTime={group.lastListenedAt}>
          {new Date(group.lastListenedAt).toLocaleDateString()}
        </time>
      </td>
      <td>
        {lastfmLinkReasonLabels[group.reason]}
        {group.strategy && (
          <div className="muted">
            {lastfmLinkStrategyLabels[group.strategy]}
          </div>
        )}
      </td>
      <td>
        {linked && group.album ? (
          <Link href={`/albums/${group.album.id}`}>{group.album.title}</Link>
        ) : group.candidates.length ? (
          <ul>
            {group.candidates.map((album) => (
              <li key={album.id} className="flex items-center gap-2">
                <Link href={`/albums/${album.id}`}>
                  {album.title}
                  {album.artists.length ? ` — ${album.artists.join(', ')}` : ''}
                </Link>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={update.isPending}
                  onClick={() => link(album.id)}
                >
                  Link
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          '-'
        )}
      </td>
      <td>
        {albumName !== null && (
          <div className="grid gap-1">
            <div className="flex flex-wrap gap-1">
              <Button
                size="sm"
                variant="outline"
                aria-expanded={picking}
                disabled={update.isPending}
                onClick={() => setPicking(!picking)}
              >
                {linked ? 'Change' : 'Link'}
              </Button>
              {linked && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={update.isPending}
                  onClick={() =>
                    update.mutate({
                      action: 'unlink',
                      artistName: group.artistName,
                      albumName,
                    })
                  }
                >
                  Unlink
                </Button>
              )}
              {(group.reason === 'manual' || group.reason === 'excluded') && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={update.isPending}
                  onClick={() =>
                    update.mutate({
                      action: 'auto',
                      artistName: group.artistName,
                      albumName,
                    })
                  }
                >
                  Automatic
                </Button>
              )}
            </div>
            {picking && (
              <AlbumPicker
                label={`Album for ${group.artistName} — ${albumName}`}
                disabled={update.isPending}
                onPick={link}
              />
            )}
            {update.isError && (
              <p role="alert">
                {errorMessage(update.error, 'Could not update the link.')}
              </p>
            )}
          </div>
        )}
      </td>
    </tr>
  )
}

export default function LastfmLinks() {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const search = useSearchParams()
  const reason = lastfmLinkFilter(search.get('reason'))
  const [draft, setDraft] = useState('')
  const [query, setQuery] = useState('')
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(draft.trim()), 250)
    return () => window.clearTimeout(timer)
  }, [draft])
  const status = useLastfmSyncStatus()
  const links = useInfiniteQuery({
    queryKey: ['lastfm-links', reason, query],
    initialPageParam: 1,
    placeholderData: keepPreviousData,
    queryFn: ({ pageParam, signal }) =>
      fetchApiData(
        apiBaseUrl,
        lastfmLinksPath({ reason, q: query, page: pageParam }),
        LastfmLinkReportSchema,
        { signal },
      ),
    getNextPageParam: (last) =>
      last.page < last.pageCount ? last.page + 1 : undefined,
  })
  const relink = useMutation({
    mutationFn: () =>
      fetchApiData(
        apiBaseUrl,
        '/api/v1/lastfm/links/refresh',
        LastfmSyncStatusSchema,
        { method: 'POST', body: '{}' },
      ),
    onSuccess: async (next) => {
      client.setQueryData(['lastfm-sync'], next)
      await invalidateScrobbleLinks(client)
    },
  })
  const { scroller, sentinel } = useInfiniteTableScroll({
    enabled: links.hasNextPage && !links.isFetching && !links.isError,
    fetchNextPage: links.fetchNextPage,
    resetKey: `${reason}:${query}`,
  })
  function setReason(value: LastfmLinkFilter | '') {
    const params = new URLSearchParams(window.location.search)
    if (value) params.set('reason', value)
    else params.delete('reason')
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}?${params}`,
    )
  }
  const items = links.data?.pages.flatMap((page) => page.items) ?? []
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
        <table className="compact-table" aria-label="Scrobble link summary">
          <thead>
            <tr>
              <th scope="col">Status</th>
              <th scope="col">Scrobbled names</th>
              <th scope="col">Scrobbles</th>
            </tr>
          </thead>
          <tbody>
            {lastfmLinkSummaryRows(summary).map((row) => (
              <tr key={row.reason}>
                <td>
                  <button
                    type="button"
                    className="underline underline-offset-2"
                    aria-pressed={reason === row.reason}
                    onClick={() => setReason(row.reason)}
                  >
                    {lastfmLinkReasonLabels[row.reason]}
                  </button>
                </td>
                <td>{row.groups.toLocaleString()}</td>
                <td>{row.scrobbles.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="form-actions my-3">
        <Button
          variant="outline"
          size="sm"
          disabled={relink.isPending || running}
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
          onChange={(event) => setDraft(event.target.value)}
        />
        <span className="muted">
          {links.data?.pages[0]?.totalCount.toLocaleString() ?? 0} names
        </span>
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
      <TableScroll
        ref={scroller}
        className="table-scroll-bounded"
        role="region"
        aria-label="Scrobble links"
        aria-busy={links.isFetching}
      >
        <table className="compact-table" aria-label="Scrobble links">
          <thead>
            <tr>
              <th scope="col">Scrobbled artist</th>
              <th scope="col">Scrobbled album</th>
              <th scope="col">Scrobbles</th>
              <th scope="col">Last listened</th>
              <th scope="col">Status</th>
              <th scope="col">Library album</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {!items.length && (
              <TableState colSpan={7} error={links.isError}>
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
                key={`${group.artistName}\u0000${group.albumName ?? ''}`}
                group={group}
              />
            ))}
          </tbody>
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
              disabled={links.isFetching}
              onClick={() => links.fetchNextPage({ cancelRefetch: false })}
            >
              {links.isFetchNextPageError
                ? 'Retry loading scrobble links'
                : 'Load more scrobble links'}
            </Button>
          )}
        </div>
      </TableScroll>
    </section>
  )
}
