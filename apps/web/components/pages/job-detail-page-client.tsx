'use client'

import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { ChevronRight } from 'lucide-react'
import { JobDetail } from '../job-detail'
import { jobMediaScope } from '@/utils/job-media-scope'
import { scopedHref } from '@/utils/media-scope'
import { jobDetailOptions } from '@/utils/job-data'
import { jobBatchHref, jobTitle } from '@/utils/job-entries'
import { useConfig } from '../providers'

export default function JobDetailPageClient({ jobId }: { jobId: string }) {
  const { apiBaseUrl } = useConfig()
  const job = useQuery(jobDetailOptions(apiBaseUrl, jobId))
  const library = job.data ? jobMediaScope(job.data) : null
  const batchHref = job.data ? jobBatchHref(job.data) : null
  return (
    <div className="ds-page">
      <nav className="ds-crumbs ops-crumbs" aria-label="Breadcrumb">
        <Link href={library ? scopedHref('/jobs', library) : '/jobs'}>
          Jobs
        </Link>
        <ChevronRight className="ds-i" data-size="sm" aria-hidden="true" />
        {batchHref && (
          <>
            <Link href={batchHref}>Batch</Link>
            <ChevronRight className="ds-i" data-size="sm" aria-hidden="true" />
          </>
        )}
        <b>{job.data ? jobTitle(job.data) : 'Job'}</b>
      </nav>
      <JobDetail id={jobId} headingLevel={1} />
    </div>
  )
}
