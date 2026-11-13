'use client'

import { ImportStatusNotice } from '@/components/imports-workspace'
import SpotifyPlaylistImport from '@/components/spotify-playlist-import'

export default function SpotifyPlaylistsPageClient() {
  return (
    <section className="admin-page imports-page">
      <h1>Spotify playlists</h1>
      <ImportStatusNotice />
      <SpotifyPlaylistImport />
    </section>
  )
}
