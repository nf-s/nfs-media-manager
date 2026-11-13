import TrackDetailPageClient from '@/components/pages/track-detail-page-client'

export default async function TrackDetailPage({
  params,
}: {
  params: Promise<{ trackId: string }>
}) {
  const { trackId } = await params

  return <TrackDetailPageClient trackId={trackId} />
}
