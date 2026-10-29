'use client'

import Link from 'next/link'
import { useState } from 'react'
import type { MediaHistory } from '@repo/schemas/media'
import MediaHistoryJobs from './media-history-jobs'
import JsonTree from './json-tree'

function HistoryEvent({ event }: { event: MediaHistory['events'][number] }) {
  const [open, setOpen] = useState(false)
  const providerLabel =
    event.provider === 'google-custom-search'
      ? 'Google Custom Search (legacy)'
      : (event.provider ?? event.type)
  return (
    <details
      open={open}
      onToggle={(click) => setOpen(click.currentTarget.open)}
    >
      <summary>
        <strong>{providerLabel}</strong>
        <span>{event.title}</span>
        {event.jobId && (
          <Link
            href={`/jobs?jobId=${encodeURIComponent(event.jobId)}`}
            className="shrink-0 text-xs underline underline-offset-2"
            onClick={(click) => click.stopPropagation()}
          >
            View job
          </Link>
        )}
        <time dateTime={event.createdAt}>
          {new Date(event.createdAt).toLocaleString()}
        </time>
      </summary>
      {event.description && <p className="muted">{event.description}</p>}
      {open && event.type === 'snapshot' ? (
        <JsonTree value={event.data} />
      ) : (
        event.type !== 'snapshot' &&
        event.data !== null && <pre>{JSON.stringify(event.data, null, 2)}</pre>
      )}
    </details>
  )
}

function HistoryEvents({ events }: { events: MediaHistory['events'] }) {
  return (
    <div className="history-list">
      {events.map((event) => (
        <HistoryEvent key={event.id} event={event} />
      ))}
    </div>
  )
}

export default function MediaHistoryList({
  history,
}: {
  history: MediaHistory | undefined
}) {
  if (!history) return <p className="muted">History unavailable.</p>
  const snapshots = history.events.filter((event) => event.type === 'snapshot')
  const changes = history.events.filter(
    (event) => event.type !== 'snapshot' && event.type !== 'job',
  )
  return (
    <div className="space-y-6">
      <MediaHistoryJobs
        key={history.mediaItemId}
        mediaItemId={history.mediaItemId}
      />
      <section aria-label="Provider snapshots">
        <h2 className="text-sm font-semibold">
          Provider snapshots ({snapshots.length})
        </h2>
        {snapshots.length ? (
          <HistoryEvents events={snapshots} />
        ) : (
          <p className="muted">No snapshots yet.</p>
        )}
      </section>
      {changes.length > 0 && (
        <section aria-label="Changes">
          <h2 className="text-sm font-semibold">Changes ({changes.length})</h2>
          <HistoryEvents events={changes} />
        </section>
      )}
    </div>
  )
}
