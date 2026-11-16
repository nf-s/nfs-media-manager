'use client'

import { JobsTable } from './jobs-table'

type MediaHistoryJobsProps = (
  | { mediaItemId: string; artistId?: never }
  | { artistId: string; mediaItemId?: never }
) & { provider?: string }

export default function MediaHistoryJobs(props: MediaHistoryJobsProps) {
  return <JobsTable {...props} />
}
