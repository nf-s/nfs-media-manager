import SubscriptionDetailPageClient from '@/components/pages/subscription-detail-page-client'

export default async function MixDetailPage({
  params,
}: {
  params: Promise<{ itemId: string }>
}) {
  const { itemId } = await params
  return <SubscriptionDetailPageClient itemId={itemId} library="mixes" />
}
