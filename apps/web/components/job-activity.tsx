'use client'

import Link from 'next/link'
import { useEffect, useId, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Activity, AlertCircle, ChevronDown, LoaderCircle } from 'lucide-react'
import { JobActivitySchema } from '@repo/schemas/job'
import { Button } from '@repo/ui/components/ui/button'
import type { z } from 'zod'
import { useConfig } from './providers'
import { fetchApiData } from '@/utils/api'
import { scopedHref, type MediaScope } from '@/utils/media-scope'

type ActivityCounts = z.infer<typeof JobActivitySchema>

export function MediaJobActivity({
  mediaType,
  counts,
}: {
  mediaType: MediaScope
  counts?: Pick<ActivityCounts, 'queued' | 'running' | 'failed' | 'imports'>
}) {
  const label = mediaType === 'album' ? 'Albums' : 'Films'
  const statuses = counts
    ? [
        {
          count: counts.running,
          label: 'Running',
          href: '/jobs?status=running',
        },
        { count: counts.queued, label: 'Queued', href: '/jobs?status=queued' },
        {
          count: counts.failed,
          label: 'Needs attention',
          href: '/jobs?status=attention',
        },
        { count: counts.imports, label: 'Importing', href: '/imports' },
      ].filter((item) => item.count > 0)
    : []
  return (
    <section className="job-activity-library" aria-label={`${label} activity`}>
      <h3>
        <Link
          href={scopedHref('/jobs', mediaType)}
          aria-label={`${label} jobs and history`}
        >
          {label}
          <span className="quiet">View jobs</span>
        </Link>
      </h3>
      {statuses.map((item) => (
        <Link
          key={item.href}
          href={scopedHref(item.href, mediaType)}
          className={
            item.label === 'Needs attention' ? 'job-activity-error' : undefined
          }
          aria-label={`${label}: ${item.count} ${item.label.toLowerCase()}`}
        >
          <span>{item.label}</span>
          <strong>{item.count}</strong>
        </Link>
      ))}
      {!statuses.length && (
        <p className="quiet">
          {counts ? 'No active jobs or issues.' : 'Open jobs for details.'}
        </p>
      )}
    </section>
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
    refetchInterval: 4000,
    staleTime: 0,
  })
  useEffect(() => {
    if (!activity.data) return
    void client.invalidateQueries({
      predicate: (query) =>
        [
          'jobs',
          'providers',
          'imports',
          'albums',
          'films',
          'album',
          'film',
          'history',
        ].includes(String(query.queryKey[0])),
    })
  }, [activity.data, client])
  useEffect(() => {
    if (!open) return
    panel.current?.focus({ preventScroll: true })
    function position() {
      if (!trigger.current || !panel.current) return
      const rect = trigger.current.getBoundingClientRect()
      const box = panel.current.getBoundingClientRect()
      panel.current.style.left = `${Math.max(8, Math.min(rect.right - box.width, window.innerWidth - box.width - 8))}px`
      panel.current.style.top = `${Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - box.height - 8))}px`
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
  const libraries = counts?.libraries ?? []
  const sharedImports = Math.max(
    0,
    (counts?.imports ?? 0) -
      libraries.reduce((total, library) => total + library.imports, 0),
  )
  const summary = activity.isError
    ? 'Status offline'
    : !counts
      ? 'Checking jobs'
      : [active ? `${active} active` : '', failed ? `${failed} issues` : '']
          .filter(Boolean)
          .join(', ') || 'Jobs idle'
  function close() {
    panel.current?.hidePopover()
    trigger.current?.focus()
  }

  return (
    <div className="job-activity">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        ref={trigger}
        popoverTarget={id}
        aria-label={`Job activity: ${summary}`}
        aria-expanded={open}
        aria-controls={id}
        className="job-activity-trigger"
      >
        {activity.isError || failed ? (
          <AlertCircle
            size={14}
            aria-hidden="true"
            className="job-activity-error"
          />
        ) : active ? (
          <LoaderCircle
            size={14}
            aria-hidden="true"
            className="motion-safe:animate-spin"
          />
        ) : (
          <Activity size={14} aria-hidden="true" />
        )}
        <span aria-live="polite" aria-atomic="true">
          {summary}
        </span>
        <ChevronDown size={12} aria-hidden="true" />
      </Button>
      <div
        id={id}
        ref={panel}
        popover="auto"
        role="region"
        tabIndex={-1}
        aria-labelledby={titleId}
        className="job-activity-panel"
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
        <div className="job-activity-heading">
          <h2 id={titleId}>Activity</h2>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={close}
            aria-label="Close job activity"
          >
            Close
          </Button>
        </div>
        {activity.isError && (
          <p role="alert">
            Status unavailable.{counts ? ' Showing last known counts.' : ''}{' '}
            <button
              type="button"
              className="underline"
              onClick={() => activity.refetch()}
            >
              Retry
            </button>
          </p>
        )}
        {activity.isPending && <p role="status">Loading activity...</p>}
        {counts && !libraries.length && (
          <p className="quiet">
            {active} active, {failed} needing attention across all libraries.
            Per-library counts unavailable.
          </p>
        )}
        <MediaJobActivity
          mediaType="album"
          counts={libraries.find((library) => library.mediaType === 'album')}
        />
        <MediaJobActivity
          mediaType="film"
          counts={libraries.find((library) => library.mediaType === 'film')}
        />
        {sharedImports > 0 && (
          <Link className="job-activity-shared" href="/imports">
            {libraries.length
              ? 'Shared / unclassified imports'
              : 'Imports in progress'}{' '}
            <strong>{sharedImports}</strong>
          </Link>
        )}
      </div>
    </div>
  )
}
