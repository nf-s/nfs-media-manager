'use client'

import YoutubeChannels from '@/components/youtube-channels'
import YoutubeSyncPanel from '@/components/youtube-sync'

export default function YoutubeSubscriptionsPageClient() {
  return (
    <section className="admin-page imports-page">
      <h1>YouTube subscriptions</h1>
      <div className="flex min-h-0 flex-1 flex-col overflow-auto">
        <div className="shrink-0">
          <YoutubeSyncPanel />
        </div>
        <YoutubeChannels />
      </div>
    </section>
  )
}
