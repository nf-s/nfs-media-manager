'use client'

import { useSearchParams } from 'next/navigation'
import { useMutation, useQuery } from '@tanstack/react-query'
import { SpotifyAccountStatusSchema } from '@repo/schemas/spotify'
import { Button } from '@repo/ui/components/ui/button'
import { useConfig } from './providers'
import { fetchApiData } from '@/utils/api'
import { spotifyAuthorizationUrl } from '@/utils/spotify-authorize'

/** Turns in-app playback on or off by reconnecting Spotify with the matching access. */
export default function SpotifyPlaybackSetting() {
  const { apiBaseUrl } = useConfig()
  const outcome = useSearchParams().get('spotify')
  const account = useQuery({
    queryKey: ['spotify-account'],
    staleTime: 0,
    queryFn: () =>
      fetchApiData(
        apiBaseUrl,
        '/api/v1/spotify/status',
        SpotifyAccountStatusSchema,
      ),
  })
  const authorize = useMutation({
    mutationFn: (playback: boolean) =>
      spotifyAuthorizationUrl(apiBaseUrl, { playback }),
    onSuccess: (url) => window.location.assign(url),
  })
  const status = account.data
  return (
    <section className="provider-settings-group">
      <h2>Playback</h2>
      <p>Play albums and tracks in the app. Requires Spotify Premium.</p>
      {status && !status.configured && (
        <p className="muted">Save Spotify credentials first.</p>
      )}
      {status?.configured && (
        <div>
          <Button
            type="button"
            variant={status.playback ? 'outline' : 'default'}
            disabled={authorize.isPending}
            onClick={() => authorize.mutate(!status.playback)}
          >
            {status.playback ? 'Turn off playback' : 'Connect playback'}
          </Button>
        </div>
      )}
      {status?.configured && (
        <p className="muted">
          {status.playback
            ? 'Playback is on. Turning it off reconnects Spotify with library access only.'
            : 'Connecting asks Spotify to let this app control playback and play in this browser.'}
        </p>
      )}
      {account.isError && (
        <p role="alert">Spotify status could not be loaded.</p>
      )}
      {authorize.isError && <p role="alert">{authorize.error.message}</p>}
      {outcome === 'connected' && <p role="status">Spotify connected.</p>}
      {outcome === 'error' && (
        <p role="alert">Spotify did not connect. Try again.</p>
      )}
    </section>
  )
}
