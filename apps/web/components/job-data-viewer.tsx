'use client'

import React, { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { Job } from '@repo/schemas/job'
import { Button } from '@repo/ui/components/ui/button'
import { jobDataOptions } from '@/utils/job-data'
import { useConfig } from './providers'
import JsonTree from './json-tree'

type DataJob = Pick<Job, 'id' | 'status'>

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
    <div className="min-w-0 text-xs" aria-busy={result.isFetching}>
      {result.isPending && <p role="status">Loading stored JSON...</p>}
      {result.isError && (
        <p role="alert">
          Could not load stored JSON.{' '}
          <Button
            type="button"
            variant="ghost"
            disabled={result.isFetching}
            onClick={() => result.refetch()}
          >
            Reload stored data
          </Button>
        </p>
      )}
      {empty && (
        <p role="status" className="muted">
          {job.status === 'queued' || job.status === 'running'
            ? 'No response saved yet.'
            : 'No response JSON was saved for this job. Older failed responses cannot be recovered.'}
        </p>
      )}
      {data && !empty && (
        <>
          <p className="muted">
            Snapshots ({data.snapshots.length}) · Diagnostics (
            {data.diagnostics.length}) · Legacy item payloads (
            {data.itemPayloads.length})
          </p>
          {data.itemPayloads.length > 0 && (
            <p className="muted">
              Legacy success payloads (no linked snapshot).
            </p>
          )}
          <JsonTree value={data} />
        </>
      )}
    </div>
  )
}

export default function JobDataViewer({
  job,
  visible,
}: {
  job: DataJob
  visible: boolean
}) {
  const [open, setOpen] = useState(false)
  return (
    <details
      className="min-w-0 py-1 text-xs"
      open={open}
      onToggle={(event) => {
        if (event.target === event.currentTarget)
          setOpen(event.currentTarget.open)
      }}
    >
      <summary>Stored JSON</summary>
      {visible && open && <StoredJobData job={job} />}
    </details>
  )
}
