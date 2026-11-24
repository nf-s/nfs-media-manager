'use client'

import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { LibraryAction } from '@repo/ui/components/ds/library-action'
import type { CatalogNativeKind } from '@repo/schemas/catalog'
import { Section, KeyValues } from '@repo/ui/components/ds/facts'
import { Notice } from '@repo/ui/components/ds/feedback'
import { ProviderMark } from '@repo/ui/components/ds/pill'
import { SourceRow } from '@repo/ui/components/ds/source'
import { Button } from '@repo/ui/components/ui/button'
import { formatDateTime } from '@repo/ui/lib/format'
import { addCatalogMedia, catalogDiscoveries } from '@/utils/catalog-api'
import { invalidateManualMediaAddition } from '@/utils/manual-media-add'
import { providerLogoUrl } from '@/utils/provider-logos'
import { useConfig } from './providers'
import { DetailLink } from './detail-link'

const discoveryLabels: Record<string, string> = {
  'artist-albums': 'Artist catalogue',
  'spotify-match': 'Match search',
  similar: 'Similar items',
  'catalog-search': 'Catalogue search',
  'spotify-code-search': 'Spotify code search',
  'tidal-track-match': 'TIDAL match search',
  playlist: 'Playlist contents',
  playback: 'Playback',
  'album-tracks': 'Album tracks',
  'provider-result': 'Provider result',
  import: 'Import',
  'parent-reference': 'Parent link',
}

export function CatalogLibraryAction({ id, kind, title, inLibrary }: {
  id: string
  kind: 'album' | 'track' | 'film' | CatalogNativeKind
  title: string
  inLibrary: boolean
}) {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const action = useMutation({
    mutationFn: () => addCatalogMedia(apiBaseUrl, id, kind === 'album' || kind === 'film' || kind === 'track' ? 'media' : kind),
    onSuccess: async () => {
      await Promise.all([
        kind === 'album' || kind === 'film' || kind === 'track' ? invalidateManualMediaAddition(client, kind) : client.invalidateQueries(),
        client.invalidateQueries({ queryKey: [kind, id] }),
        client.invalidateQueries({ queryKey: ['artists'] }),
        client.invalidateQueries({ queryKey: ['artist'] }),
      ])
    },
  })
  return <>
    <LibraryAction kind={kind === 'subscription-source' ? 'show' : kind === 'subscription-item' ? 'item' : kind} name={title} saved={inLibrary || action.isSuccess} pending={action.isPending} onAdd={() => action.mutate()} />
    {action.isError && <Notice tone="danger">Could not add to library.</Notice>}
  </>
}

function discoverySubject(kind: string | null, id: string | null) {
  if (!id || (kind !== 'artist' && kind !== 'person' && kind !== 'track' && kind !== 'album' && kind !== 'film' && kind !== 'playlist')) return undefined
  const label = kind === 'artist' ? 'Open artist' : `Open ${kind}`
  return <DetailLink kind={kind} id={id}>{label}</DetailLink>
}

export function CatalogDiscoveries({ id,kind = 'media' }: { id: string; kind?: CatalogNativeKind | 'media' }) {
  const { apiBaseUrl } = useConfig()
  const discoveries = useInfiniteQuery({
    queryKey: ['catalog-discoveries', kind,id],
    initialPageParam: 1,
    queryFn: ({ pageParam, signal }) => catalogDiscoveries(apiBaseUrl, id, pageParam, signal,kind),
    getNextPageParam: (last) => last.page < last.pageCount ? last.page + 1 : undefined,
  })
  const rows = discoveries.data?.pages.flatMap((page) => page.items) ?? []
  if (!rows.length && !discoveries.isError) return null
  return <Section title="Discoveries">
    {rows.map((item) => {
      const provider = item.provider === 'lastfm' ? 'Last.fm' : item.provider === 'spotify' ? 'Spotify' : item.provider === 'tidal' ? 'TIDAL' : item.provider
      return <SourceRow key={item.id} mark={<ProviderMark name={provider} src={providerLogoUrl(item.provider)} />} name={discoveryLabels[item.operation] ?? item.operation} match={provider} when={formatDateTime(item.observedAt)}>
        <KeyValues items={[
          { label: 'Found from', value: discoverySubject(item.subjectKind, item.subjectId) },
          { label: 'Relationship', value: item.relationshipRole === 'appears_on' ? 'Appears on' : item.relationshipRole },
          { label: 'Page', value: item.page },
          { label: 'Position', value: item.position },
          { label: 'Evidence', value: item.jobId ? <DetailLink kind="job" id={item.jobId}>Open job responses</DetailLink> : 'Catalogue summary' },
        ]} />
      </SourceRow>
    })}
    {discoveries.isError && <Notice tone="danger" action={<Button variant="link" onClick={() => void discoveries.refetch()}>Retry</Button>}>Could not load discoveries.</Notice>}
    {discoveries.hasNextPage && <Button variant="link" disabled={discoveries.isFetchingNextPage} onClick={() => void discoveries.fetchNextPage()}>Show more</Button>}
  </Section>
}
