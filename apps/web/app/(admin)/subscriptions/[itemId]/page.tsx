import SubscriptionDetailPageClient from '@/components/pages/subscription-detail-page-client'

export default async function SubscriptionDetailPage({
  params,
}: {
  params: Promise<{ itemId: string }>
}) {
  const { itemId } = await params
  return <SubscriptionDetailPageClient itemId={itemId} />
}
