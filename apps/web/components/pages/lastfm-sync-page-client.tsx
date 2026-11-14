'use client'

import LastfmLinks from '@/components/lastfm-links'
import LastfmSync from '@/components/lastfm-sync'
import LastfmTrackMatches from '@/components/lastfm-track-matches'
import { useLibraryView } from '@/components/media-scope'

export default function LastfmSyncPageClient() {
  const tracks = useLibraryView() === 'track'
  return (
    <section className="admin-page imports-page">
      <h1>Last.fm scrobbles</h1>
      <div className="min-h-0 flex-1 overflow-auto">
        {tracks && (
          <p className="muted">
            Syncing the configured Last.fm account adds or updates tracks from
            its listening history. Albums and Tracks use the same stored
            history; no separate track import is needed after a sync.
          </p>
        )}
        <LastfmSync trackLibrary={tracks} />
        {tracks ? <LastfmTrackMatches /> : <LastfmLinks />}
      </div>
    </section>
  )
}
