'use client'

import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { JobDetail } from '../job-detail'
import { useWorkspaceScope } from '../media-scope'
import { jobMediaScope } from '@/utils/job-media-scope'
import { scopedHref } from '@/utils/media-scope'
import { jobDetailOptions } from '@/utils/job-data'
import { useConfig } from '../providers'

export default function JobDetailPageClient({ jobId }: { jobId: string }) {
  const { apiBaseUrl } = useConfig()
  const scope = useWorkspaceScope()
  const job = useQuery(jobDetailOptions(apiBaseUrl, jobId))
  return (
    <div className="detail-page">
      <Link
        href={scopedHref(
          '/jobs',
          job.data ? (jobMediaScope(job.data) ?? scope) : scope,
        )}
      >
        Back to jobs
      </Link>
      <JobDetail id={jobId} />
    </div>
  )
}
