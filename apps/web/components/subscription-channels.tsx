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
  SecondaryTableToolbar,
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
          <div className="secondary-cell-actions">
            <SourceAvatar src={source.thumbnailUrl} />
            <SecondaryCell text={source.title}>
              <Link
                href={subscriptionSourceHref(source.title)}
                title={`Browse ${source.title}`}
              >
                {source.title}
              </Link>
            </SecondaryCell>
          </div>
        </TableCell>
      )}
      {visible('type') && (
        <TableCell>{subscriptionTypeLabels[source.type]}</TableCell>
      )}
      {visible('storedItems') && (
        <TableCell className="numeric">
          <SecondaryCell
            details={!source.historyComplete ? 'Reading history' : undefined}
            label={`History for ${source.title}`}
          >
            {source.storedItems.toLocaleString()}
          </SecondaryCell>
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
        <TableCell>
          <SecondaryCell
            text={source.description ?? undefined}
            details={source.description || undefined}
            label={`Description of ${source.title}`}
          >
            {source.description ?? '-'}
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
            {source.type === 'youtube' ? (source.handle ?? '-') : '-'}
          </SecondaryCell>
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
  return (
    <section
      className="admin-page table-workspace"
      aria-labelledby="subscription-channels"
    >
      <h1 id="subscription-channels">Channels</h1>
      <SecondaryTableToolbar
        search={
          <Input
            type="search"
            aria-label="Filter by name"
            placeholder="Filter by name"
            value={draft}
            maxLength={200}
            onChange={(event) => setDraft(event.target.value)}
          />
        }
        count={
          <span aria-live="polite">
            {sources.data
              ? narrowed
                ? `${items.length.toLocaleString()} of ${all.length.toLocaleString()}`
                : `${all.length.toLocaleString()} ${all.length === 1 ? 'source' : 'sources'}`
              : ''}
          </span>
        }
        columns={columns.controls}
      />
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
                          onChange={(next) => {
                            const params = new URLSearchParams(
                              window.location.search,
                            )
                            params.delete('history')
                            for (const value of next)
                              params.append('history', value)
                            window.history.replaceState(
                              null,
                              '',
                              `${window.location.pathname}?${params}`,
                            )
                          }}
                        />
                      ) : undefined
                    }
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
