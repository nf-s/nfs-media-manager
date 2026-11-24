'use client'

import Link from 'next/link'
import { useEffect, useId, useRef, useState } from 'react'
import { queryOptions, useQuery, useQueryClient } from '@tanstack/react-query'
import { Activity, ChevronDown } from 'lucide-react'
import {
  JobActivitySchema,
  JobEntryPageSchema,
  getJobActivityStage,
  type JobEntry,
} from '@repo/schemas/job'
import type { ProviderSummary } from '@repo/schemas/provider'
import { Count } from '@repo/ui/components/ds/pill'
import { Notice } from '@repo/ui/components/ds/feedback'
import { Progress } from '@repo/ui/components/ds/meter'
import { Status } from '@repo/ui/components/ds/status'
import { Button } from '@repo/ui/components/ui/button'
import { formatCount, formatUntil } from '@repo/ui/lib/format'
import { useConfig } from './providers'
import { fetchApiData } from '@/utils/api'
import { jobActivityLabel } from '@/utils/job-activity'
import {
  invalidateChangedJobActivity,
  jobActivityPollInterval,
} from '@/utils/job-cache'
import {
  batchDone,
  batchStatus,
  batchTarget,
  batchTitle,
  jobStatus,
  jobTitle,
} from '@/utils/job-entries'
import {
  providerDisplayName,
  providerListOptions,
} from '@/utils/provider-health'

const shownEntries = 4

function entryPageOptions(
  apiBaseUrl: string,
  status: 'running' | 'queued',
  enabled: boolean,
) {
  const params = new URLSearchParams({
    statuses: JSON.stringify([status]),
    sortBy: status === 'running' ? 'startedAt' : 'createdAt',
    direction: status === 'running' ? 'desc' : 'asc',
    size: String(shownEntries),
  })
  return queryOptions({
    queryKey: ['jobs', 'activity-entries', status],
    queryFn: ({ signal }) =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/scrape/jobs/entries?${params}`,
        JobEntryPageSchema,
        { signal },
      ),
    enabled,
    refetchInterval: enabled ? 4000 : false,
  })
}

/** One running or queued entry: name, provider, progress and why it waits. */
export function ActivityEntry({
  entry,
  providers,
  now = new Date(),
}: {
  entry: JobEntry
  providers: readonly ProviderSummary[] | undefined
  now?: Date
}) {
  const provider =
    entry.kind === 'batch'
      ? entry.provider
        ? providerDisplayName(providers, entry.provider)
        : `${entry.providers.length} providers`
      : providerDisplayName(providers, entry.job.provider)
  const title =
    entry.kind === 'batch'
      ? `${batchTitle(entry)} · ${batchTarget(entry)}`
      : jobTitle(entry.job)
  const activity =
    entry.kind === 'job' ? getJobActivityStage(entry.job.options) : null
  const progress =
    entry.kind === 'batch'
      ? { done: batchDone(entry), total: entry.total }
      : entry.job.progress?.total
        ? { done: entry.job.progress.done, total: entry.job.progress.total }
        : null
  const state =
    entry.kind === 'batch' ? batchStatus(entry) : jobStatus(entry.job)
  const waiting = entry.kind === 'batch' ? entry.waiting : entry.job.waiting
  const href =
    entry.kind === 'batch'
      ? `/jobs?batchId=${encodeURIComponent(entry.batchId)}`
      : `/jobs/${encodeURIComponent(entry.job.id)}`
  return (
    <li className="ops-activity-entry">
      <div className="ds-source-line">
        <Link href={href} className="ds-cell-title">
          {title}
        </Link>
        <span className="ds-muted">{provider}</span>
      </div>
      {activity ? (
        <span className="ds-muted">{jobActivityLabel(activity)}</span>
      ) : (
        progress && <Progress done={progress.done} total={progress.total} />
      )}
      {state === 'waiting' && waiting && (
        <Status state="waiting" title={waiting.detail}>
          {waiting.until
            ? `Waiting until ${formatUntil(waiting.until, now)}`
            : waiting.detail}
        </Status>
      )}
    </li>
  )
}

export default function JobActivity() {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const id = useId()
  const titleId = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const activity = useQuery({
    queryKey: ['job-activity'],
    queryFn: () =>
      fetchApiData(
        apiBaseUrl,
        '/api/v1/scrape/jobs/activity',
        JobActivitySchema,
      ),
    refetchInterval: (query) => jobActivityPollInterval(query.state.data),
    staleTime: 0,
  })
  const providers = useQuery({
    ...providerListOptions(apiBaseUrl),
    enabled: open,
  })
  const running = useQuery(entryPageOptions(apiBaseUrl, 'running', open))
  const queued = useQuery(entryPageOptions(apiBaseUrl, 'queued', open))
  const previousActivity = useRef(activity.data)
  useEffect(() => {
    if (!activity.data) return
    const previous = previousActivity.current
    previousActivity.current = activity.data
    void invalidateChangedJobActivity(client, previous, activity.data)
  }, [activity.data, client])
  useEffect(() => {
    if (!open) return
    panel.current?.focus({ preventScroll: true })
    function position() {
      if (!trigger.current || !panel.current) return
      const rect = trigger.current.getBoundingClientRect()
      const box = panel.current.getBoundingClientRect()
      // Below the trigger, or above it when there is no room, as on the
      // phone tab bar.
      const below = rect.bottom + 4
      const top =
        below + box.height + 8 <= window.innerHeight
          ? below
          : rect.top - box.height - 4
      panel.current.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - box.width - 8))}px`
      panel.current.style.top = `${Math.max(8, top)}px`
    }
    position()
    const observer = new ResizeObserver(position)
    if (panel.current) observer.observe(panel.current)
    window.addEventListener('resize', position)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', position)
    }
  }, [open])

  const counts = activity.data
  const active = counts ? counts.queued + counts.running + counts.imports : 0
  const failed = counts?.failed ?? 0
  const summary = activity.isError
    ? 'Status offline'
    : !counts
      ? 'Checking jobs'
      : [active ? `${active} active` : '', failed ? `${failed} issues` : '']
          .filter(Boolean)
          .join(', ') || 'Jobs idle'
  const entries = [
    ...(running.data?.items ?? []),
    ...(queued.data?.items ?? []),
  ]
  function close() {
    panel.current?.hidePopover()
    trigger.current?.focus()
  }

  return (
    <div
      className="shell-activity"
      data-idle={failed === 0 && active === 0 ? '' : undefined}
    >
      <button
        type="button"
        ref={trigger}
        popoverTarget={id}
        aria-label={`Job activity: ${summary}`}
        aria-expanded={open}
        aria-controls={id}
        title={summary}
        className="shell-activity-trigger"
      >
        {failed > 0 ? (
          <Count tone="danger">{formatCount(failed)}</Count>
        ) : active > 0 ? (
          <Count tone="attention">{formatCount(active)}</Count>
        ) : (
          <ChevronDown className="ds-i" data-size="sm" aria-hidden="true" />
        )}
        <span className="sr-only" aria-live="polite" aria-atomic="true">
          {summary}
        </span>
      </button>
      <div
        id={id}
        ref={panel}
        popover="auto"
        role="region"
        tabIndex={-1}
        aria-labelledby={titleId}
        className="ds-pop ops-activity"
        onToggle={(event) => setOpen(event.newState === 'open')}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            close()
          }
        }}
        onClick={(event) => {
          if (event.target instanceof Element && event.target.closest('a'))
            close()
        }}
      >
        <div className="ds-pop-head ops-activity-head">
          <h2 id={titleId}>Activity</h2>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={close}
            aria-label="Close job activity"
          >
            Close
          </Button>
        </div>
        <div className="ops-activity-body">
          {activity.isError && (
            <Notice
              tone="danger"
              action={
                <Button size="xs" onClick={() => activity.refetch()}>
                  Retry
                </Button>
              }
            >
              Status unavailable.{counts ? ' Showing last known counts.' : ''}
            </Notice>
          )}
          {entries.length > 0 && (
            <ul className="ops-activity-list" aria-label="Running and queued">
              {entries.map((entry) => (
                <ActivityEntry
                  key={
                    entry.kind === 'batch'
                      ? `batch:${entry.batchId}`
                      : entry.job.id
                  }
                  entry={entry}
                  providers={providers.data}
                />
              ))}
            </ul>
          )}
          {counts && (
            <div className="ds-source-line">
              {counts.queued > 0 && (
                <Link href="/jobs?status=queued">
                  <Status state="queued">
                    {formatCount(counts.queued)} queued
                  </Status>
                </Link>
              )}
              {failed > 0 && (
                <Link href="/jobs?status=attention">
                  <Status state="failed">
                    {formatCount(failed)}{' '}
                    {failed === 1 ? 'needs attention' : 'need attention'}
                  </Status>
                </Link>
              )}
              {counts.imports > 0 && (
                <Link href="/imports">
                  <Status state="running">
                    {formatCount(counts.imports)} importing
                  </Status>
                </Link>
              )}
              {!active && !failed && (
                <span className="ds-muted">No active jobs or issues.</span>
              )}
            </div>
          )}
        </div>
        <Link href="/jobs" className="ds-menu-item">
          <Activity className="ds-i" data-size="sm" aria-hidden="true" />
          All jobs
          {counts && counts.running > 0 && (
            <span className="ds-muted">
              {formatCount(counts.running)} running
            </span>
          )}
        </Link>
      </div>
    </div>
  )
}
