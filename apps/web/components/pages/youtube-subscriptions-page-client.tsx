'use client'

import YoutubeChannels from '@/components/youtube-channels'
import YoutubeSyncPanel from '@/components/youtube-sync'

export default function YoutubeSubscriptionsPageClient() {
  return (
    <section className="admin-page imports-page">
      <h1>YouTube subscriptions</h1>
      <div className="min-h-0 flex-1 overflow-auto">
        <YoutubeSyncPanel />
        <YoutubeChannels />
      </div>
    </section>
  )
}
