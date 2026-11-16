'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import {
  SubscriptionSourceListSchema,
  SubscriptionTypeSchema,
  subscriptionTypeLabels,
  type SubscriptionSource,
} from '@repo/schemas/subscriptions'
import { Button } from '@repo/ui/components/ui/button'
import {
  TableBody,
  TableCell,
  TableHeader,
  TableRow,
  TableState,
} from '@repo/ui/components/ui/table'
import { EmptyValue } from '@repo/ui/components/ds/pill'
import { Skeleton } from '@repo/ui/components/ds/feedback'
import { Status } from '@repo/ui/components/ds/status'
import { PageHead } from '@repo/ui/components/ds/toolbar'
import { formatCount, formatDate, formatItemCount } from '@repo/ui/lib/format'
import { useConfig } from './providers'
import { DetailLink } from './detail-link'
import { MediaThumb } from './media-artwork'
import {
  replaceWorkspaceUrl,
  useDetailInspector,
} from './detail-inspector-context'
import { fetchApiData } from '@/utils/api'
import {
  filterSubscriptionSources,
  formatSubscriptionSourceSize,
  parseSubscriptionType,
  parseSubscriptionTypes,
  subscriptionImportsHref,
  subscriptionSourceColumns,
  subscriptionSourceHref,
  subscriptionSourceSort,
  type SubscriptionSourceSort,
} from '@/utils/subscriptions'
import {
  SecondaryCell,
  SecondaryColumnFilter,
  SecondaryTableScroll,
  SecondaryTableHead,
  SecondaryTableSearch,
  SecondaryTableToolbar,
  useTableColumns,
} from './secondary-table'
import { RetryButton } from './browse-items'

function useSubscriptionSources() {
  const { apiBaseUrl } = useConfig()
  return useQuery({
    queryKey: ['subscriptions', 'sources'],
    queryFn: ({ signal }) =>
      fetchApiData(
        apiBaseUrl,
        '/api/v1/subscriptions/sources',
        SubscriptionSourceListSchema,
        { signal },
      ),
  })
}

function replaceParams(updates: Record<string, string | string[] | null>) {
  const params = new URLSearchParams(window.location.search)
  for (const [key, value] of Object.entries(updates)) {
    params.delete(key)
    if (Array.isArray(value)) for (const item of value) params.append(key, item)
    else if (value) params.set(key, value)
  }
  replaceWorkspaceUrl(
    `${window.location.pathname}${params.size ? `?${params}` : ''}`,
    true,
  )
}

function SourceRow({
  source,
  visible,
  selected,
}: {
  source: SubscriptionSource
  visible: (key: string) => boolean
  selected: boolean
}) {
  return (
    <TableRow selected={selected}>
      {visible('title') && (
        <TableCell sticky={0} stickyEdge>
          <span className="ds-cell-id">
            <MediaThumb kind="person" src={source.thumbnailUrl} />
            <DetailLink
              kind="channel"
              id={source.id}
              className="ds-cell-title"
              title={source.title}
            >
              {source.title}
            </DetailLink>
          </span>
        </TableCell>
      )}
      {visible('type') && (
        <TableCell>{subscriptionTypeLabels[source.type]}</TableCell>
      )}
      {visible('storedItems') && (
        <TableCell align="end">
          <SecondaryCell
            details={!source.historyComplete ? 'Reading history' : undefined}
            label={`History for ${source.title}`}
          >
            <Link
              href={subscriptionSourceHref(source.id)}
              title={`Filter subscriptions by ${source.title}`}
              aria-label={`Filter subscriptions by ${source.title}`}
            >
              {formatCount(source.storedItems)}
            </Link>
          </SecondaryCell>
        </TableCell>
      )}
      {visible('latestItemAt') && (
        <TableCell>
          {source.latestItemAt ? (
            <time dateTime={source.latestItemAt}>
              {formatDate(source.latestItemAt)}
            </time>
          ) : (
            <EmptyValue />
          )}
        </TableCell>
      )}
      {visible('size') && (
        <TableCell align="end">
          {formatSubscriptionSourceSize(source)}
        </TableCell>
      )}
      {visible('description') && (
        <TableCell>
          <SecondaryCell
            text={source.description ?? undefined}
            details={source.description || undefined}
            label={`Description of ${source.title}`}
          >
            {source.description ?? <EmptyValue />}
          </SecondaryCell>
        </TableCell>
      )}
      {visible('handle') && (
        <TableCell>
          <SecondaryCell
            text={
              source.type === 'youtube'
                ? (source.handle ?? undefined)
                : undefined
            }
          >
            {source.type === 'youtube' && source.handle ? (
              source.handle
            ) : (
              <EmptyValue />
            )}
          </SecondaryCell>
        </TableCell>
      )}
      {visible('historyComplete') && (
        <TableCell>
          {source.historyComplete ? (
            <Status state="done">Complete</Status>
          ) : (
            <Status state="running">Reading history</Status>
          )}
        </TableCell>
      )}
    </TableRow>
  )
}

export default function SubscriptionChannels() {
  const columns = useTableColumns(
    'subscription-channels',
    subscriptionSourceColumns,
  )
  const search = useSearchParams()
  const inspector = useDetailInspector()
  const selectedId =
    inspector?.root?.kind === 'channel' ? inspector.root.id : null
  const sources = useSubscriptionSources()
  const sortBy = subscriptionSourceSort(search.get('sortBy'))
  const direction = search.get('direction') === 'desc' ? 'desc' : 'asc'
  const type = parseSubscriptionType(search.get('type'))
  const types = search.has('types')
    ? parseSubscriptionTypes(search.get('types'))
    : type
      ? [type]
      : []
  const history = search
    .getAll('history')
    .filter((value) => value === 'complete' || value === 'reading')
  const [draft, setDraft] = useState(search.get('q') ?? '')
  const [q, setQ] = useState(search.get('q') ?? '')
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const next = draft.trim()
      setQ(next)
      replaceParams({ q: next || null })
    }, 250)
    return () => window.clearTimeout(timer)
  }, [draft])
  function sort(key: SubscriptionSourceSort) {
    replaceParams({
      sortBy: key,
      direction: sortBy === key && direction === 'asc' ? 'desc' : 'asc',
    })
  }
  const all = sources.data?.items ?? []
  const items = filterSubscriptionSources(all, {
    q,
    type: null,
    types,
    history,
    sortBy,
    direction,
  })
  const narrowed = Boolean(q || types.length || history.length)
  const noun = { one: 'channel', other: 'channels' }
  return (
    <section className="bi-workspace" aria-label="Channels">
      <PageHead title="Channels" />
      <SecondaryTableToolbar
        search={
          <SecondaryTableSearch
            label="Filter by name"
            value={draft}
            maxLength={200}
            onChange={setDraft}
          />
        }
        count={
          sources.data ? (
            formatItemCount(
              items.length,
              noun,
              narrowed ? all.length : undefined,
            )
          ) : (
            <Skeleton className="bi-count-skeleton" width={64} height={10} />
          )
        }
        columns={columns.controls}
      />
      {/* The table is the only scroller and takes the height the toolbar leaves. */}
      <SecondaryTableScroll
        className="min-h-0 flex-1"
        role="region"
        aria-label="Channels and podcasts"
        aria-busy={sources.isFetching}
      >
        <table className="ds-table" aria-label="Channels and podcasts">
          <TableHeader>
            <TableRow>
              {subscriptionSourceColumns
                .filter((column) => columns.visible(column.key))
                .map((column) => (
                  <SecondaryTableHead
                    key={column.key}
                    sortKey={column.key}
                    label={column.label}
                    sortBy={sortBy}
                    direction={direction}
                    onSort={sort}
                    align={column.numeric ? 'end' : undefined}
                    sticky={column.key === 'title' ? 0 : undefined}
                    stickyEdge={column.key === 'title'}
                    filter={
                      column.key === 'type' ? (
                        <SecondaryColumnFilter
                          label="Type"
                          options={SubscriptionTypeSchema.options.map(
                            (value) => ({
                              value,
                              label: subscriptionTypeLabels[value],
                            }),
                          )}
                          value={types}
                          onChange={(next) =>
                            replaceParams({
                              type: null,
                              types: next.length ? JSON.stringify(next) : null,
                            })
                          }
                        />
                      ) : column.key === 'historyComplete' ? (
                        <SecondaryColumnFilter
                          label="History"
                          options={[
                            { value: 'complete', label: 'Complete' },
                            { value: 'reading', label: 'Reading history' },
                          ]}
                          value={history}
                          onChange={(next) => replaceParams({ history: next })}
                        />
                      ) : undefined
                    }
                  />
                ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {sources.isPending &&
              Array.from({ length: 8 }, (_, index) => (
                <TableRow key={index} aria-hidden="true" data-placeholder="">
                  {Array.from({ length: columns.count }, (_, cell) => (
                    <TableCell key={cell}>
                      <Skeleton height={10} width="70%" />
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            {!sources.isPending && !items.length && (
              <TableState colSpan={columns.count} error={sources.isError}>
                {sources.isError ? (
                  <>
                    Could not load channels.{' '}
                    <RetryButton onClick={() => sources.refetch()} />
                  </>
                ) : all.length ? (
                  <>
                    No channels match.{' '}
                    <Button
                      size="xs"
                      onClick={() => {
                        setDraft('')
                        replaceParams({ type: null, types: null, history: [] })
                      }}
                    >
                      Clear filters
                    </Button>
                  </>
                ) : (
                  <>
                    No channels yet. Sync channels and podcasts in{' '}
                    <Link href={subscriptionImportsHref}>Imports</Link>.
                  </>
                )}
              </TableState>
            )}
            {items.map((source) => (
              <SourceRow
                key={source.id}
                source={source}
                visible={columns.visible}
                selected={source.id === selectedId}
              />
            ))}
          </TableBody>
        </table>
      </SecondaryTableScroll>
    </section>
  )
}
