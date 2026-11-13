'use client'

import { ImportStatusNotice } from '@/components/imports-workspace'
import SpotifyPlaylistImport from '@/components/spotify-playlist-import'

export default function SpotifyPlaylistsPageClient() {
  return (
    <section className="admin-page imports-page">
      <h1>Spotify playlists</h1>
      <ImportStatusNotice />
      <div className="min-h-0 flex-1 overflow-auto">
        <SpotifyPlaylistImport />
      </div>
    </section>
  )
}
