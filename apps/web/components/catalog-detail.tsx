'use client'

import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { LibraryAction } from '@repo/ui/components/ds/library-action'
import type { CatalogNativeKind } from '@repo/schemas/catalog'
import { MixIdSchema, MixShowIdSchema } from '@repo/schemas/subscriptions'
import { Section, KeyValues } from '@repo/ui/components/ds/facts'
import { Notice } from '@repo/ui/components/ds/feedback'
import { ProviderMark } from '@repo/ui/components/ds/pill'
import { SourceRow } from '@repo/ui/components/ds/source'
import { Button } from '@repo/ui/components/ui/button'
import { formatDateTime } from '@repo/ui/lib/format'
import { addCatalogMedia, catalogDiscoveries } from '@/utils/catalog-api'
import { invalidateManualMediaAddition } from '@/utils/manual-media-add'
import { providerLogoUrl } from '@/utils/provider-logos'
import { discoverySourceLabels } from '@/utils/library-scope'
import { useConfig } from './providers'
import { DetailLink } from './detail-link'

function nativeQueryKeys(kind: CatalogNativeKind, id: string) {
  switch (kind) {
    case 'artist': return [['artist', id], ['artists'], ['artist-selection']]
    case 'person': return [['person', id], ['people']]
    case 'playlist': return [['playlist', id], ['playlists']]
    case 'collection': return [['album-collection', id], ['film-collection', id], ['album-collections'], ['film-collections']]
    case 'subscription-source':
    case 'subscription-item': return [[MixIdSchema.safeParse(id).success ? 'mixes' : 'subscriptions']]
  }
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
      if (kind === 'album' || kind === 'film' || kind === 'track') {
        await Promise.all([invalidateManualMediaAddition(client, kind),
          client.invalidateQueries({ queryKey: [kind, id] }),
          client.invalidateQueries({ queryKey: [kind === 'film' ? 'people' : 'artists'] }),
        ])
      } else {
        await Promise.all(nativeQueryKeys(kind, id).map(queryKey => client.invalidateQueries({ queryKey })))
      }
    },
  })
  return <>
    <LibraryAction kind={kind === 'subscription-source' ? 'show' : kind === 'subscription-item' ? 'item' : kind} name={title} saved={inLibrary || action.isSuccess} pending={action.isPending} onAdd={() => action.mutate()} />
    {action.isError && <Notice tone="danger">Could not add to library.</Notice>}
  </>
}

function discoverySubject(kind: string | null, id: string | null) {
  if (!id) return undefined
  if (kind === 'subscription-source') kind = MixShowIdSchema.safeParse(id).success ? 'show' : 'channel'
  if (kind === 'subscription-item') kind = MixIdSchema.safeParse(id).success ? 'mix' : 'subscription'
  if (kind !== 'artist' && kind !== 'person' && kind !== 'track' && kind !== 'album' && kind !== 'film' && kind !== 'playlist' && kind !== 'collection' && kind !== 'show' && kind !== 'channel' && kind !== 'mix' && kind !== 'subscription') return undefined
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
      return <SourceRow key={item.id} mark={<ProviderMark name={provider} src={providerLogoUrl(item.provider)} />} name={discoverySourceLabels.get(item.operation) ?? item.operation} match={provider} when={formatDateTime(item.observedAt)}>
        <KeyValues items={[
          { label: 'Found from', value: discoverySubject(item.subjectKind, item.subjectId) },
          { label: 'Relationship', value: item.relationshipRole === 'appears_on' ? 'Appears on' : item.relationshipRole },
          ...item.details,
          { label: 'Page', value: item.page },
          { label: 'Position', value: item.position },
          { label: 'Evidence', value: item.jobId ? <DetailLink kind="job" id={item.jobId} tab="data" view={item.responseId ? { jobResponse: item.responseId } : undefined}>{item.responseId ? 'Open response' : 'Open job data'}</DetailLink> : 'Catalogue summary' },
        ]} />
      </SourceRow>
    })}
    {discoveries.isError && <Notice tone="danger" action={<Button variant="link" onClick={() => void discoveries.refetch()}>Retry</Button>}>Could not load discoveries.</Notice>}
    {discoveries.hasNextPage && <Button variant="link" disabled={discoveries.isFetchingNextPage} onClick={() => void discoveries.fetchNextPage()}>Show more</Button>}
  </Section>
}
