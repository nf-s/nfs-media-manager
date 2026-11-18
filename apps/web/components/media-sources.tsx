'use client'

import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { JobSchema } from '@repo/schemas/job'
import { canIdentifyMedia } from '@repo/schemas/provider-identification'
import {
  MediaSourcesSchema,
  type AlbumDetail,
  type FilmDetail,
  type MediaHistory,
} from '@repo/schemas/media'
import { KeyValues } from '@repo/ui/components/ds/facts'
import { Notice, Skeleton } from '@repo/ui/components/ds/feedback'
import { Button } from '@repo/ui/components/ui/button'
import { formatDateTime } from '@repo/ui/lib/format'
import { fetchApiData } from '@/utils/api'
import { IDENTIFIER_REQUIRED } from '@/utils/source-rows'
import AlbumProviderDetails from './album-provider-details'
import { ListeningSources, useAlbumListening } from './album-listening'
import { useMediaProvenance } from './field-provenance'
import JsonTree from './json-tree'
import { useConfig } from './providers'
import {
  IdentifierRow,
  MediaFindMatch,
  mediaProviderIdentifiers,
} from './provider-identifiers'
import {
  ProviderSources,
  providerHref,
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
    <div className="data-stack">
      {changes.map((change) => (
        <details key={change.id} className="data-disclosure">
          <summary>
            <time className="ds-num" dateTime={change.createdAt}>
              {formatDateTime(change.createdAt)}
            </time>{' '}
            {change.title}
          </summary>
          {change.description && (
            <p className="ds-muted">{change.description}</p>
          )}
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
    <details
      className="data-disclosure"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>Edit history</summary>
      {open &&
        (summary.isPending ? (
          <Skeleton height={56} />
        ) : summary.isError && !summary.data ? (
          <Notice
            tone="danger"
            action={
              <Button size="xs" onClick={() => summary.refetch()}>
                Retry
              </Button>
            }
          >
            Could not load changes.
          </Notice>
        ) : changes.length ? (
          <SourceChanges changes={changes} />
        ) : (
          <p className="ds-muted">No edits.</p>
        ))}
    </details>
  )
}

function scrobbleNamesSummary(linked: number, similar: number) {
  return [
    `${linked} ${linked === 1 ? 'name' : 'names'} linked`,
    ...(similar
      ? [`${similar} similar ${similar === 1 ? 'name' : 'names'} not linked`]
      : []),
  ].join(' · ')
}

export default function MediaSources({
  item,
  onSaved,
}: {
  item: AlbumDetail | FilmDetail
  onSaved: () => Promise<void>
}) {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const summary = useMediaSourceSummary(item.id)
  const catalog = useSourceCatalog()
  const provenance = useMediaProvenance(item.id)
  const isAlbum = item.mediaType === 'album'
  const listening = useAlbumListening(item.id, '', isAlbum)
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
  const collectionSources = isAlbum ? (item.collectionSources ?? []) : []
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
    ...collectionSources.map((source) => source.provider),
    ...(nfoPath ? ['nfo'] : []),
    // Scrobble names are matched under Last.fm.
    ...(isAlbum ? ['lastfm'] : []),
  ])
  function queueRefresh(id: string) {
    return fetchApiData(
      apiBaseUrl,
      `/api/v1/media/${encodeURIComponent(item.id)}/rescrape`,
      JobSchema,
      { method: 'POST', body: JSON.stringify({ provider: id }) },
    )
  }
  const rows = [...ids].map<ProviderSourceRow>((id) => {
    const provider = supported.find((provider) => provider.id === id)
    const providerDetails = details.filter((detail) => detail.provider === id)
    const collections = collectionSources.filter(
      (source) => source.provider === id,
    )
    const label =
      provider?.displayName ??
      collections[0]?.providerLabel ??
      (id === 'google-custom-search'
        ? 'Google Custom Search (legacy)'
        : id === 'nfo'
          ? 'NFO'
          : id === 'lastfm'
            ? 'Last.fm'
            : serviceLinks.find((link) => link.provider === id)?.label || id)
    const identifiers = mediaProviderIdentifiers(item, id, provider)
    const changes =
      summary.data?.changes.filter((change) => change.provider === id) ?? []
    const links = [
      ...serviceLinks.filter((link) => link.provider === id),
      ...providerDetails.flatMap((detail) =>
        detail.url ? [{ provider: id, label, url: detail.url }] : [],
      ),
    ].filter(
      (link, index, all) =>
        all.findIndex((other) => other.url === link.url) === index,
    )
    const provides = [
      ...new Set(
        (provenance.data?.fields ?? [])
          .filter((field) =>
            field.sources.some((source) => source.provider === id),
          )
          .map((field) => field.label),
      ),
    ]
    const scrobbles =
      isAlbum && id === 'lastfm' && listening.data ? listening.data : undefined
    const blocks: NonNullable<ProviderSourceRow['blocks']> = []
    if (scrobbles)
      blocks.push({
        title: 'Scrobble names',
        content: <ListeningSources albumId={item.id} data={scrobbles} />,
      })
    if (collections.length > 0)
      blocks.push({
        title: 'Collections',
        content: (
          <ul className="data-picker">
            {collections.map(({ name, url }) => (
              <li key={JSON.stringify([name, url])}>
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`${name} (opens in a new tab)`}
                >
                  {name}
                </a>
              </li>
            ))}
          </ul>
        ),
      })
    const stored = identifiers
      .map(({ current }) => current)
      .filter(Boolean)
      .join(' · ')
    const identifier =
      stored ||
      (scrobbles
        ? scrobbleNamesSummary(
            scrobbles.sources.length,
            scrobbles.similarUnlinked.length,
          )
        : undefined)
    const refresh = provider?.supportsScrape
      ? () => queueRefresh(id)
      : undefined
    const refreshAndInvalidate = refresh
      ? async () => {
          await refresh()
          await Promise.all([
            client.invalidateQueries({ queryKey: ['jobs'] }),
            client.invalidateQueries({ queryKey: ['job-activity'] }),
          ])
        }
      : undefined
    return {
      id,
      label,
      href: provider ? providerHref(id) : undefined,
      identifier,
      match:
        scrobbles && !stored
          ? scrobbles.sources.length
            ? { state: 'done', label: 'Matched by name' }
            : { state: 'attention', label: 'No names linked' }
          : undefined,
      updatedAt: summary.data?.providers.find((row) => row.id === id)
        ?.latestSnapshot?.createdAt,
      links,
      provides,
      unavailable: provider?.supportsScrape
        ? (sourceUnavailable(provider) ??
          (canIdentifyMedia(provider, identity)
            ? undefined
            : IDENTIFIER_REQUIRED))
        : undefined,
      refresh,
      editor: identifiers.length
        ? (canRefresh, close) => (
            <div className="data-stack" aria-label={`${label} identifiers`}>
              {identifiers.map((identifier) => (
                <IdentifierRow
                  key={`${identifier.referenceType}:${identifier.current}`}
                  item={item}
                  label={label}
                  {...identifier}
                  onSaved={onSaved}
                  onRefresh={canRefresh ? refreshAndInvalidate : undefined}
                  onCancel={close}
                />
              ))}
            </div>
          )
        : undefined,
      findMatch: provider?.supportsMatchSearch
        ? (context) => (
            <MediaFindMatch
              item={item}
              provider={id}
              label={label}
              context={context}
              onSaved={onSaved}
              onRefresh={context.canRefresh ? refreshAndInvalidate : undefined}
            />
          )
        : undefined,
      blocks,
      details:
        (id === 'nfo' && nfoPath) ||
        providerDetails.length ||
        changes.length ? (
          <div className="data-stack">
            {id === 'nfo' && nfoPath && (
              <KeyValues
                items={[
                  {
                    label: 'NFO file',
                    value: <span className="ds-mono">{nfoPath}</span>,
                  },
                ]}
              />
            )}
            <AlbumProviderDetails details={providerDetails} />
            <SourceChanges changes={changes} />
          </div>
        ) : undefined,
    }
  })
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
