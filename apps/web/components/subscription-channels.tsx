'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import {
  SubscriptionSourceListSchema,
  subscriptionLibraryLabels,
  subscriptionLibraryTypes,
  subscriptionTypeLabels,
  type SubscriptionLibrary,
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
  libraryScopeQuery,
  libraryScopeUpdates,
  readLibraryScope,
  type LibraryScopeState,
} from '@/utils/library-scope'
import {
  filterSubscriptionSources,
  formatSubscriptionSourceSize,
  parseSubscriptionType,
  parseSubscriptionTypes,
  subscriptionLibraryPages,
  subscriptionLibraryParams,
  subscriptionSourceColumnsFor,
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

const columnWidths: Record<SubscriptionSourceSort, number> = {
  title: 300,
  type: 130,
  storedItems: 120,
  latestItemAt: 110,
  size: 180,
  description: 240,
  handle: 160,
  historyComplete: 150,
}
function sourceColumns(library: SubscriptionLibrary) {
  return subscriptionSourceColumnsFor[library].map((column) => ({
    ...column,
    width: columnWidths[column.key],
    fill: column.key === 'title',
  }))
}
const sourceColumnsFor: Record<
  SubscriptionLibrary,
  ReturnType<typeof sourceColumns>
> = {
  subscriptions: sourceColumns('subscriptions'),
  mixes: sourceColumns('mixes'),
}

function useSubscriptionSources(
  library: SubscriptionLibrary,
  scope: LibraryScopeState,
) {
  const { apiBaseUrl } = useConfig()
  const params = new URLSearchParams({
    ...subscriptionLibraryParams(library),
    ...libraryScopeQuery(scope),
  })
  return useQuery({
    queryKey: [
      subscriptionLibraryPages[library].collection,
      'sources',
      params.toString(),
    ],
    queryFn: ({ signal }) =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/subscriptions/sources${params.size ? `?${params}` : ''}`,
        SubscriptionSourceListSchema,
        { signal },
      ),
  })
}

const emptyHelp: Record<SubscriptionLibrary, string> = {
  subscriptions: 'Sync channels and podcasts in',
  mixes: 'Sync station archives in',
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

/** One cell of a channel or show row; the cells follow the table's column order. */
function SourceCell({
  source,
  column,
  library,
}: {
  source: SubscriptionSource
  column: SubscriptionSourceSort
  library: SubscriptionLibrary
}) {
  const page = subscriptionLibraryPages[library]
  switch (column) {
    case 'title':
      return (
        <TableCell sticky={0} stickyEdge>
          <span className="ds-cell-id">
            <MediaThumb
              kind={library === 'mixes' ? 'album' : 'person'}
              src={source.thumbnailUrl}
            />
            <DetailLink
              kind={page.sourceKind}
              id={source.id}
              className="ds-cell-title"
              title={source.title}
            >
              {source.title}
            </DetailLink>
          </span>
        </TableCell>
      )
    case 'type':
      return <TableCell>{subscriptionTypeLabels[source.type]}</TableCell>
    case 'storedItems':
      return (
        <TableCell align="end">
          <SecondaryCell
            details={!source.historyComplete ? 'Reading history' : undefined}
            label={`History for ${source.title}`}
          >
            <Link
              href={subscriptionSourceHref(source.id, library)}
              title={`Filter ${page.plural} by ${source.title}`}
              aria-label={`Filter ${page.plural} by ${source.title}`}
            >
              {formatCount(source.storedItems)}
            </Link>
          </SecondaryCell>
        </TableCell>
      )
    case 'latestItemAt':
      return (
        <TableCell>
          {source.latestItemAt ? (
            <time dateTime={source.latestItemAt}>
              {formatDate(source.latestItemAt)}
            </time>
          ) : (
            <EmptyValue />
          )}
        </TableCell>
      )
    case 'size':
      return (
        <TableCell align="end">
          {formatSubscriptionSourceSize(source)}
        </TableCell>
      )
    case 'description':
      return (
        <TableCell>
          <SecondaryCell
            text={source.description ?? undefined}
            details={source.description || undefined}
            label={`Description of ${source.title}`}
          >
            {source.description ?? <EmptyValue />}
          </SecondaryCell>
        </TableCell>
      )
    case 'handle':
      return (
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
      )
    case 'historyComplete':
      return (
        <TableCell>
          {source.historyComplete ? (
            <Status state="done">Complete</Status>
          ) : (
            <Status state="running">Reading history</Status>
          )}
        </TableCell>
      )
  }
}

function SourceRow({
  source,
  columns,
  selected,
  library,
}: {
  source: SubscriptionSource
  columns: readonly { key: SubscriptionSourceSort }[]
  selected: boolean
  library: SubscriptionLibrary
}) {
  return (
    <TableRow selected={selected}>
      {columns.map((column) => (
        <SourceCell
          key={column.key}
          source={source}
          column={column.key}
          library={library}
        />
      ))}
    </TableRow>
  )
}

/** Subscribed channels and podcasts, or a station's shows in Mixes. */
export default function SubscriptionChannels({
  library = 'subscriptions',
}: {
  library?: SubscriptionLibrary
}) {
  const page = subscriptionLibraryPages[library]
  const sourceColumns = sourceColumnsFor[library]
  const columns = useTableColumns(
    library === 'mixes' ? 'mix-shows' : 'subscription-channels',
    sourceColumns,
    { reorder: true },
  )
  const shownColumns = columns
    .order(sourceColumns)
    .filter((column) => columns.visible(column.key))
  const layout = columns.layout(shownColumns.map((column) => column.key))
  const search = useSearchParams()
  const inspector = useDetailInspector()
  const selectedId =
    inspector?.root?.kind === page.sourceKind ? inspector.root.id : null
  const libraryScope = readLibraryScope(search)
  const sources = useSubscriptionSources(library, libraryScope)
  const sortBy = subscriptionSourceSort(search.get('sortBy'), library)
  const direction = search.get('direction') === 'desc' ? 'desc' : 'asc'
  const type = parseSubscriptionType(search.get('type'), library)
  const types = search.has('types')
    ? parseSubscriptionTypes(search.get('types'), library)
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
  const noun = page.sources
  const tableLabel = library === 'mixes' ? 'Shows' : 'Channels and podcasts'
  const typeLabel = subscriptionLibraryLabels[library].type
  return (
    <section className="bi-workspace" aria-label={page.sourcesTitle}>
      <PageHead title={page.sourcesTitle} />
      <SecondaryTableToolbar
        libraryScope={{
          value: libraryScope,
          onChange: (next) => replaceParams(libraryScopeUpdates(next)),
        }}
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
        aria-label={tableLabel}
        aria-busy={sources.isFetching}
      >
        <table className="ds-table" aria-label={tableLabel} {...layout.table}>
          {layout.colgroup}
          <TableHeader>
            <TableRow>
              {shownColumns.map((column) => (
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
                  resizer={columns.resizer(column.key)}
                  filter={
                    column.key === 'type' ? (
                      <SecondaryColumnFilter
                        label={typeLabel}
                        options={subscriptionLibraryTypes[library].map(
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
                    Could not load {noun.other}.{' '}
                    <RetryButton onClick={() => sources.refetch()} />
                  </>
                ) : all.length ? (
                  <>
                    No {noun.other} match.{' '}
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
                    No {noun.other} yet. {emptyHelp[library]}{' '}
                    <Link href={page.importsHref}>Imports</Link>.
                  </>
                )}
              </TableState>
            )}
            {items.map((source) => (
              <SourceRow
                key={source.id}
                source={source}
                columns={shownColumns}
                selected={source.id === selectedId}
                library={library}
              />
            ))}
          </TableBody>
        </table>
      </SecondaryTableScroll>
    </section>
  )
}
