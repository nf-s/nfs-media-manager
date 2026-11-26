'use client'

import { useMutation } from '@tanstack/react-query'
import { Button, mutationFeedback } from '@repo/ui/components/ui/button'
import { useConfig } from './providers'
import { errorMessage } from './lastfm-sync'
import { spotifyAuthorizationUrl } from '@/utils/spotify-authorize'

/** Reconnects Spotify with playlist change access, keeping the access already granted. */
export default function AllowPlaylistChanges({
  playlistLibrary = 'album',
}: {
  playlistLibrary?: 'album' | 'track'
}) {
  const { apiBaseUrl } = useConfig()
  const authorize = useMutation({
    mutationFn: () =>
      spotifyAuthorizationUrl(apiBaseUrl, {
        playlistChanges: true,
        playlists: true,
        playlistLibrary,
      }),
    onSuccess: (url) => window.location.assign(url),
  })
  return (
    <>
      <Button
        disabled={authorize.isPending || authorize.isSuccess}
        feedback={mutationFeedback(authorize, {
          pending: 'Opening Spotify sign-in…',
          success: 'Waiting for Spotify…',
          error: 'Could not open Spotify · retry',
        })}
        onClick={() => authorize.mutate()}
      >
        Allow playlist changes
      </Button>
      {authorize.isError && (
        <span role="alert">
          {errorMessage(authorize.error, 'Could not start the connection.')}
        </span>
      )}
    </>
  )
}
