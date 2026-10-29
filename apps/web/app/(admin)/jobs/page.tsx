import JobsPageClient from '@/components/pages/jobs-page-client'
import { redirect } from 'next/navigation'

export default async function JobsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams
  if (params.refresh === 'films') {
    const forwarded = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) {
      if (key === 'refresh' || value === undefined) continue
      for (const entry of Array.isArray(value) ? value : [value])
        forwarded.append(key, entry)
    }
    redirect(`/jobs/metadata${forwarded.size ? `?${forwarded}` : ''}`)
  }
  return <JobsPageClient />
}
