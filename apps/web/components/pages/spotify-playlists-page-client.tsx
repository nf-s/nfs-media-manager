'use client'

import { PageHead } from '@repo/ui/components/ds/toolbar'
import { ImportStatusNotice } from '@/components/imports-workspace'
import SpotifyPlaylistImport from '@/components/spotify-playlist-import'

export default function SpotifyPlaylistsPageClient() {
  return (
    <section className="sec-page">
      <PageHead title="Spotify playlists" />
      <div className="sec-notices">
        <ImportStatusNotice />
      </div>
      <SpotifyPlaylistImport />
    </section>
  )
}
