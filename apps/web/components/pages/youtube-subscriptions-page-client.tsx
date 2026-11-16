'use client'

import Link from 'next/link'
import { Button } from '@repo/ui/components/ui/button'
import { PageHead } from '@repo/ui/components/ds/toolbar'
import YoutubeSyncPanel from '@/components/youtube-sync'

export default function YoutubeSubscriptionsPageClient() {
  return (
    <section className="sec-page">
      <PageHead
        title="YouTube"
        actions={
          <Button variant="link" asChild>
            <Link href="/subscriptions/channels?type=youtube">
              Subscribed channels
            </Link>
          </Button>
        }
      />
      <div className="sec-scroll">
        <YoutubeSyncPanel />
      </div>
    </section>
  )
}
