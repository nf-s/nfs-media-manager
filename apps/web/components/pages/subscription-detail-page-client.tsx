'use client'

import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { SubscriptionItemDetails } from '../subscription-item-details'
import { detailLocation } from '@/utils/detail-inspector'

export default function SubscriptionDetailPageClient({
  itemId,
}: {
  itemId: string
}) {
  const params = new URLSearchParams(useSearchParams())
  params.delete('inspect')
  return (
    <div className="detail-page">
      <Link href={detailLocation('/subscriptions', params)}>
        Back to subscriptions
      </Link>
      <SubscriptionItemDetails id={itemId} />
    </div>
  )
}
