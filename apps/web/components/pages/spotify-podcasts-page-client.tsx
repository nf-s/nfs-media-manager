'use client'

import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { useMutation, useQuery } from '@tanstack/react-query'
import { SpotifyAccountStatusSchema } from '@repo/schemas/spotify'
import { Button } from '@repo/ui/components/ui/button'
import { useConfig } from '@/components/providers'
import { errorMessage } from '@/components/lastfm-sync'
import SubscriptionSyncPanel from '@/components/subscription-sync'
import { fetchApiData } from '@/utils/api'
import { spotifyAuthorizationUrl } from '@/utils/spotify-authorize'

export const SPOTIFY_PODCAST_SETTINGS_HREF =
  '/providers?provider=spotify&section=credentials&mediaType=subscription'

export function SpotifyPodcastAccount() {
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
  // A reconnect keeps the playback and playlist access already granted.
  const authorize = useMutation({
    mutationFn: () => spotifyAuthorizationUrl(apiBaseUrl, { podcasts: true }),
    onSuccess: (url) => window.location.assign(url),
  })
  const status = account.data
  return (
    <section
      className="film-import-workflow"
      aria-labelledby="spotify-podcast-account"
    >
      <h2 id="spotify-podcast-account">Account</h2>
      {account.isPending && (
        <p role="status" className="muted">
          Loading Spotify account...
        </p>
      )}
      {account.isError && (
        <p role="alert">
          Could not load the Spotify account.{' '}
          <button onClick={() => account.refetch()}>Retry</button>
        </p>
      )}
      {status && !status.configured && (
        <p role="alert">
          Spotify is not configured. Add the Client ID and Redirect URI in{' '}
          <Link href={SPOTIFY_PODCAST_SETTINGS_HREF}>
            Spotify provider settings
          </Link>
          .
        </p>
      )}
      {status?.configured && !status.connected && (
        <p className="muted">Spotify is not connected.</p>
      )}
      {status && (
        <div className="form-actions">
          {status.connected && <span>Connected.</span>}
          <Button
            variant={status.connected ? 'outline' : 'default'}
            disabled={!status.configured || authorize.isPending}
            onClick={() => authorize.mutate()}
          >
            {authorize.isPending
              ? 'Connecting...'
              : status.connected
                ? 'Reconnect Spotify'
                : 'Connect Spotify'}
          </Button>
        </div>
      )}
      {authorize.isError && (
        <p role="alert">
          {errorMessage(authorize.error, 'Could not start the connection.')}
        </p>
      )}
      {outcome === 'connected' && <p role="status">Spotify connected.</p>}
      {outcome === 'error' && (
        <p role="alert">Spotify did not connect. Try again.</p>
      )}
    </section>
  )
}

export default function SpotifyPodcastsPageClient() {
  return (
    <section className="admin-page imports-page">
      <h1>Spotify podcasts</h1>
      <div className="min-h-0 flex-1 overflow-auto">
        <SpotifyPodcastAccount />
        <SubscriptionSyncPanel provider="spotify" />
        <p>
          <Link href="/subscriptions/channels?type=spotify">
            Saved podcasts
          </Link>
        </p>
      </div>
    </section>
  )
}
