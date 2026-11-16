import JobDetailPageClient from '@/components/pages/job-detail-page-client'

export default async function JobDetailPage({
  params,
}: {
  params: Promise<{ jobId: string }>
}) {
  const { jobId } = await params

  return <JobDetailPageClient jobId={jobId} />
}
