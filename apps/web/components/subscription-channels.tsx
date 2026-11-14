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
import { Input } from '@repo/ui/components/ui/input'
import {
  TableBody,
  TableCell,
  TableHeader,
  TableRow,
  TableState,
} from '@repo/ui/components/ui/table'
import { useConfig } from './providers'
import { SourceAvatar } from './subscription-item-details'
import { fetchApiData } from '@/utils/api'
import {
  filterSubscriptionSources,
  formatSubscriptionSourceSize,
  parseSubscriptionType,
  subscriptionImportsHref,
  subscriptionSourceColumns,
  subscriptionSourceHref,
  subscriptionSourceSort,
  type SubscriptionSourceSort,
} from '@/utils/subscriptions'
import styles from './subscription-browser.module.css'
import {
  SecondaryTableScroll,
  SecondaryTableHead,
  useTableColumns,
} from './secondary-table'

export function useSubscriptionSources() {
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

function replaceParams(updates: Record<string, string | null>) {
  const params = new URLSearchParams(window.location.search)
  for (const [key, value] of Object.entries(updates)) {
    if (value) params.set(key, value)
    else params.delete(key)
  }
  window.history.replaceState(
    null,
    '',
    `${window.location.pathname}${params.size ? `?${params}` : ''}`,
  )
}

function SourceRow({
  source,
  visible,
}: {
  source: SubscriptionSource
  visible: (key: string) => boolean
}) {
  return (
    <TableRow>
      {visible('title') && (
        <TableCell>
          <span className={styles.sourceCell}>
            <SourceAvatar src={source.thumbnailUrl} />
            <Link
              href={subscriptionSourceHref(source.title)}
              title={`Browse ${source.title}`}
            >
              {source.title}
            </Link>
          </span>
        </TableCell>
      )}
      {visible('type') && (
        <TableCell>{subscriptionTypeLabels[source.type]}</TableCell>
      )}
      {visible('storedItems') && (
        <TableCell className="numeric">
          {source.storedItems.toLocaleString()}
          {!source.historyComplete && (
            <div className="muted">Reading history</div>
          )}
        </TableCell>
      )}
      {visible('latestItemAt') && (
        <TableCell className="whitespace-nowrap">
          {source.latestItemAt ? (
            <time dateTime={source.latestItemAt}>
              {new Date(source.latestItemAt).toLocaleDateString()}
            </time>
          ) : (
            '-'
          )}
        </TableCell>
      )}
      {visible('size') && (
        <TableCell className="numeric whitespace-nowrap">
          {formatSubscriptionSourceSize(source)}
        </TableCell>
      )}
      {visible('description') && (
        <TableCell>{source.description ?? '-'}</TableCell>
      )}
      {visible('handle') && (
        <TableCell>
          {source.type === 'youtube' ? (source.handle ?? '-') : '-'}
        </TableCell>
      )}
      {visible('historyComplete') && (
        <TableCell>
          {source.historyComplete ? 'Complete' : 'Reading history'}
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
  const sources = useSubscriptionSources()
  const sortBy = subscriptionSourceSort(search.get('sortBy'))
  const direction = search.get('direction') === 'desc' ? 'desc' : 'asc'
  const type = parseSubscriptionType(search.get('type'))
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
  const items = filterSubscriptionSources(all, { q, type, sortBy, direction })
  const narrowed = Boolean(q || type)
  return (
    <section
      className="admin-page table-workspace"
      aria-labelledby="subscription-channels"
    >
      <div className="tags-toolbar">
        <h1 id="subscription-channels">Channels</h1>
      </div>
      <div className="job-toolbar">
        {columns.controls}
        <Input
          type="search"
          aria-label="Filter by name"
          placeholder="Filter by name"
          value={draft}
          maxLength={200}
          onChange={(event) => setDraft(event.target.value)}
        />
        <select
          aria-label="Type"
          value={type ?? ''}
          onChange={(event) =>
            replaceParams({ type: event.target.value || null })
          }
        >
          <option value="">All types</option>
          {SubscriptionTypeSchema.options.map((option) => (
            <option key={option} value={option}>
              {subscriptionTypeLabels[option]}
            </option>
          ))}
        </select>
        <span className="muted" aria-live="polite">
          {sources.data
            ? narrowed
              ? `${items.length.toLocaleString()} of ${all.length.toLocaleString()}`
              : `${all.length.toLocaleString()} ${all.length === 1 ? 'source' : 'sources'}`
            : ''}
        </span>
      </div>
      {/* The table is the only scroller and takes the height the toolbar leaves. */}
      <SecondaryTableScroll
        className="tags-scroll min-h-0 flex-1"
        role="region"
        aria-label="Channels and podcasts"
        aria-busy={sources.isFetching}
      >
        <table className="compact-table" aria-label="Channels and podcasts">
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
                    className={column.numeric ? 'numeric' : undefined}
                  />
                ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {!items.length && (
              <TableState colSpan={columns.count} error={sources.isError}>
                {sources.isPending ? (
                  'Loading channels...'
                ) : sources.isError ? (
                  <>
                    Could not load channels.{' '}
                    <button
                      type="button"
                      className="underline"
                      onClick={() => sources.refetch()}
                    >
                      Retry
                    </button>
                  </>
                ) : all.length ? (
                  'No channels match.'
                ) : (
                  <>
                    Nothing synced yet. Sync channels and podcasts in{' '}
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
              />
            ))}
          </TableBody>
        </table>
      </SecondaryTableScroll>
    </section>
  )
}
