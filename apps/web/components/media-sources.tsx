'use client'

import { ReadButton } from '@/components/read-button'
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { JobSchema } from '@repo/schemas/job'
import {
  canIdentifyMedia,
  hasProviderIdentifier,
} from '@repo/schemas/provider-identification'
import {
  MediaSourcesSchema,
  type AlbumDetail,
  type FilmDetail,
  type MediaHistory,
  type MediaSources as MediaSourceSummary,
} from '@repo/schemas/media'
import { KeyValues } from '@repo/ui/components/ds/facts'
import { Notice, Skeleton } from '@repo/ui/components/ds/feedback'
import { Pill, Pills } from '@repo/ui/components/ds/pill'
import { Button } from '@repo/ui/components/ui/button'
import { formatDateTime } from '@repo/ui/lib/format'
import { fetchApiData } from '@/utils/api'
import { IDENTIFIER_REQUIRED } from '@/utils/source-rows'
import AlbumProviderDetails from './album-provider-details'
import { useDetailView } from './detail-inspector-context'
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
import { relationshipSourceBlocks } from './relationship-source-blocks'

export const albumTagsSourceField = 'albumTag'
const albumTags = 'Album tags'
const sourceCapabilities: Record<'album' | 'film', Record<string, string[]>> = {
  album: {
    discogs: [
      albumTags,
      'Artwork',
      'Label and catalogue number',
      'Formats',
      'Release ratings',
    ],
    lastfm: [albumTags, 'Description', 'Listeners', 'Track list'],
    musicbrainz: [
      albumTags,
      'Release group type',
      'Release date',
      'Relationships',
    ],
    serply: [albumTags, 'RYM rating'],
    spotify: ['Artists', 'Release date', 'Artwork', 'Track list', 'Barcode'],
    tidal: ['Artists', 'Release date', 'Artwork', 'Track list', 'Barcode'],
    metacritic: ['Metacritic ratings'],
  },
  film: {
    tmdb: [
      'Description',
      'Artwork',
      'Release date',
      'Credits',
      'Genres',
      'Collections',
      'TMDb rating',
    ],
    omdb: [
      'Description',
      'Artwork',
      'Release date',
      'Credits',
      'Genres',
      'Ratings',
    ],
  },
}

function useMediaSourceSummary(id: string, enabled = true) {
  const { apiBaseUrl } = useConfig()
  return useQuery<MediaSourceSummary>({
    queryKey: ['history', id, 'sources'],
    enabled,
    refetchInterval: ({ state }) =>
      state.data?.providers.some(
        ({ latestAttempt }) =>
          latestAttempt?.status === 'queued' ||
          latestAttempt?.status === 'running',
      )
        ? 3000
        : false,
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
              <ReadButton size="xs" read={() => summary.refetch()}>
                Retry
              </ReadButton>
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
  const view = useDetailView()
  const isAlbum = item.mediaType === 'album'
  const focused =
    isAlbum && view.params.get('sourceField') === albumTagsSourceField
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
  const relationshipSources = isAlbum ? (item.relationshipSources ?? []) : []
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
    ...relationshipSources.map((source) => source.provider),
    ...(nfoPath ? ['nfo'] : []),
    // Scrobble names are matched under Last.fm.
    ...(isAlbum ? ['lastfm'] : []),
  ])
  // Sonovault has its own row, with its release lookup and match review.
  ids.delete('sonovault')
  async function queueRefresh(id: string) {
    const job = await fetchApiData(
      apiBaseUrl,
      `/api/v1/media/${encodeURIComponent(item.id)}/rescrape`,
      JobSchema,
      { method: 'POST', body: JSON.stringify({ provider: id }) },
    )
    // A provider that runs its jobs in the request returns the job finished.
    if (job.status !== 'queued' && job.status !== 'running')
      await client.invalidateQueries({ queryKey: [item.mediaType, item.id] })
    await client.invalidateQueries({ queryKey: ['history', item.id] })
    return job
  }
  const rows = [...ids].map<ProviderSourceRow>((id) => {
    const provider = supported.find((provider) => provider.id === id)
    const source = summary.data?.providers.find((row) => row.id === id)
    const capabilities = sourceCapabilities[item.mediaType][id]
    const providerDetails = details.filter((detail) => detail.provider === id)
    const collections = collectionSources.filter(
      (source) => source.provider === id,
    )
    const relationshipSource = relationshipSources.find(
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
      ...((source?.returnedTags?.length ?? 0) > 0
        ? [isAlbum ? albumTags : 'Tags']
        : []),
      ...(source?.returnedTrackList ? ['Track list'] : []),
    ]
    const scrobbles =
      isAlbum && id === 'lastfm' && listening.data ? listening.data : undefined
    const blocks = relationshipSourceBlocks(relationshipSource?.relationships)
    if (isAlbum && source?.returnedTags?.length)
      blocks.push({
        title: albumTags,
        content: (
          <Pills wrap label={`Tags returned by ${label}`}>
            {source.returnedTags.map((tag) => (
              <Pill key={tag}>{tag}</Pill>
            ))}
          </Pills>
        ),
      })
    else if (focused && source?.latestSnapshot)
      blocks.push({
        title: albumTags,
        content: (
          <p className="ds-muted">The saved response returned no album tags.</p>
        ),
      })
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
          const job = await refresh()
          void Promise.all([
            client.invalidateQueries({ queryKey: ['jobs'] }),
            client.invalidateQueries({ queryKey: ['job-activity'] }),
          ])
          return job
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
      updatedAt:
        source?.latestSnapshot?.createdAt ?? relationshipSource?.createdAt,
      latestAttempt: source?.latestAttempt,
      links,
      provides,
      capabilities,
      unavailable: provider?.supportsScrape
        ? (sourceUnavailable(provider) ??
          ((
            focused && provider.supportsMatchSearch
              ? hasProviderIdentifier(
                  provider,
                  identity.mediaType,
                  identity.providerReferences,
                )
              : canIdentifyMedia(provider, identity)
          )
            ? undefined
            : IDENTIFIER_REQUIRED))
        : undefined,
      refresh,
      editor: identifiers.length
        ? (canRefresh, close) => (
            <div className="data-stack" aria-label={`${label} identifiers`}>
              {identifiers.map((identifier) => (
                <IdentifierRow
                  key={identifier.referenceType}
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
    <>
      {focused && (
        <Notice
          action={
            <Button
              type="button"
              size="xs"
              variant="link"
              onClick={() => {
                view.params.delete('sourceField')
                view.replace(view.params)
              }}
            >
              Show all sources
            </Button>
          }
        >
          Sources that can supply album tags
        </Notice>
      )}
      <ProviderSources
        rows={
          focused
            ? rows.filter((row) => row.capabilities?.includes(albumTags))
            : rows
        }
        scope={{ kind: item.mediaType, id: item.id }}
        pending={summary.isPending || catalog.isPending}
        unavailable={unavailable}
        allowRefreshAll={!focused}
        onRetry={() =>
          Promise.all([
            summary.isError && summary.refetch(),
            catalog.isError && catalog.refetch(),
          ])
        }
      />
    </>
  )
}
