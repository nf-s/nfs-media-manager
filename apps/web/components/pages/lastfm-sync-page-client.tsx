'use client'

import LastfmSync from '@/components/lastfm-sync'

export default function LastfmSyncPageClient() {
  return (
    <section className="admin-page imports-page">
      <h1>Last.fm scrobbles</h1>
      <LastfmSync />
    </section>
  )
}
