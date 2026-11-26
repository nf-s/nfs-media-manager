'use client'

import { DetailLink } from './detail-link'
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArtistEnrichmentInputSchema,
  ArtistProfileProviderSchema,
  ArtistProviderIdSchema,
  type ArtistIdentifier,
  type ArtistProviderId,
  type ArtistProviderSnapshot,
} from '@repo/schemas/artist-profiles'
import type { EntityRelationship } from '@repo/schemas/entity-relationships'
import { JobSchema } from '@repo/schemas/job'
import type { ProviderSummary } from '@repo/schemas/provider'
import { Notice } from '@repo/ui/components/ds/feedback'
import { Pill, Pills } from '@repo/ui/components/ds/pill'
import { Button, mutationFeedback } from '@repo/ui/components/ui/button'
import { Input } from '@repo/ui/components/ui/input'
import { Label } from '@repo/ui/components/ui/label'
import { fetchApiData } from '@/utils/api'
import {
  artistProviderLabel,
  supportsArtistEnrichment,
} from '@/utils/artist-providers'
import { useDetailView } from './detail-inspector-context'
import { FindMatch } from './find-match'
import { jobButtonFeedback } from './job-button-feedback'
import { jobDetailOptions } from '@/utils/job-data'
import { canCancelJob } from '@/utils/job-selection'
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
import { ArtistIdentifierSources } from './artist-identifier-sources'
import { relationshipSourceBlocks } from './relationship-source-blocks'

function profileLinks(
  snapshots: ArtistProviderSnapshot[],
  catalog: readonly ProviderSummary[] | undefined,
) {
  return snapshots.flatMap(({ provider, profile }) =>
    profile.url
      ? [
          {
            provider,
            label: artistProviderLabel(provider, catalog),
            url: profile.url,
          },
        ]
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
  const catalog = useSourceCatalog()
  const links = profileLinks(snapshots, catalog.data)
  for (const identifier of identifiers) {
    if (
      identifier.url &&
      !links.some((link) => link.provider === identifier.provider)
    )
      links.push({
        provider: identifier.provider,
        label: artistProviderLabel(identifier.provider, catalog.data),
        url: identifier.url,
      })
  }
  return <ServiceIconLinks links={links} />
}

function queueArtistRefresh(
  apiBaseUrl: string,
  id: string,
  provider: ArtistProviderId,
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
  label,
  initial,
  canRefresh,
  onCancel,
}: {
  id: string
  provider: ArtistProviderId
  label: string
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
    onSuccess: () => {
      void Promise.all([
        client.invalidateQueries({ queryKey: ['jobs'] }),
        client.invalidateQueries({ queryKey: ['job-activity'] }),
      ])
    },
  })
  const receipt = useQuery({
    ...jobDetailOptions(apiBaseUrl, refresh.data?.id ?? ''),
    initialData: refresh.data,
    enabled: Boolean(refresh.data && canCancelJob(refresh.data)),
  })
  const job = receipt.data ?? refresh.data
  const value = identifier.trim()
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
          feedback={
            job
              ? jobButtonFeedback(job, 'Artist source updated')
              : mutationFeedback(refresh, {
                  pending: 'Requesting refresh…',
                  success: 'Refresh queued',
                  error: 'Refresh failed',
                })
          }
        >
          Save and refresh
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
      {job && (
        <span role="status" className="data-identifier-wide">
          <DetailLink kind="job" id={job.id}>
            View refresh job
          </DetailLink>
          {job.errorMessage && ` · ${job.errorMessage}`}
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
  const providers = catalog.data?.filter(supportsArtistEnrichment) ?? []
  const sourceUnavailable = useSourceAvailability(providers)
  const view = useDetailView()
  const initialProvider = ArtistProviderIdSchema.safeParse(
    view.params.get('provider'),
  )
  const ids = new Set([
    ...(catalog.data ? [] : ArtistProfileProviderSchema.options),
    ...providers.map(({ id }) => id),
    ...snapshots.map(({ provider }) => provider),
    ...identifiers.map(({ provider }) => provider),
  ])
  const rows = [...ids].map((provider): ProviderSourceRow => {
    const configured = providers.find((entry) => entry.id === provider)
    const label = artistProviderLabel(provider, catalog.data)
    const current = snapshots.find((snapshot) => snapshot.provider === provider)
    const identifier = identifiers.find((entry) => entry.provider === provider)
    const externalId = identifier
      ? (identifier.externalId ?? undefined)
      : current?.profile.externalId
    const relationships =
      current?.profile.relationships ??
      current?.profile.similarArtists?.map<EntityRelationship>(
        ({ artistId, name, externalId }) => ({
          kind: 'similar',
          targetType: 'artist',
          targetId: artistId,
          name,
          externalId,
        }),
      )
    return {
      id: provider,
      label,
      identifier:
        identifier?.status === 'conflict' ? 'Conflicting IDs' : externalId,
      identifierDetails:
        identifier && identifier.status !== 'missing'
          ? () => (
              <ArtistIdentifierSources
                id={id}
                identifier={identifier}
                catalog={catalog.data}
              />
            )
          : undefined,
      updatedAt: current?.createdAt,
      links: identifier?.url
        ? [{ provider, label, url: identifier.url }]
        : current
          ? profileLinks([current], catalog.data)
          : undefined,
      blocks: [
        ...(current?.profile.summary
          ? [
              {
                title: 'About',
                content: <p className="dtl-text">{current.profile.summary}</p>,
              },
            ]
          : []),
        ...(current?.profile.tags.length
          ? [
              {
                title: 'Tags',
                content: (
                  <Pills wrap label={`Tags supplied by ${label}`}>
                    {current.profile.tags.map((tag) => (
                      <Pill key={tag}>{tag}</Pill>
                    ))}
                  </Pills>
                ),
              },
            ]
          : []),
        ...relationshipSourceBlocks(relationships),
      ],
      unavailable: catalog.isPending
        ? undefined
        : sourceUnavailable(configured),
      refresh: configured
        ? () => queueArtistRefresh(apiBaseUrl, id, provider)
        : undefined,
      editor: configured
        ? (canRefresh: boolean, close: () => void) => (
            <ArtistIdentifierEditor
              key={provider}
              id={id}
              provider={provider}
              label={label}
              initial={externalId}
              canRefresh={canRefresh}
              onCancel={close}
            />
          )
        : undefined,
      findMatch:
        configured && ArtistProfileProviderSchema.safeParse(provider).success
          ? (context) => (
              <FindMatch
                scope={{ kind: 'artist', id }}
                provider={provider}
                label={label}
                context={context}
                chooseUnavailable={
                  context.canRefresh ? undefined : 'Cannot refresh now'
                }
                choosePending="Requesting refresh…"
                onChoose={async (candidate) => {
                  const job = await queueArtistRefresh(
                    apiBaseUrl,
                    id,
                    provider,
                    candidate.externalId,
                  )
                  void Promise.all([
                    client.invalidateQueries({ queryKey: ['jobs'] }),
                    client.invalidateQueries({ queryKey: ['job-activity'] }),
                  ])
                  return { job }
                }}
              />
            )
          : undefined,
      href: catalog.data?.some(({ id }) => id === provider)
        ? providerHref(provider)
        : undefined,
      match:
        identifier?.status === 'conflict'
          ? { state: 'attention', label: 'Conflicting IDs' }
          : undefined,
    }
  })
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
