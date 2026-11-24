'use client'

import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { LibraryAction } from '@repo/ui/components/ds/library-action'
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
  kind: 'album' | 'track' | 'film'
  title: string
  inLibrary: boolean
}) {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const action = useMutation({
    mutationFn: () => addCatalogMedia(apiBaseUrl, id),
    onSuccess: async () => {
      await Promise.all([
        invalidateManualMediaAddition(client, kind),
        client.invalidateQueries({ queryKey: [kind, id] }),
        client.invalidateQueries({ queryKey: ['artists'] }),
        client.invalidateQueries({ queryKey: ['artist'] }),
      ])
    },
  })
  return <>
    <LibraryAction kind={kind} name={title} saved={inLibrary || action.isSuccess} pending={action.isPending} onAdd={() => action.mutate()} />
    {action.isError && <Notice tone="error">Could not add to library.</Notice>}
  </>
}

function discoverySubject(kind: string | null, id: string | null) {
  if (!id || (kind !== 'artist' && kind !== 'person' && kind !== 'track' && kind !== 'album' && kind !== 'film' && kind !== 'playlist')) return undefined
  const label = kind === 'artist' ? 'Open artist' : `Open ${kind}`
  return <DetailLink kind={kind} id={id}>{label}</DetailLink>
}

export function CatalogDiscoveries({ id }: { id: string }) {
  const { apiBaseUrl } = useConfig()
  const discoveries = useInfiniteQuery({
    queryKey: ['catalog-discoveries', id],
    initialPageParam: 1,
    queryFn: ({ pageParam, signal }) => catalogDiscoveries(apiBaseUrl, id, pageParam, signal),
    getNextPageParam: (last) => last.page < last.pageCount ? last.page + 1 : undefined,
  })
  const rows = discoveries.data?.pages.flatMap((page) => page.items) ?? []
  if (!rows.length && !discoveries.isError) return null
  return <Section title="Discoveries">
    {rows.map((item) => {
      const provider = item.provider === 'lastfm' ? 'Last.fm' : item.provider === 'spotify' ? 'Spotify' : item.provider === 'tidal' ? 'TIDAL' : item.provider
      return <SourceRow key={item.id} mark={<ProviderMark label={provider} icon={providerLogoUrl(item.provider)} />} name={discoveryLabels[item.operation] ?? item.operation} match={provider} when={formatDateTime(item.observedAt)}>
        <KeyValues items={[
          { label: 'Found from', value: discoverySubject(item.subjectKind, item.subjectId) },
          { label: 'Relationship', value: item.relationshipRole === 'appears_on' ? 'Appears on' : item.relationshipRole },
          { label: 'Page', value: item.page },
          { label: 'Position', value: item.position },
          { label: 'Evidence', value: item.jobId ? <DetailLink kind="job" id={item.jobId}>Open job responses</DetailLink> : 'Catalogue summary' },
        ]} />
      </SourceRow>
    })}
    {discoveries.isError && <Notice tone="error" action={<Button variant="link" onClick={() => void discoveries.refetch()}>Retry</Button>}>Could not load discoveries.</Notice>}
    {discoveries.hasNextPage && <Button variant="link" disabled={discoveries.isFetchingNextPage} onClick={() => void discoveries.fetchNextPage()}>Show more</Button>}
  </Section>
}
