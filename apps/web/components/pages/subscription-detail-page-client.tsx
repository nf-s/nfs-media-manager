'use client'

import { useSearchParams } from 'next/navigation'
import { SubscriptionItemDetails } from '../subscription-item-details'
import { DetailPage } from '../detail-frame'
import { detailLocation } from '@/utils/detail-inspector'

export default function SubscriptionDetailPageClient({
  itemId,
}: {
  itemId: string
}) {
  const params = new URLSearchParams(useSearchParams())
  params.delete('inspect')
  return (
    <DetailPage
      back={{
        href: detailLocation('/subscriptions', params),
        label: 'Back to subscriptions',
      }}
    >
      <SubscriptionItemDetails id={itemId} />
    </DetailPage>
  )
}
