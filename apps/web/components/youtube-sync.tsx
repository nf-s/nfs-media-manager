'use client'

import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { SubscriptionSyncStatus } from '@repo/schemas/subscriptions'
import { YoutubeDisconnectResultSchema } from '@repo/schemas/youtube'
import { Button } from '@repo/ui/components/ui/button'
import { KeyValues, Section } from '@repo/ui/components/ds/facts'
import { Notice } from '@repo/ui/components/ds/feedback'
import { Status } from '@repo/ui/components/ds/status'
import { useConfig } from './providers'
import { errorMessage } from './lastfm-sync'
import { ConfirmAction } from './confirm-action'
import SubscriptionSyncPanel, {
  subscriptionSyncQueryKey,
} from './subscription-sync'
import { fetchApiData } from '@/utils/api'
import { youtubeAuthorizationUrl } from '@/utils/youtube-authorize'

export const YOUTUBE_PROVIDER_SETTINGS_HREF =
  '/providers/youtube?tab=settings'

export function YoutubeAccount({ status }: { status: SubscriptionSyncStatus }) {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const outcome = useSearchParams().get('youtube')
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
      await client.invalidateQueries({
        queryKey: subscriptionSyncQueryKey('youtube'),
      })
    },
  })
  const { account } = status
  return (
    <Section title="Account" flush>
      {!account.configured && (
        <Notice tone="attention">
          Add the OAuth client ID, client secret and redirect URI in{' '}
          <Link href={YOUTUBE_PROVIDER_SETTINGS_HREF}>
            YouTube provider settings
          </Link>
          .
        </Notice>
      )}
      {account.configured && (
        <KeyValues
          items={[
            {
              label: 'YouTube',
              value: account.connected ? (
                <Status state="done">Connected</Status>
              ) : (
                <Status state="attention">Needs sign-in</Status>
              ),
            },
          ]}
        />
      )}
      {account.configured && !account.connected && (
        <span className="sec-line">
          <Button
            size="md"
            variant="primary"
            disabled={authorize.isPending}
            onClick={() => authorize.mutate()}
          >
            {authorize.isPending ? 'Opening Google...' : 'Connect YouTube'}
          </Button>
          <span className="ds-help">
            Requests read-only access to your subscriptions.
          </span>
        </span>
      )}
      {account.connected && (
        <span className="ds-actions">
          <Button
            size="md"
            disabled={authorize.isPending || disconnect.isPending}
            onClick={() => authorize.mutate()}
          >
            {authorize.isPending ? 'Opening Google...' : 'Reconnect'}
          </Button>
          <ConfirmAction
            size="md"
            confirmVariant="danger"
            question="Disconnect YouTube?"
            details="Stored channels and videos are kept."
            confirmLabel="Disconnect"
            disabled={authorize.isPending || disconnect.isPending}
            onConfirm={() => disconnect.mutate()}
          >
            {disconnect.isPending ? 'Disconnecting...' : 'Disconnect'}
          </ConfirmAction>
        </span>
      )}
      {account.configured && account.redirectUri && !account.connected && (
        <p className="ds-help">
          Redirect URI: <code className="ds-mono">{account.redirectUri}</code>
        </p>
      )}
      {authorize.isError && (
        <Notice tone="danger">
          {errorMessage(authorize.error, 'Could not start the connection.')}
        </Notice>
      )}
      {disconnect.isError && (
        <Notice tone="danger">
          {errorMessage(disconnect.error, 'Could not disconnect YouTube.')}
        </Notice>
      )}
      {outcome === 'connected' && <Notice>YouTube connected.</Notice>}
      {outcome === 'error' && (
        <Notice tone="danger">YouTube did not connect. Try again.</Notice>
      )}
    </Section>
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
