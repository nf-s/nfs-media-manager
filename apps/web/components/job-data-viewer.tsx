'use client'

import { useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { JsonValue } from '@repo/schemas/common'
import type { Job } from '@repo/schemas/job'
import { Section } from '@repo/ui/components/ds/facts'
import { Notice } from '@repo/ui/components/ds/feedback'
import { Button } from '@repo/ui/components/ui/button'
import { formatCount, formatDateTime } from '@repo/ui/lib/format'
import { jobDataOptions } from '@/utils/job-data'
import { useConfig } from './providers'
import JsonTree from './json-tree'

type DataJob = Pick<Job, 'id' | 'status'>

/** One saved payload: collapsed until opened, with Copy beside its name. */
function SavedPayload({
  label,
  value,
}: {
  label: ReactNode
  value: JsonValue
}) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  return (
    <details
      className="ops-disclosure ops-payload"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span className="ops-payload-label">{label}</span>
        <Button
          size="xs"
          variant="ghost"
          onClick={(event) => {
            event.preventDefault()
            void navigator.clipboard
              .writeText(JSON.stringify(value, null, 2))
              .then(() => setCopied(true))
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </summary>
      {open && <JsonTree value={value} />}
    </details>
  )
}

export function StoredJobData({ job }: { job: DataJob }) {
  const { apiBaseUrl } = useConfig()
  const result = useQuery(jobDataOptions(apiBaseUrl, job))
  const data = result.data
  const empty =
    data &&
    !data.snapshots.length &&
    !data.diagnostics.length &&
    !data.itemPayloads.length

  return (
    <div className="ops-data" aria-busy={result.isFetching}>
      {result.isPending && (
        <p className="ds-help" role="status">
          Loading stored JSON...
        </p>
      )}
      {result.isError && (
        <Notice
          tone="danger"
          action={
            <Button
              size="xs"
              disabled={result.isFetching}
              onClick={() => result.refetch()}
            >
              Reload stored data
            </Button>
          }
        >
          Could not load stored JSON.
        </Notice>
      )}
      {empty && (
        <p role="status" className="ds-help">
          {job.status === 'queued' || job.status === 'running'
            ? 'No response saved yet.'
            : 'No response JSON was saved for this job. Older failed responses cannot be recovered.'}
        </p>
      )}
      {data && !empty && (
        <>
          <Section
            flush
            title={`Snapshots (${formatCount(data.snapshots.length)})`}
          >
            {data.snapshots.map((snapshot) => (
              <SavedPayload
                key={snapshot.id}
                label={`${snapshot.provider} · ${formatDateTime(snapshot.createdAt)}`}
                value={snapshot.payload}
              />
            ))}
          </Section>
          <Section
            title={`Diagnostics (${formatCount(data.diagnostics.length)})`}
          >
            {data.diagnostics.map((entry) => (
              <SavedPayload
                key={entry.id}
                label={formatDateTime(entry.createdAt)}
                value={entry.data}
              />
            ))}
          </Section>
          {data.itemPayloads.length > 0 && (
            <Section
              title={`Legacy item payloads (${formatCount(data.itemPayloads.length)})`}
              note="Legacy success payloads (no linked snapshot)."
            >
              {data.itemPayloads.map((entry) => (
                <SavedPayload
                  key={entry.id}
                  label={entry.provider}
                  value={entry.payload}
                />
              ))}
            </Section>
          )}
        </>
      )}
    </div>
  )
}
