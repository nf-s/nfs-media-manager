'use client'

import Link from 'next/link'
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { History, Pencil } from 'lucide-react'
import { JobPageSchema, type Job } from '@repo/schemas/job'
import {
  SourceSnapshotPageSchema,
  SourceSnapshotSchema,
} from '@repo/schemas/media'
import {
  ProviderSummarySchema,
  type ProviderSummary,
} from '@repo/schemas/provider'
import { z } from 'zod'
import type { ExternalLinkSchema } from '@repo/schemas/common'
import { Button } from '@repo/ui/components/ui/button'
import { TableState } from '@repo/ui/components/ui/table'
import { useVirtualTable } from '@/hooks/useVirtualTable'
import { fetchApiData } from '@/utils/api'
import { canCancelJob } from '@/utils/job-selection'
import { sortTableRows, type TableSort } from '@/utils/secondary-table'
import JsonTree from './json-tree'
import { errorMessage } from './lastfm-sync'
import MediaHistoryJobs from './media-history-jobs'
import { providerLocalWorkerQuery } from './provider-local-worker'
import { useConfig } from './providers'
import {
  SecondaryCell,
  SecondaryTableFooter,
  SecondaryTableFrame,
  SecondaryTableHead,
  SecondaryTableScroll,
  SecondaryTableToolbar,
  SecondaryVirtualRows,
} from './secondary-table'
import { Input } from '@repo/ui/components/ui/input'
import ServiceIconLinks from './service-icon-links'

type SourceScope = { kind: 'album' | 'film' | 'artist'; id: string }
export type ProviderSourceRow = {
  id: string
  label: string
  identifier?: string
  updatedAt?: string
  links?: z.infer<typeof ExternalLinkSchema>[]
  unavailable?: string
  refresh?: () => Promise<Job>
  editor?: (canRefresh: boolean) => ReactNode
  details?: ReactNode
}
const sourceColumns = [
  { key: 'label', label: 'Provider' },
  { key: 'identifier', label: 'Identifier' },
  { key: 'updatedAt', label: 'Updated' },
] satisfies { key: 'label' | 'identifier' | 'updatedAt'; label: string }[]
type SourceSortKey = (typeof sourceColumns)[number]['key']

function scopeParams(scope: SourceScope): Record<string, string> {
  return scope.kind === 'artist'
    ? { artistId: scope.id }
    : { mediaItemId: scope.id }
}

export function useSourceCatalog() {
  const { apiBaseUrl } = useConfig()
  return useQuery({
    queryKey: ['providers'],
    queryFn: ({ signal }) =>
      fetchApiData(
        apiBaseUrl,
        '/api/v1/providers',
        z.array(ProviderSummarySchema),
        { signal },
      ),
  })
}

export function useSourceAvailability(providers: ProviderSummary[]) {
  const { apiBaseUrl } = useConfig()
  const workerIds = [
    ...new Set(
      providers
        .filter((provider) => provider.supportsLocalWorker)
        .map((provider) => provider.id),
    ),
  ]
  const workers = useQueries({
    queries: workerIds.map((id) => providerLocalWorkerQuery(apiBaseUrl, id)),
  })

  return function sourceUnavailable(provider: ProviderSummary | undefined) {
    if (!provider) return 'Provider unavailable'
    if (provider.safety?.halted) return 'Provider halted'
    const cooldown = provider.safety?.cooldownUntil
    if (cooldown && Date.parse(cooldown) > Date.now())
      return 'Provider cooling down'
    if (provider.supportsLocalWorker) {
      const worker = workers[workerIds.indexOf(provider.id)]
      if (worker?.isError) return 'Worker status unavailable'
      const status = worker?.data
      if (!status) return 'Checking worker status...'
      // Unresolved local requests block dispatch in either mode.
      if (status.blocked) return 'Local worker needs review'
      if (status.mode === 'local') {
        if (!status.configured) return 'Local worker not configured'
        if (!status.paired) return 'Local worker not paired'
        if (!status.online) return 'Local worker offline'
        return undefined
      }
    }
    if (provider.secrets.some((field) => field.required && !field.configured))
      return 'Credentials required'
    return undefined
  }
}

function jobLink(job: string, scope: SourceScope) {
  return `/jobs?${new URLSearchParams({ jobId: job, mediaType: scope.kind === 'film' ? 'film' : 'album' })}`
}

function sourcePath(scope: SourceScope, provider: string) {
  const resource = scope.kind === 'artist' ? 'artists' : 'media'
  return `/api/v1/${resource}/${encodeURIComponent(scope.id)}/sources/${encodeURIComponent(provider)}`
}

function SnapshotDetails({
  scope,
  provider,
  id,
}: {
  scope: SourceScope
  provider: string
  id: string
}) {
  const { apiBaseUrl } = useConfig()
  const snapshot = useQuery({
    queryKey: ['history', scope.id, scope.kind, provider, id],
    queryFn: ({ signal }) =>
      fetchApiData(
        apiBaseUrl,
        `${sourcePath(scope, provider)}/snapshots/${encodeURIComponent(id)}`,
        SourceSnapshotSchema,
        { signal },
      ),
  })
  if (snapshot.isError && !snapshot.data)
    return (
      <ErrorWithRetry
        message="Could not load the snapshot."
        onRetry={() => snapshot.refetch()}
      />
    )
  if (!snapshot.data)
    return (
      <p role="status" className="quiet">
        Loading snapshot...
      </p>
    )
  return (
    <div className="min-w-0 space-y-2">
      {snapshot.data.normalizedData !== null && (
        <details>
          <summary>Normalized data</summary>
          <JsonTree value={snapshot.data.normalizedData} />
        </details>
      )}
      <details open>
        <summary>Stored response</summary>
        <JsonTree value={snapshot.data.data} />
      </details>
    </div>
  )
}

function ErrorWithRetry({
  message,
  onRetry,
}: {
  message: string
  onRetry: () => void
}) {
  return (
    <p role="alert" className="quiet">
      {message}{' '}
      <button type="button" className="underline" onClick={onRetry}>
        Retry
      </button>
    </p>
  )
}

function SourceHistory({
  scope,
  row,
}: {
  scope: SourceScope
  row: ProviderSourceRow
}) {
  const { apiBaseUrl } = useConfig()
  const [selectedSnapshot, setSelectedSnapshot] = useState<string | null>(null)
  const history = useVirtualTable({
    queryKey: ['history', scope.id, scope.kind, row.id, 'snapshots'],
    pageSize: 20,
    loadPage: (page, size, signal) =>
      fetchApiData(
        apiBaseUrl,
        `${sourcePath(scope, row.id)}/history?${new URLSearchParams({ page: String(page), size: String(size) })}`,
        SourceSnapshotPageSchema,
        { signal },
      ),
  })
  return (
    <section aria-label={`${row.label} history`} className="space-y-3">
      <h2 className="text-sm font-semibold">{row.label} history</h2>
      {row.details}
      <section aria-label="Snapshots" className="space-y-1">
        <h3 className="text-sm font-semibold">Snapshots</h3>
        {history.isError && (
          <ErrorWithRetry
            message="Could not load snapshots."
            onRetry={history.retry}
          />
        )}
        <SecondaryTableScroll
          ref={history.scroller}
          onScroll={history.onScroll}
          className="table-scroll-bounded"
          role="region"
          aria-label="Snapshots"
          aria-busy={history.isFetching}
        >
          <table
            className="compact-table"
            aria-label="Snapshots"
            aria-rowcount={history.hasTotal ? history.total + 1 : undefined}
          >
            <thead>
              <tr>
                <th>Saved</th>
                <th>Source</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {history.hasTotal && !history.total && (
                <TableState colSpan={3}>No snapshots.</TableState>
              )}
              <SecondaryVirtualRows
                window={history}
                colSpan={3}
                renderRow={(snapshot, index) => {
                  const open = selectedSnapshot === snapshot.id
                  return (
                    <tr key={snapshot.id} aria-rowindex={index + 2}>
                      <td>
                        <time dateTime={snapshot.createdAt}>
                          {new Date(snapshot.createdAt).toLocaleString()}
                        </time>
                      </td>
                      <td>
                        <SecondaryCell>{snapshot.source ?? '-'}</SecondaryCell>
                      </td>
                      <td>
                        <div className="secondary-cell-actions">
                          <button
                            type="button"
                            className="underline underline-offset-2"
                            aria-expanded={open}
                            onClick={() =>
                              setSelectedSnapshot(open ? null : snapshot.id)
                            }
                          >
                            {open ? 'Hide snapshot' : 'View snapshot'}
                          </button>
                          {snapshot.jobId && (
                            <Link
                              className="underline underline-offset-2"
                              href={jobLink(snapshot.jobId, scope)}
                            >
                              View job
                            </Link>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                }}
              />
            </tbody>
          </table>
        </SecondaryTableScroll>
        {selectedSnapshot && (
          <SnapshotDetails
            scope={scope}
            provider={row.id}
            id={selectedSnapshot}
          />
        )}
      </section>
      {scope.kind === 'artist' ? (
        <MediaHistoryJobs artistId={scope.id} provider={row.id} />
      ) : (
        <MediaHistoryJobs mediaItemId={scope.id} provider={row.id} />
      )}
    </section>
  )
}

export function ProviderSources({
  rows,
  scope,
  initialProvider,
  pending,
  unavailable,
  onRetry,
}: {
  rows: ProviderSourceRow[]
  scope?: SourceScope
  initialProvider?: string
  pending?: boolean
  unavailable?: string
  onRetry?: () => void
}) {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const [selected, setSelected] = useState<string[]>([])
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<TableSort<SourceSortKey>>({
    key: 'label',
    direction: 'asc',
  })
  const [opened, setOpened] = useState<{
    provider: string
    type: 'history' | 'edit'
  } | null>(
    initialProvider ? { provider: initialProvider, type: 'history' } : null,
  )
  const selectAll = useRef<HTMLInputElement>(null)
  const refreshable = Boolean(scope && rows.some((row) => row.refresh))
  const activeJobs = useQuery({
    queryKey: ['jobs', 'source-refresh-active', scope],
    enabled: refreshable,
    queryFn: ({ signal }) =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/scrape/jobs?${new URLSearchParams({ ...(scope ? scopeParams(scope) : {}), status: 'active', size: '100' })}`,
        JobPageSchema,
        { signal },
      ),
    refetchInterval: (query) =>
      query.state.data?.items.some(canCancelJob) ? 3000 : false,
  })
  const refresh = useMutation({
    mutationFn: async (targets: ProviderSourceRow[]) => {
      const results: { row: ProviderSourceRow; job?: Job; error?: string }[] =
        []
      for (const row of targets) {
        if (!row.refresh) continue
        try {
          results.push({ row, job: await row.refresh() })
        } catch (error) {
          results.push({
            row,
            error: errorMessage(error, 'Could not queue refresh.'),
          })
        }
      }
      return results
    },
    onSuccess: async (results) => {
      await Promise.all([
        client.invalidateQueries({ queryKey: ['jobs'] }),
        client.invalidateQueries({ queryKey: ['job-activity'] }),
        ...(scope && scope.kind !== 'artist'
          ? [
              client.invalidateQueries({
                queryKey: [`${scope.kind}-selection`],
              }),
            ]
          : []),
      ])
      setSelected(results.flatMap(({ row, error }) => (error ? [row.id] : [])))
    },
  })
  const recentlyQueued = activeJobs.data?.items ?? []
  const active = new Set(
    recentlyQueued.filter(canCancelJob).map((job) => job.provider),
  )
  const query = search.trim().toLocaleLowerCase()
  const matches = query
    ? rows.filter((row) =>
        [row.label, row.identifier].some((field) =>
          field?.toLocaleLowerCase().includes(query),
        ),
      )
    : rows
  const ordered = sortTableRows(matches, sort, (row, key) =>
    key === 'updatedAt' && row.updatedAt ? Date.parse(row.updatedAt) : row[key],
  )
  const canRefresh = (row: ProviderSourceRow) =>
    activeJobs.isSuccess &&
    Boolean(row.refresh && !row.unavailable && !active.has(row.id))
  const eligible = ordered.filter(canRefresh)
  const checked = eligible.filter((row) => selected.includes(row.id))
  const allChecked = eligible.length > 0 && checked.length === eligible.length
  useEffect(() => {
    if (selectAll.current)
      selectAll.current.indeterminate = checked.length > 0 && !allChecked
  }, [checked.length, allChecked])
  const targets = checked.length ? checked : eligible
  const expandedRow = rows.find((row) => row.id === opened?.provider)
  const hasActions = Boolean(
    scope || rows.some((row) => row.editor || row.details),
  )
  const columnCount = 3 + Number(refreshable) + Number(hasActions)
  return (
    <div className="space-y-3">
      {unavailable && onRetry && (
        <ErrorWithRetry message={unavailable} onRetry={onRetry} />
      )}
      {activeJobs.isError && refreshable && (
        <ErrorWithRetry
          message="Could not check active jobs."
          onRetry={() => activeJobs.refetch()}
        />
      )}
      <SecondaryTableToolbar
        search={
          rows.length > 3 ? (
            <Input
              type="search"
              aria-label="Search sources"
              placeholder="Search providers or identifiers"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value)
                setSelected([])
              }}
            />
          ) : undefined
        }
        count={`${ordered.length.toLocaleString()} ${ordered.length === 1 ? 'source' : 'sources'}`}
      />
      <SecondaryTableFrame>
        <SecondaryTableScroll role="region" aria-label="Sources">
          <table className="compact-table" aria-label="Sources">
            <thead>
              <tr>
                {refreshable && (
                  <th className="w-10">
                    <input
                      type="checkbox"
                      ref={selectAll}
                      aria-label="Select all eligible sources"
                      checked={allChecked}
                      disabled={!eligible.length || refresh.isPending}
                      onChange={() =>
                        setSelected(
                          allChecked ? [] : eligible.map((row) => row.id),
                        )
                      }
                    />
                  </th>
                )}
                {sourceColumns.map(({ key, label }) => (
                  <SecondaryTableHead
                    key={key}
                    label={label}
                    sortKey={key}
                    sortBy={sort.key}
                    direction={sort.direction}
                    onSort={(key) => {
                      setSort({
                        key,
                        direction:
                          key === sort.key && sort.direction === 'asc'
                            ? 'desc'
                            : 'asc',
                      })
                      setSelected([])
                    }}
                  />
                ))}
                {hasActions && (
                  <th className="w-[100px]">
                    <span className="sr-only">Actions</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {ordered.length === 0 && (
                <TableState colSpan={columnCount}>
                  {pending
                    ? 'Loading sources...'
                    : (unavailable ??
                      (query ? 'No matching sources.' : 'No sources.'))}
                </TableState>
              )}
              {ordered.map((row) => (
                <tr key={row.id}>
                  {refreshable && (
                    <td>
                      <input
                        type="checkbox"
                        checked={checked.some((entry) => entry.id === row.id)}
                        aria-label={`Select ${row.label}`}
                        disabled={
                          refresh.isPending ||
                          !eligible.some((entry) => entry.id === row.id)
                        }
                        onChange={(event) =>
                          setSelected(
                            event.target.checked
                              ? [...selected, row.id]
                              : selected.filter((id) => id !== row.id),
                          )
                        }
                      />
                    </td>
                  )}
                  <td>
                    <div className="secondary-cell-actions">
                      <SecondaryCell>{row.label}</SecondaryCell>
                      {row.links && <ServiceIconLinks links={row.links} />}
                    </div>
                  </td>
                  <td>
                    <SecondaryCell>{row.identifier ?? '-'}</SecondaryCell>
                  </td>
                  <td>
                    <SecondaryCell>
                      {active.has(row.id) ? (
                        'Refresh in progress'
                      ) : row.updatedAt ? (
                        <time dateTime={row.updatedAt} title={row.unavailable}>
                          {new Date(row.updatedAt).toLocaleString()}
                        </time>
                      ) : (
                        (row.unavailable ?? '-')
                      )}
                    </SecondaryCell>
                  </td>
                  {hasActions && (
                    <td>
                      <div className="flex items-center gap-1">
                        {row.editor && (
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="size-7 p-0"
                            title={`Edit ${row.label} identifier`}
                            aria-label={`Edit ${row.label} identifier`}
                            aria-expanded={
                              opened?.provider === row.id &&
                              opened.type === 'edit'
                            }
                            onClick={() =>
                              setOpened(
                                opened?.provider === row.id &&
                                  opened.type === 'edit'
                                  ? null
                                  : { provider: row.id, type: 'edit' },
                              )
                            }
                          >
                            <Pencil size={14} aria-hidden="true" />
                          </Button>
                        )}
                        {(scope || row.details) && (
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="size-7 p-0"
                            title={`${row.label} ${scope ? 'history' : 'details'}`}
                            aria-label={`${row.label} ${scope ? 'history' : 'details'}`}
                            aria-expanded={
                              opened?.provider === row.id &&
                              opened.type === 'history'
                            }
                            onClick={() =>
                              setOpened(
                                opened?.provider === row.id &&
                                  opened.type === 'history'
                                  ? null
                                  : { provider: row.id, type: 'history' },
                              )
                            }
                          >
                            <History size={15} aria-hidden="true" />
                          </Button>
                        )}
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </SecondaryTableScroll>
        {refreshable && (
          <SecondaryTableFooter selectedCount={checked.length || undefined}>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!targets.length || refresh.isPending}
              onClick={() => refresh.mutate(targets)}
            >
              {refresh.isPending
                ? 'Queuing...'
                : checked.length
                  ? 'Refresh selected'
                  : query
                    ? 'Refresh matching sources'
                    : 'Refresh all eligible'}
            </Button>
          </SecondaryTableFooter>
        )}
      </SecondaryTableFrame>
      {scope && refresh.data?.length ? (
        <ul className="space-y-1 text-sm" aria-label="Refresh results">
          {refresh.data.map(({ row, job, error }) => (
            <li key={row.id} role={error ? 'alert' : 'status'}>
              {row.label} ·{' '}
              {error ??
                (job && (
                  <Link
                    className="underline underline-offset-2"
                    href={jobLink(job.id, scope)}
                  >
                    View refresh job
                  </Link>
                ))}
            </li>
          ))}
        </ul>
      ) : null}
      {expandedRow && (
        <Fragment key={expandedRow.id}>
          {opened?.type === 'edit' &&
            expandedRow.editor?.(canRefresh(expandedRow) && !refresh.isPending)}
          {opened?.type === 'history' &&
            (scope ? (
              <SourceHistory scope={scope} row={expandedRow} />
            ) : (
              expandedRow.details
            ))}
        </Fragment>
      )}
    </div>
  )
}
