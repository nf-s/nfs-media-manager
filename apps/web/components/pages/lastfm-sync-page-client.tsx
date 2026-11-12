'use client'

import LastfmLinks from '@/components/lastfm-links'
import LastfmSync from '@/components/lastfm-sync'

export default function LastfmSyncPageClient() {
  return (
    <section className="admin-page imports-page">
      <h1>Last.fm scrobbles</h1>
      <div className="min-h-0 flex-1 overflow-auto">
        <LastfmSync />
        <LastfmLinks />
      </div>
    </section>
  )
}
