'use client'

import Link from 'next/link'
import { useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { SubscriptionSyncStatus } from '@repo/schemas/subscriptions'
import { YoutubeDisconnectResultSchema } from '@repo/schemas/youtube'
import { Button } from '@repo/ui/components/ui/button'
import { useConfig } from './providers'
import { errorMessage } from './lastfm-sync'
import SubscriptionSyncPanel, {
  subscriptionSyncQueryKey,
} from './subscription-sync'
import { fetchApiData } from '@/utils/api'
import { youtubeAuthorizationUrl } from '@/utils/youtube-authorize'

export const YOUTUBE_PROVIDER_SETTINGS_HREF =
  '/providers?provider=youtube&section=credentials&mediaType=subscription'

export function YoutubeAccount({ status }: { status: SubscriptionSyncStatus }) {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const outcome = useSearchParams().get('youtube')
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false)
  const authorize = useMutation({
    mutationFn: () => youtubeAuthorizationUrl(apiBaseUrl),
    onSuccess: (url) => window.location.assign(url),
  })
  const disconnect = useMutation({
    mutationFn: () =>
      fetchApiData(
        apiBaseUrl,
        '/api/v1/youtube/account',
        YoutubeDisconnectResultSchema,
        { method: 'DELETE' },
      ),
    onSettled: async () => {
      setConfirmingDisconnect(false)
      await client.invalidateQueries({
        queryKey: subscriptionSyncQueryKey('youtube'),
      })
    },
  })
  const { account } = status
  return (
    <section className="film-import-workflow" aria-labelledby="youtube-account">
      <h2 id="youtube-account">Account</h2>
      {!account.configured && (
        <p role="alert">
          Add the OAuth client ID, client secret and redirect URI in{' '}
          <Link href={YOUTUBE_PROVIDER_SETTINGS_HREF}>
            YouTube provider settings
          </Link>
          .
        </p>
      )}
      {account.configured && !account.connected && (
        <div className="form-actions">
          <Button
            disabled={authorize.isPending}
            onClick={() => authorize.mutate()}
          >
            {authorize.isPending ? 'Opening Google...' : 'Connect YouTube'}
          </Button>
          <span className="muted">
            Requests read-only access to your subscriptions.
          </span>
        </div>
      )}
      {account.connected && (
        <div className="form-actions">
          <span>Connected.</span>
          {!confirmingDisconnect && (
            <>
              <Button
                variant="outline"
                disabled={authorize.isPending || disconnect.isPending}
                onClick={() => authorize.mutate()}
              >
                {authorize.isPending ? 'Opening Google...' : 'Reconnect'}
              </Button>
              <Button
                variant="outline"
                disabled={authorize.isPending || disconnect.isPending}
                onClick={() => setConfirmingDisconnect(true)}
              >
                Disconnect
              </Button>
            </>
          )}
          {confirmingDisconnect && (
            <>
              <span>
                Disconnect YouTube? Stored channels and videos are kept.
              </span>
              <Button
                variant="outline"
                disabled={disconnect.isPending}
                onClick={() => disconnect.mutate()}
              >
                {disconnect.isPending
                  ? 'Disconnecting...'
                  : 'Confirm disconnect'}
              </Button>
              <Button
                variant="ghost"
                disabled={disconnect.isPending}
                onClick={() => setConfirmingDisconnect(false)}
              >
                Back
              </Button>
            </>
          )}
        </div>
      )}
      {account.configured && account.redirectUri && !account.connected && (
        <p className="muted">
          Redirect URI: <code>{account.redirectUri}</code>
        </p>
      )}
      {authorize.isError && (
        <p role="alert">
          {errorMessage(authorize.error, 'Could not start the connection.')}
        </p>
      )}
      {disconnect.isError && (
        <p role="alert">
          {errorMessage(disconnect.error, 'Could not disconnect YouTube.')}
        </p>
      )}
      {outcome === 'connected' && <p role="status">YouTube connected.</p>}
      {outcome === 'error' && (
        <p role="alert">YouTube did not connect. Try again.</p>
      )}
    </section>
  )
}

/** Account connection and sync status; refreshes the library when a run ends. */
export default function YoutubeSyncPanel() {
  return (
    <SubscriptionSyncPanel
      provider="youtube"
      account={(status) => <YoutubeAccount status={status} />}
    />
  )
}
