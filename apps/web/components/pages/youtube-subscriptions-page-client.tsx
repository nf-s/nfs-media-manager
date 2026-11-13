'use client'

import Link from 'next/link'
import YoutubeSyncPanel from '@/components/youtube-sync'

export default function YoutubeSubscriptionsPageClient() {
  return (
    <section className="admin-page imports-page">
      <h1>YouTube</h1>
      <div className="min-h-0 flex-1 overflow-auto">
        <YoutubeSyncPanel />
        <p>
          <Link href="/subscriptions/channels?type=youtube">
            Subscribed channels
          </Link>
        </p>
      </div>
    </section>
  )
}
