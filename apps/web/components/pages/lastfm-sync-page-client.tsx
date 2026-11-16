'use client'

import { PageHead } from '@repo/ui/components/ds/toolbar'
import LastfmLinks from '@/components/lastfm-links'
import LastfmSync from '@/components/lastfm-sync'
import LastfmTrackMatches from '@/components/lastfm-track-matches'
import { useLibraryView } from '@/components/media-scope'

export default function LastfmSyncPageClient() {
  const tracks = useLibraryView() === 'track'
  return (
    <section className="sec-page">
      <PageHead title="Last.fm scrobbles" />
      <div className="sec-scroll">
        {tracks && (
          <p className="ds-help ds-panelpad">
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
