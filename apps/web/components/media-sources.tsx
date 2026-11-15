'use client'

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { JobSchema } from '@repo/schemas/job'
import { canIdentifyMedia } from '@repo/schemas/provider-identification'
import {
  MediaSourcesSchema,
  type AlbumDetail,
  type FilmDetail,
  type MediaHistory,
} from '@repo/schemas/media'
import { fetchApiData } from '@/utils/api'
import AlbumProviderDetails from './album-provider-details'
import JsonTree from './json-tree'
import { useConfig } from './providers'
import { IdentifierRow, mediaProviderIdentifiers } from './provider-identifiers'
import {
  ProviderSources,
  useSourceAvailability,
  useSourceCatalog,
  type ProviderSourceRow,
} from './provider-sources'

function useMediaSourceSummary(id: string, enabled = true) {
  const { apiBaseUrl } = useConfig()
  return useQuery({
    queryKey: ['history', id, 'sources'],
    enabled,
    queryFn: ({ signal }) =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/media/${encodeURIComponent(id)}/sources`,
        MediaSourcesSchema,
        { signal },
      ),
  })
}

function SourceChanges({ changes }: { changes: MediaHistory['events'] }) {
  if (!changes.length) return null
  return (
    <div className="history-list">
      {changes.map((change) => (
        <details key={change.id}>
          <summary>
            <span>{change.title}</span>
            <time dateTime={change.createdAt}>
              {new Date(change.createdAt).toLocaleString()}
            </time>
          </summary>
          {change.description && <p className="quiet">{change.description}</p>}
          <JsonTree value={change.data} />
        </details>
      ))}
    </div>
  )
}

export function MediaEditHistory({ id }: { id: string }) {
  const [open, setOpen] = useState(false)
  const summary = useMediaSourceSummary(id, open)
  const changes =
    summary.data?.changes.filter((change) => !change.provider) ?? []
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer text-sm">Edit history</summary>
      {open &&
        (summary.isPending ? (
          <p role="status" className="quiet">
            Loading changes...
          </p>
        ) : summary.isError && !summary.data ? (
          <p role="alert">
            Could not load changes.{' '}
            <button
              type="button"
              className="underline"
              onClick={() => summary.refetch()}
            >
              Retry
            </button>
          </p>
        ) : changes.length ? (
          <SourceChanges changes={changes} />
        ) : (
          <p className="quiet">No edits.</p>
        ))}
    </details>
  )
}

export default function MediaSources({
  item,
  onSaved,
}: {
  item: AlbumDetail | FilmDetail
  onSaved: () => Promise<void>
}) {
  const { apiBaseUrl } = useConfig()
  const summary = useMediaSourceSummary(item.id)
  const catalog = useSourceCatalog()
  const supported = (catalog.data ?? []).filter(
    (provider) =>
      provider.surface === 'provider' &&
      provider.mediaTypes.includes(item.mediaType),
  )
  const sourceUnavailable = useSourceAvailability(
    supported.filter((provider) => provider.supportsScrape),
  )
  const identity = {
    mediaType: item.mediaType,
    title: item.title,
    artists: item.credits
      .filter((credit) => credit.role === 'artist')
      .map((credit) => credit.name),
    providerReferences: item.providerReferences,
  }
  const details = item.mediaType === 'album' ? (item.providerDetails ?? []) : []
  const serviceLinks = item.links.filter(
    (link) => link.provider !== 'youtube-trailer',
  )
  const nfo = item.mediaType === 'film' ? item.metadata?.nfo : undefined
  const nfoPath =
    nfo &&
    typeof nfo === 'object' &&
    !Array.isArray(nfo) &&
    typeof nfo.path === 'string'
      ? nfo.path
      : undefined
  const ids = new Set([
    ...supported.map((provider) => provider.id),
    ...item.providerReferences.map((reference) => reference.provider),
    ...serviceLinks.map((link) => link.provider),
    ...(summary.data?.providers.map((provider) => provider.id) ?? []),
    ...details.map((detail) => detail.provider),
    ...(nfoPath ? ['nfo'] : []),
  ])
  const rows = [...ids]
    .map<ProviderSourceRow>((id) => {
      const provider = supported.find((provider) => provider.id === id)
      const providerDetails = details.filter((detail) => detail.provider === id)
      const label =
        provider?.displayName ??
        (id === 'google-custom-search'
          ? 'Google Custom Search (legacy)'
          : id === 'nfo'
            ? 'NFO'
            : serviceLinks.find((link) => link.provider === id)?.label || id)
      const identifiers = mediaProviderIdentifiers(item, id, provider)
      const changes =
        summary.data?.changes.filter((change) => change.provider === id) ?? []
      const links = [
        ...serviceLinks.filter((link) => link.provider === id),
        ...providerDetails.flatMap((detail) =>
          detail.url ? [{ provider: id, label, url: detail.url }] : [],
        ),
      ]
      return {
        id,
        label,
        identifier:
          identifiers
            .map(({ current }) => current)
            .filter(Boolean)
            .join(' · ') || undefined,
        updatedAt: summary.data?.providers.find((row) => row.id === id)
          ?.latestSnapshot?.createdAt,
        links,
        unavailable: provider?.supportsScrape
          ? (sourceUnavailable(provider) ??
            (canIdentifyMedia(provider, identity)
              ? undefined
              : 'Identifier required'))
          : undefined,
        refresh: provider?.supportsScrape
          ? () =>
              fetchApiData(
                apiBaseUrl,
                `/api/v1/media/${encodeURIComponent(item.id)}/rescrape`,
                JobSchema,
                { method: 'POST', body: JSON.stringify({ provider: id }) },
              )
          : undefined,
        editor: identifiers.length
          ? () => (
              <section
                className="provider-identifiers"
                aria-label={`${label} identifiers`}
              >
                {identifiers.map((identifier) => (
                  <IdentifierRow
                    key={`${identifier.referenceType}:${identifier.current}`}
                    item={item}
                    label={label}
                    {...identifier}
                    onSaved={onSaved}
                  />
                ))}
              </section>
            )
          : undefined,
        details: (
          <>
            {id === 'nfo' && nfoPath && (
              <dl className="my-3 text-sm">
                <dt className="quiet">NFO file</dt>
                <dd className="break-all select-text font-mono text-xs">
                  {nfoPath}
                </dd>
              </dl>
            )}
            <AlbumProviderDetails details={providerDetails} />
            <SourceChanges changes={changes} />
          </>
        ),
      }
    })
    .sort((left, right) => left.label.localeCompare(right.label))
  const unavailable =
    summary.isError && !summary.data
      ? 'Could not load source history.'
      : catalog.isError && !catalog.data
        ? 'Could not load providers.'
        : undefined
  return (
    <ProviderSources
      rows={rows}
      scope={{ kind: item.mediaType, id: item.id }}
      pending={summary.isPending || catalog.isPending}
      unavailable={unavailable}
      onRetry={() => {
        if (summary.isError) void summary.refetch()
        if (catalog.isError) void catalog.refetch()
      }}
    />
  )
}
