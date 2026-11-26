'use client'

import { ReadButton } from '@/components/read-button'
import { useInfiniteQuery } from '@tanstack/react-query'
import type { MatchDiagnosticsPage } from '@repo/schemas/match-diagnostics'
import { Notice } from '@repo/ui/components/ds/feedback'
import { formatDateTime } from '@repo/ui/lib/format'
import {
  albumMatchHistoryKey,
  loadAlbumMatchHistory,
} from '@/utils/match-diagnostics'
import { useConfig } from './providers'

const historyPageSize = 10

export function AlbumMatchHistory({
  id,
  name,
  providers,
}: {
  id: string
  name: string
  providers: MatchDiagnosticsPage['providers']
}) {
  const { apiBaseUrl } = useConfig()
  const history = useInfiniteQuery({
    queryKey: albumMatchHistoryKey(id),
    initialPageParam: 1,
    queryFn: ({ pageParam, signal }) =>
      loadAlbumMatchHistory(apiBaseUrl, id, pageParam, historyPageSize, signal),
    getNextPageParam: ({ page, pageCount }) =>
      page < pageCount ? page + 1 : undefined,
  })
  const items = history.data?.pages.flatMap(({ items }) => items) ?? []
  return (
    <div className="data-stack">
      <strong>{name}</strong>
      {history.isPending && <p role="status">Loading match history…</p>}
      {history.isError && (
        <Notice
          tone="danger"
          action={
            <ReadButton
              size="xs"
              disabled={history.isFetching}
              read={() =>
                history.isFetchNextPageError
                  ? history.fetchNextPage()
                  : history.refetch()
              }
            >
              Retry
            </ReadButton>
          }
        >
          Could not load match history.
        </Notice>
      )}
      {history.isSuccess && items.length === 0 && (
        <p className="ds-muted">No matches marked incorrect.</p>
      )}
      {items.length > 0 && (
        <ul>
          {items.map((item) => {
            const provider =
              providers.find(({ key }) => key === item.provider)?.label ??
              item.provider
            return (
              <li
                key={JSON.stringify([
                  item.provider,
                  item.sourceProvider,
                  item.referenceType,
                  item.identifier,
                  item.snapshotId,
                ])}
              >
                {provider} ·{' '}
                <time dateTime={item.rejectedAt}>
                  {formatDateTime(item.rejectedAt)}
                </time>
                <div>{item.identifier}</div>
              </li>
            )
          })}
        </ul>
      )}
      {history.hasNextPage && !history.isFetchNextPageError && (
        <ReadButton
          size="xs"
          variant="ghost"
          disabled={history.isFetching}
          loadingLabel="Loading more…"
          loadedLabel="Loaded more"
          read={() => history.fetchNextPage()}
        >
          Show older
        </ReadButton>
      )}
    </div>
  )
}
