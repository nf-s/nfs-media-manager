'use client'

import Link from 'next/link'
import {
  subscriptionTypeLabels,
  type MixStation,
} from '@repo/schemas/subscriptions'
import { Button } from '@repo/ui/components/ui/button'
import { PageHead } from '@repo/ui/components/ds/toolbar'
import SubscriptionSyncPanel from '@/components/subscription-sync'
import { subscriptionSourcesHref } from '@/utils/subscriptions'

/** A station needs no account: the page is its sync and schedule. */
export default function MixStationImportPageClient({
  station,
}: {
  station: MixStation
}) {
  return (
    <section className="sec-page">
      <PageHead
        title={subscriptionTypeLabels[station]}
        actions={
          <Button variant="link" asChild>
            <Link href={subscriptionSourcesHref('mixes', station)}>Shows</Link>
          </Button>
        }
      />
      <div className="sec-scroll">
        <SubscriptionSyncPanel provider={station} />
      </div>
    </section>
  )
}
