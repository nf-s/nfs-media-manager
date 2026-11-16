'use client'

import { JobsTable } from '../jobs-table'
import JobsHealth from '../jobs-health'

export { JobsTable } from '../jobs-table'

export default function JobsPageClient() {
  return (
    <>
      <JobsHealth />
      <JobsTable />
    </>
  )
}
