'use client'

import { useMutation } from '@tanstack/react-query'
import { Button } from '@repo/ui/components/ui/button'
import { useConfig } from './providers'
import { errorMessage } from './lastfm-sync'
import { spotifyAuthorizationUrl } from '@/utils/spotify-authorize'

/** Reconnects Spotify with playlist change access, keeping the access already granted. */
export default function AllowPlaylistChanges() {
  const { apiBaseUrl } = useConfig()
  const authorize = useMutation({
    mutationFn: () =>
      spotifyAuthorizationUrl(apiBaseUrl, {
        playlistChanges: true,
        playlists: true,
      }),
    onSuccess: (url) => window.location.assign(url),
  })
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        disabled={authorize.isPending}
        onClick={() => authorize.mutate()}
      >
        {authorize.isPending ? 'Connecting...' : 'Allow playlist changes'}
      </Button>
      {authorize.isError && (
        <span role="alert">
          {errorMessage(authorize.error, 'Could not start the connection.')}
        </span>
      )}
    </>
  )
}
