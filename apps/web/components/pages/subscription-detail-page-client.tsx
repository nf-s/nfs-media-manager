'use client'

import { useSearchParams } from 'next/navigation'
import type { SubscriptionLibrary } from '@repo/schemas/subscriptions'
import { SubscriptionItemDetails } from '../subscription-item-details'
import { DetailPage } from '../detail-frame'
import { detailLocation } from '@/utils/detail-inspector'
import { subscriptionLibraryPages } from '@/utils/subscriptions'

export default function SubscriptionDetailPageClient({
  itemId,
  library = 'subscriptions',
}: {
  itemId: string
  library?: SubscriptionLibrary
}) {
  const page = subscriptionLibraryPages[library]
  const params = new URLSearchParams(useSearchParams())
  params.delete('inspect')
  return (
    <DetailPage
      back={{
        href: detailLocation(page.path, params),
        label: `Back to ${page.plural}`,
      }}
    >
      <SubscriptionItemDetails id={itemId} library={library} />
    </DetailPage>
  )
}
