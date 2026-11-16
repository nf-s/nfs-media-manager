'use client'

import { DetailLink } from './detail-link'
import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  ArtistEnrichmentInputSchema,
  ArtistProfileProviderSchema,
  type ArtistIdentifier,
  type ArtistProfileProvider,
  type ArtistProviderSnapshot,
} from '@repo/schemas/artist-profiles'
import { JobSchema } from '@repo/schemas/job'
import { Notice } from '@repo/ui/components/ds/feedback'
import { Button } from '@repo/ui/components/ui/button'
import { Input } from '@repo/ui/components/ui/input'
import { Label } from '@repo/ui/components/ui/label'
import { fetchApiData } from '@/utils/api'
import { useDetailView } from './detail-inspector-context'
import { FindMatch } from './find-match'
import { errorMessage } from './lastfm-sync'
import { useConfig } from './providers'
import {
  ProviderSources,
  providerHref,
  useSourceAvailability,
  useSourceCatalog,
  type ProviderSourceRow,
} from './provider-sources'
import ServiceIconLinks from './service-icon-links'
import {
  ArtistIdentifierSources,
  artistProviderLabels as providerLabels,
} from './artist-identifier-sources'

function profileLinks(snapshots: ArtistProviderSnapshot[]) {
  return snapshots.flatMap(({ provider, profile }) =>
    profile.url
      ? [{ provider, label: providerLabels[provider], url: profile.url }]
      : [],
  )
}

export function ArtistProfileLinks({
  snapshots,
  identifiers,
}: {
  snapshots: ArtistProviderSnapshot[]
  identifiers: ArtistIdentifier[]
}) {
  const links = profileLinks(snapshots)
  for (const identifier of identifiers) {
    if (
      identifier.url &&
      !links.some((link) => link.provider === identifier.provider)
    )
      links.push({
        provider: identifier.provider,
        label: providerLabels[identifier.provider],
        url: identifier.url,
      })
  }
  return <ServiceIconLinks links={links} />
}

function queueArtistRefresh(
  apiBaseUrl: string,
  id: string,
  provider: ArtistProfileProvider,
  providerArtistId?: string,
) {
  return fetchApiData(
    apiBaseUrl,
    `/api/v1/artists/${encodeURIComponent(id)}/enrichment`,
    JobSchema,
    {
      method: 'POST',
      body: JSON.stringify(
        ArtistEnrichmentInputSchema.parse({ provider, providerArtistId }),
      ),
    },
  )
}

function ArtistIdentifierEditor({
  id,
  provider,
  initial,
  canRefresh,
  onCancel,
}: {
  id: string
  provider: ArtistProfileProvider
  initial?: string
  canRefresh: boolean
  onCancel?: () => void
}) {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const [identifier, setIdentifier] = useState(initial ?? '')
  const refresh = useMutation({
    mutationFn: (value: string) =>
      queueArtistRefresh(apiBaseUrl, id, provider, value),
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: ['jobs'] }),
        client.invalidateQueries({ queryKey: ['job-activity'] }),
      ])
    },
  })
  const value = identifier.trim()
  const label = providerLabels[provider]
  const inputId = `artist-identifier-${provider}`
  return (
    <form
      className="data-identifier"
      onSubmit={(event) => {
        event.preventDefault()
        if (value && canRefresh && !refresh.isPending) refresh.mutate(value)
      }}
    >
      <Label htmlFor={inputId}>{label} artist ID</Label>
      <Input
        id={inputId}
        value={identifier}
        maxLength={1000}
        onChange={(event) => setIdentifier(event.target.value)}
      />
      <span className="ds-actions">
        <Button
          variant="primary"
          type="submit"
          disabled={!value || !canRefresh || refresh.isPending}
        >
          {refresh.isPending ? 'Queuing...' : 'Save and refresh'}
        </Button>
        {onCancel && (
          <Button type="button" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </span>
      {refresh.isError && (
        <Notice tone="danger" className="data-identifier-wide">
          {errorMessage(refresh.error, 'Could not queue the refresh.')}
        </Notice>
      )}
      {refresh.data && (
        <span role="status" className="data-identifier-wide">
          <DetailLink kind="job" id={refresh.data.id}>
            View refresh job
          </DetailLink>
        </span>
      )}
    </form>
  )
}

export function ArtistProfileSources({
  id,
  snapshots,
  identifiers,
}: {
  id: string
  snapshots: ArtistProviderSnapshot[]
  identifiers: ArtistIdentifier[]
}) {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const catalog = useSourceCatalog()
  const sourceUnavailable = useSourceAvailability(
    (catalog.data ?? []).filter(
      (provider) => ArtistProfileProviderSchema.safeParse(provider.id).success,
    ),
  )
  const view = useDetailView()
  const initialProvider = ArtistProfileProviderSchema.safeParse(
    view.params.get('provider'),
  )
  const rows = ArtistProfileProviderSchema.options.map(
    (provider): ProviderSourceRow => {
      const configured = catalog.data?.find((entry) => entry.id === provider)
      const current = snapshots.find(
        (snapshot) => snapshot.provider === provider,
      )
      const identifier = identifiers.find(
        (entry) => entry.provider === provider,
      )
      const externalId = identifier
        ? (identifier.externalId ?? undefined)
        : current?.profile.externalId
      return {
        id: provider,
        label: providerLabels[provider],
        identifier:
          identifier?.status === 'conflict' ? 'Conflicting IDs' : externalId,
        identifierDetails:
          identifier && identifier.status !== 'missing'
            ? () => <ArtistIdentifierSources id={id} identifier={identifier} />
            : undefined,
        updatedAt: current?.createdAt,
        links: identifier?.url
          ? [{ provider, label: providerLabels[provider], url: identifier.url }]
          : current
            ? profileLinks([current])
            : undefined,
        unavailable: catalog.isPending
          ? undefined
          : sourceUnavailable(configured),
        refresh: configured
          ? () => queueArtistRefresh(apiBaseUrl, id, provider)
          : undefined,
        editor: configured
          ? (canRefresh: boolean, close: () => void) => (
              <ArtistIdentifierEditor
                key={`${provider}:${externalId}`}
                id={id}
                provider={provider}
                initial={externalId}
                canRefresh={canRefresh}
                onCancel={close}
              />
            )
          : undefined,
        findMatch: configured
          ? (context) => (
              <FindMatch
                scope={{ kind: 'artist', id }}
                provider={provider}
                label={providerLabels[provider]}
                context={context}
                chooseUnavailable={
                  context.canRefresh ? undefined : 'Cannot refresh now'
                }
                onChoose={async (candidate) => {
                  await queueArtistRefresh(
                    apiBaseUrl,
                    id,
                    provider,
                    candidate.externalId,
                  )
                  await Promise.all([
                    client.invalidateQueries({ queryKey: ['jobs'] }),
                    client.invalidateQueries({ queryKey: ['job-activity'] }),
                  ])
                }}
              />
            )
          : undefined,
        href: configured ? providerHref(provider) : undefined,
        match:
          identifier?.status === 'conflict'
            ? { state: 'attention', label: 'Conflicting IDs' }
            : undefined,
      }
    },
  )
  return (
    <ProviderSources
      rows={rows}
      scope={{ kind: 'artist', id }}
      initialProvider={
        initialProvider.success ? initialProvider.data : undefined
      }
      pending={catalog.isPending}
      unavailable={
        catalog.isError && !catalog.data
          ? 'Could not load providers.'
          : undefined
      }
      onRetry={() => catalog.refetch()}
    />
  )
}
