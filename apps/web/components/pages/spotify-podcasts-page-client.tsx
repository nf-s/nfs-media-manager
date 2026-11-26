'use client'

import { ReadButton } from '@/components/read-button'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { useMutation, useQuery } from '@tanstack/react-query'
import { SpotifyAccountStatusSchema } from '@repo/schemas/spotify'
import { Button, mutationFeedback } from '@repo/ui/components/ui/button'
import { KeyValues, Section } from '@repo/ui/components/ds/facts'
import { Notice, Skeleton } from '@repo/ui/components/ds/feedback'
import { Status } from '@repo/ui/components/ds/status'
import { PageHead } from '@repo/ui/components/ds/toolbar'
import { useConfig } from '@/components/providers'
import { errorMessage } from '@/components/lastfm-sync'
import SubscriptionSyncPanel from '@/components/subscription-sync'
import { fetchApiData } from '@/utils/api'
import { spotifyAuthorizationUrl } from '@/utils/spotify-authorize'

export const SPOTIFY_PODCAST_SETTINGS_HREF = '/providers/spotify?tab=settings'

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
    <Section title="Account" flush>
      {account.isPending && <Skeleton width="40%" height={16} />}
      {account.isError && (
        <Notice
          tone="danger"
          action={
            <ReadButton size="xs" read={() => account.refetch()}>
              Retry
            </ReadButton>
          }
        >
          Could not load the Spotify account.
        </Notice>
      )}
      {status && !status.configured && (
        <Notice tone="attention">
          Spotify is not configured. Add the Client ID and Redirect URI in{' '}
          <Link href={SPOTIFY_PODCAST_SETTINGS_HREF}>
            Spotify provider settings
          </Link>
          .
        </Notice>
      )}
      {status?.configured && (
        <KeyValues
          items={[
            {
              label: 'Spotify',
              value: status.connected ? (
                <Status state="done">Connected</Status>
              ) : (
                <Status state="attention">Needs sign-in</Status>
              ),
            },
          ]}
        />
      )}
      {status && (
        <span className="ds-actions">
          <Button
            size="md"
            variant={status.connected ? 'default' : 'primary'}
            disabled={!status.configured || authorize.isPending}
            feedback={
              authorize.isSuccess
                ? { phase: 'waiting', label: 'Waiting for authorization' }
                : (mutationFeedback(authorize, {
                    pending: 'Opening Spotify…',
                    success: 'Connected',
                    error: 'Could not open sign-in',
                  }) ??
                  (outcome === 'connected' && status.connected
                    ? { phase: 'done', label: 'Spotify connected' }
                    : undefined))
            }
            onClick={() => authorize.mutate()}
          >
            {status.connected ? 'Reconnect Spotify' : 'Connect Spotify'}
          </Button>
        </span>
      )}
      {authorize.isError && (
        <Notice tone="danger">
          {errorMessage(authorize.error, 'Could not start the connection.')}
        </Notice>
      )}
      {outcome === 'connected' && <Notice>Spotify connected.</Notice>}
      {outcome === 'error' && (
        <Notice tone="danger">Spotify did not connect. Try again.</Notice>
      )}
    </Section>
  )
}

export default function SpotifyPodcastsPageClient() {
  return (
    <section className="sec-page">
      <PageHead
        title="Spotify podcasts"
        actions={
          <Button variant="link" asChild>
            <Link href="/subscriptions/channels?type=spotify">
              Saved podcasts
            </Link>
          </Button>
        }
      />
      <div className="sec-scroll">
        <div className="ds-panelpad">
          <SpotifyPodcastAccount />
        </div>
        <SubscriptionSyncPanel provider="spotify" />
      </div>
    </section>
  )
}
