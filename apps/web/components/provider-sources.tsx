'use client'

import Link from 'next/link'
import { useState, type ReactNode } from 'react'
import {
  useInfiniteQuery,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { ExternalLink, Pencil, RefreshCw } from 'lucide-react'
import { JobPageSchema, type Job, type JobPage } from '@repo/schemas/job'
import {
  SourceSnapshotPageSchema,
  SourceSnapshotSchema,
  type SourceSnapshotSummary,
} from '@repo/schemas/media'
import {
  ProviderSummarySchema,
  type ProviderSummary,
} from '@repo/schemas/provider'
import { z } from 'zod'
import type { ExternalLinkSchema } from '@repo/schemas/common'
import { Section } from '@repo/ui/components/ds/facts'
import { Notice, Skeleton, State } from '@repo/ui/components/ds/feedback'
import { Pill, Pills, ProviderMark } from '@repo/ui/components/ds/pill'
import {
  SourceBlock,
  SourceRow,
  Timeline,
  type TimelineItem,
} from '@repo/ui/components/ds/source'
import { Status } from '@repo/ui/components/ds/status'
import { Button } from '@repo/ui/components/ui/button'
import { formatAge, formatDateTime } from '@repo/ui/lib/format'
import { fetchApiData } from '@/utils/api'
import { canCancelJob } from '@/utils/job-selection'
import {
  jobState,
  mergeHistory,
  providerMarkText,
  sourceMatch,
  sourcesSummary,
  unavailableState,
  type SourceMatch,
} from '@/utils/source-rows'
import { DetailLink } from './detail-link'
import { useDetailView } from './detail-inspector-context'
import JsonTree from './json-tree'
import { errorMessage } from './lastfm-sync'
import { providerLocalWorkerQuery } from './provider-local-worker'
import { useConfig } from './providers'

type SourceScope = { kind: 'album' | 'film' | 'artist'; id: string }
export type ProviderSourceRow = {
  id: string
  label: string
  identifier?: string
  /** Where the identifier came from, shown in the open row. */
  identifierDetails?: () => ReactNode
  updatedAt?: string
  links?: z.infer<typeof ExternalLinkSchema>[]
  unavailable?: string
  refresh?: () => Promise<Job>
  /** The identifier form. `close` closes the row, for a Cancel button. */
  editor?: (canRefresh: boolean, close: () => void) => ReactNode
  details?: ReactNode
  /** The provider's page under Providers. */
  href?: string
  /** Overrides the match state derived from the identifier and snapshot. */
  match?: SourceMatch
  /** Fields this provider supplies to the item. */
  provides?: string[]
  /** Further blocks shown in the open row, such as scrobble names. */
  blocks?: { title: string; content: ReactNode }[]
}

const HISTORY_PAGE = 10

type SnapshotPage = z.infer<typeof SourceSnapshotPageSchema>

function nextPage(last: { page: number; pageCount: number }) {
  return last.page < last.pageCount ? last.page + 1 : undefined
}

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

/** The page of a provider under Providers. */
export function providerHref(id: string) {
  return `/providers/${encodeURIComponent(id)}`
}

function sourcePath(scope: SourceScope, provider: string) {
  const resource = scope.kind === 'artist' ? 'artists' : 'media'
  return `/api/v1/${resource}/${encodeURIComponent(scope.id)}/sources/${encodeURIComponent(provider)}`
}

function RetryNotice({
  message,
  onRetry,
}: {
  message: string
  onRetry: () => void
}) {
  return (
    <Notice
      tone="danger"
      action={
        <Button size="xs" onClick={onRetry}>
          Retry
        </Button>
      }
    >
      {message}
    </Notice>
  )
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
      <RetryNotice
        message="Could not load the snapshot."
        onRetry={() => snapshot.refetch()}
      />
    )
  if (!snapshot.data) return <Skeleton height={96} />
  return (
    <div className="data-stack" aria-label="Snapshot data" role="region">
      {snapshot.data.normalizedData !== null && (
        <details className="data-disclosure">
          <summary>Normalized data</summary>
          <JsonTree value={snapshot.data.normalizedData} />
        </details>
      )}
      <details className="data-disclosure" open>
        <summary>Stored response</summary>
        <JsonTree value={snapshot.data.data} />
      </details>
    </div>
  )
}

type HistoryEntry =
  | { kind: 'snapshot'; at: string; snapshot: SourceSnapshotSummary }
  | { kind: 'job'; at: string; job: Job }

/** Snapshots and jobs for one provider in one newest-first list. */
function SourceHistory({
  scope,
  row,
}: {
  scope: SourceScope
  row: ProviderSourceRow
}) {
  const { apiBaseUrl } = useConfig()
  const [selectedSnapshot, setSelectedSnapshot] = useState<string | null>(null)
  const snapshots = useInfiniteQuery({
    queryKey: ['history', scope.id, scope.kind, row.id, 'snapshot-list'],
    initialPageParam: 1,
    queryFn: ({ pageParam, signal }): Promise<SnapshotPage> =>
      fetchApiData(
        apiBaseUrl,
        `${sourcePath(scope, row.id)}/history?${new URLSearchParams({ page: String(pageParam), size: String(HISTORY_PAGE) })}`,
        SourceSnapshotPageSchema,
        { signal },
      ),
    getNextPageParam: nextPage,
  })
  const jobs = useInfiniteQuery({
    queryKey: ['jobs', 'source-history', scope.kind, scope.id, row.id],
    initialPageParam: 1,
    getNextPageParam: nextPage,
    queryFn: ({ pageParam, signal }): Promise<JobPage> =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/scrape/jobs?${new URLSearchParams({
          ...scopeParams(scope),
          provider: row.id,
          sortBy: 'createdAt',
          direction: 'desc',
          page: String(pageParam),
          size: String(HISTORY_PAGE),
        })}`,
        JobPageSchema,
        { signal },
      ),
    refetchInterval: (query) =>
      query.state.data?.pages[0]?.items.some(canCancelJob) ? 3000 : false,
  })
  const entries = mergeHistory<HistoryEntry>([
    {
      items:
        snapshots.data?.pages.flatMap((page) =>
          page.items.map(
            (snapshot): HistoryEntry => ({
              kind: 'snapshot',
              at: snapshot.createdAt,
              snapshot,
            }),
          ),
        ) ?? [],
      more: snapshots.hasNextPage,
    },
    {
      items:
        jobs.data?.pages.flatMap((page) =>
          page.items.map(
            (job): HistoryEntry => ({ kind: 'job', at: job.createdAt, job }),
          ),
        ) ?? [],
      more: jobs.hasNextPage,
    },
  ])
  const items = entries.map((entry): TimelineItem => {
    if (entry.kind === 'job') {
      const { job } = entry
      return {
        key: `job:${job.id}`,
        when: formatDateTime(job.createdAt),
        status: <Status state={jobState(job)} />,
        text:
          job.errorMessage ??
          job.items.find((item) => item.message)?.message ??
          'Refresh',
        link: (
          <DetailLink className="ds-muted" kind="job" id={job.id}>
            Job
          </DetailLink>
        ),
      }
    }
    const { snapshot } = entry
    const open = selectedSnapshot === snapshot.id
    return {
      key: `snapshot:${snapshot.id}`,
      when: formatDateTime(snapshot.createdAt),
      status: <Status state="done">Saved</Status>,
      text: `Snapshot${snapshot.source ? ` · ${snapshot.source}` : ''}`,
      link: (
        <span className="ds-actions">
          <Button
            size="xs"
            variant="link"
            aria-expanded={open}
            onClick={() => setSelectedSnapshot(open ? null : snapshot.id)}
          >
            {open ? 'Hide data' : 'Data'}
          </Button>
          {snapshot.jobId && (
            <DetailLink className="ds-muted" kind="job" id={snapshot.jobId}>
              Job
            </DetailLink>
          )}
        </span>
      ),
    }
  })
  const loading = (snapshots.isPending || jobs.isPending) && !items.length
  const failed =
    (snapshots.isError && !snapshots.data) || (jobs.isError && !jobs.data)
  const more = snapshots.hasNextPage || jobs.hasNextPage
  return (
    <div
      className="data-stack"
      aria-label={`${row.label} history`}
      role="region"
    >
      {failed && (
        <RetryNotice
          message="Could not load the history."
          onRetry={() => {
            if (snapshots.isError) void snapshots.refetch()
            if (jobs.isError) void jobs.refetch()
          }}
        />
      )}
      {loading ? (
        <Skeleton height={84} />
      ) : items.length ? (
        <Timeline items={items} />
      ) : (
        !failed && <p className="ds-muted">No history.</p>
      )}
      {more && (
        <span>
          <Button
            size="xs"
            variant="ghost"
            disabled={snapshots.isFetchingNextPage || jobs.isFetchingNextPage}
            onClick={() => {
              if (snapshots.hasNextPage) void snapshots.fetchNextPage()
              if (jobs.hasNextPage) void jobs.fetchNextPage()
            }}
          >
            Show older
          </Button>
        </span>
      )}
      {selectedSnapshot && (
        <SnapshotDetails
          scope={scope}
          provider={row.id}
          id={selectedSnapshot}
        />
      )}
    </div>
  )
}

function SourceState({
  job,
  unavailable,
}: {
  job?: Job
  unavailable?: string
}) {
  if (job) return <Status state={jobState(job)} />
  if (!unavailable) return null
  const state = unavailableState(unavailable)
  if (!state) return null
  return <Status state={state}>{unavailable}</Status>
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
  const view = useDetailView()
  const savedProvider = view.params.get('sourceProvider') ?? initialProvider
  const sourceMode = view.params.get('sourceMode')
  const opened: {
    provider: string
    type: 'history' | 'edit'
  } | null =
    savedProvider && sourceMode !== 'closed'
      ? {
          provider: savedProvider,
          type: sourceMode === 'edit' ? 'edit' : 'history',
        }
      : null
  function setOpened(next: typeof opened) {
    if (next) {
      view.params.set('sourceProvider', next.provider)
      view.params.set('sourceMode', next.type)
    } else {
      view.params.delete('sourceProvider')
      view.params.set('sourceMode', 'closed')
    }
    view.replace(view.params)
  }
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
    onSuccess: async () => {
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
    },
  })
  const activeByProvider = new Map(
    (activeJobs.data?.items ?? [])
      .filter(canCancelJob)
      .map((job) => [job.provider, job]),
  )
  const ordered = [...rows].sort((left, right) =>
    left.label.localeCompare(right.label),
  )
  const canRefresh = (row: ProviderSourceRow) =>
    activeJobs.isSuccess &&
    !refresh.isPending &&
    Boolean(row.refresh && !row.unavailable && !activeByProvider.has(row.id))
  const eligible = ordered.filter(canRefresh)
  const matches = new Map(
    ordered.map((row) => [
      row.id,
      row.match ??
        sourceMatch({
          identifier: row.identifier,
          updatedAt: row.updatedAt,
          unavailable: row.unavailable,
          refreshable: Boolean(row.refresh),
        }),
    ]),
  )
  function toggle(row: ProviderSourceRow, type: 'history' | 'edit') {
    setOpened(
      opened?.provider === row.id && opened.type === type
        ? null
        : { provider: row.id, type },
    )
  }
  return (
    <Section flush>
      {unavailable && onRetry && (
        <RetryNotice message={unavailable} onRetry={onRetry} />
      )}
      {activeJobs.isError && refreshable && (
        <RetryNotice
          message="Could not check active jobs."
          onRetry={() => activeJobs.refetch()}
        />
      )}
      {ordered.length > 0 && (
        <div className="ds-section-head">
          <span className="ds-muted" role="status">
            {sourcesSummary([...matches.values()])}
          </span>
          {refreshable && (
            <span className="ds-section-aside">
              <Button
                size="xs"
                disabled={!eligible.length}
                onClick={() => refresh.mutate(eligible)}
              >
                <RefreshCw className="ds-i" data-size="sm" aria-hidden />
                {refresh.isPending ? 'Queuing...' : 'Refresh all'}
              </Button>
            </span>
          )}
        </div>
      )}
      {scope && refresh.data?.length ? (
        <ul className="data-picker" aria-label="Refresh results">
          {refresh.data.map(({ row, job, error }) => (
            <li key={row.id} role={error ? 'alert' : 'status'}>
              {row.label} ·{' '}
              {error ??
                (job && (
                  <DetailLink kind="job" id={job.id}>
                    View refresh job
                  </DetailLink>
                ))}
            </li>
          ))}
        </ul>
      ) : null}
      {ordered.length === 0 &&
        (pending ? (
          <div className="data-stack" role="status" aria-busy="true">
            <span className="sr-only">Loading sources</span>
            <Skeleton height={48} />
            <Skeleton height={48} />
          </div>
        ) : (
          <State
            title={unavailable ?? 'No sources'}
            size="sm"
            error={Boolean(unavailable && onRetry)}
          />
        ))}
      <div role="list" aria-label="Sources">
        {ordered.map((row) => {
          const open = opened?.provider === row.id
          const editing = open && opened?.type === 'edit' && Boolean(row.editor)
          const match = matches.get(row.id)
          const job = activeByProvider.get(row.id)
          const rowCanRefresh = canRefresh(row)
          const needsId = match?.label === 'Needs ID' && row.editor
          const body: ReactNode[] = []
          if (open) {
            if (row.editor)
              body.push(
                <SourceBlock key="identifier" title="Identifier">
                  {row.editor(rowCanRefresh, () => setOpened(null))}
                </SourceBlock>,
              )
            if (!editing) {
              if (row.identifierDetails)
                body.push(
                  <SourceBlock
                    key="identifier-sources"
                    title="Identifier sources"
                  >
                    {row.identifierDetails()}
                  </SourceBlock>,
                )
              if (row.provides?.length)
                body.push(
                  <SourceBlock key="provides" title="Provides">
                    <Pills wrap label={`Supplied by ${row.label}`}>
                      {row.provides.map((field) => (
                        <Pill key={field}>{field}</Pill>
                      ))}
                    </Pills>
                  </SourceBlock>,
                )
              for (const block of row.blocks ?? [])
                body.push(
                  <SourceBlock key={`block:${block.title}`} title={block.title}>
                    {block.content}
                  </SourceBlock>,
                )
              if (row.details)
                body.push(
                  <SourceBlock key="details" title="Stored data">
                    {row.details}
                  </SourceBlock>,
                )
              if (scope)
                body.push(
                  <SourceBlock key="history" title="History">
                    <SourceHistory scope={scope} row={row} />
                  </SourceBlock>,
                )
            }
          }
          return (
            <div role="listitem" key={row.id}>
              <SourceRow
                open={open}
                onToggle={(next) => {
                  if (next && !open)
                    setOpened({ provider: row.id, type: 'history' })
                  if (!next && open) setOpened(null)
                }}
                mark={
                  <ProviderMark name={row.label}>
                    {providerMarkText(row.label)}
                  </ProviderMark>
                }
                name={
                  row.href ? (
                    <Link href={row.href} prefetch={false}>
                      {row.label}
                    </Link>
                  ) : (
                    row.label
                  )
                }
                match={
                  match && <Status state={match.state}>{match.label}</Status>
                }
                identifier={row.identifier}
                when={
                  row.updatedAt ? (
                    <time
                      dateTime={row.updatedAt}
                      title={formatDateTime(row.updatedAt)}
                    >
                      {formatAge(row.updatedAt)}
                    </time>
                  ) : (
                    'Never'
                  )
                }
                state={<SourceState job={job} unavailable={row.unavailable} />}
                actions={
                  <>
                    {needsId ? (
                      <Button
                        size="xs"
                        aria-expanded={editing}
                        onClick={() => toggle(row, 'edit')}
                      >
                        Add ID
                      </Button>
                    ) : (
                      row.editor && (
                        <Button
                          size="xs"
                          variant="ghost"
                          icon
                          title={`Edit ${row.label} identifier`}
                          aria-label={`Edit ${row.label} identifier`}
                          aria-expanded={editing}
                          onClick={() => toggle(row, 'edit')}
                        >
                          <Pencil className="ds-i" data-size="sm" aria-hidden />
                        </Button>
                      )
                    )}
                    {scope && row.refresh && (
                      <Button
                        size="xs"
                        variant="ghost"
                        icon
                        disabled={!rowCanRefresh}
                        title={row.unavailable ?? `Refresh ${row.label}`}
                        aria-label={`Refresh ${row.label}`}
                        onClick={() => refresh.mutate([row])}
                      >
                        <RefreshCw
                          className="ds-i"
                          data-size="sm"
                          aria-hidden
                        />
                      </Button>
                    )}
                    {row.links?.map((link) => (
                      <Button
                        key={link.url}
                        size="xs"
                        variant="ghost"
                        icon
                        asChild
                      >
                        <a
                          href={link.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          title={`Open on ${link.label} (new tab)`}
                          aria-label={`Open on ${link.label} (opens in a new tab)`}
                        >
                          <ExternalLink
                            className="ds-i"
                            data-size="sm"
                            aria-hidden
                          />
                        </a>
                      </Button>
                    ))}
                  </>
                }
              >
                {body.length ? body : null}
              </SourceRow>
            </div>
          )
        })}
      </div>
    </Section>
  )
}
