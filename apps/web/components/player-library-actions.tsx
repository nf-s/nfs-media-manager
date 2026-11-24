'use client'

import { createContext, useContext, useState, type ReactNode } from 'react'
import {
  useMutation,
  useMutationState,
  useQueries,
  useQueryClient,
} from '@tanstack/react-query'
import type { CatalogMembershipResult } from '@repo/schemas/manual-add'
import type {
  PlaybackCatalogInput,
  PlaybackCatalogItem,
  PlaybackCatalogResult,
} from '@repo/schemas/playback'
import { LibraryAction } from '@repo/ui/components/ds/library-action'
import { useCatalogMembership } from '@/hooks/use-catalog-membership'
import { addCatalogMedia } from '@/utils/catalog-api'
import { recordPlaybackCatalog } from '@/utils/playback-catalog'
import {
  catalogLookups,
  playbackItemMembership,
  type PlaybackLibraryItem,
} from '@/utils/playback-library'
import {
  addManualMediaItem,
  invalidateManualMediaAddition,
} from '@/utils/manual-media-add'
import ManualMediaAdd from './manual-media-add'
import { useConfig } from './providers'

const mutationKey = ['player-library-add']
type CatalogItem = PlaybackLibraryItem['catalog'][number]
type SaveItem = {
  mediaType: CatalogItem['mediaType']
  mediaItemId?: string
  externalId?: string
}

const PlayerLibraryContext = createContext<{
  save: (item: SaveItem) => void
  find: (item: PlaybackLibraryItem) => void
}>({
  save: () => undefined,
  find: () => undefined,
})

export function PlayerLibraryActions({ children }: { children: ReactNode }) {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const [chosen, setChosen] = useState<PlaybackLibraryItem | null>(null)
  const save = useMutation({
    mutationKey,
    mutationFn: async ({ mediaType, mediaItemId, externalId }: SaveItem) => {
      if (mediaItemId)
        return (await addCatalogMedia(apiBaseUrl, mediaItemId)).mediaItemId
      if (!externalId) throw new Error('This item needs a Spotify reference.')
      return addManualMediaItem(apiBaseUrl, mediaType, {
        externalId,
        mediaItemId: null,
      })
    },
    onSuccess: (mediaItemId, { mediaType, externalId }) => {
      client.setQueriesData<CatalogMembershipResult>(
        { queryKey: ['catalog-membership'] },
        (data) =>
          data && {
            items: data.items.map((row) =>
              row.mediaType === mediaType && row.externalId === externalId
                ? { ...row, mediaItemId, ambiguous: false }
                : row,
            ),
          },
      )
      void client.invalidateQueries({ queryKey: ['playback-catalog'] })
      void invalidateManualMediaAddition(client, mediaType)
    },
  })
  return (
    <PlayerLibraryContext.Provider
      value={{ save: save.mutate, find: setChosen }}
    >
      {children}
      {chosen && (
        <ManualMediaAdd
          mediaType={chosen.kind}
          initialQuery={[chosen.title, chosen.artist].filter(Boolean).join(' ')}
          onClose={() => setChosen(null)}
          onAdded={() => setChosen(null)}
        />
      )}
    </PlayerLibraryContext.Provider>
  )
}

export function usePlayerLibraryMembership(
  items: readonly (PlaybackLibraryItem | null)[],
  operation: PlaybackCatalogInput['operation'],
  observed: readonly (PlaybackCatalogItem | null)[],
) {
  const { apiBaseUrl } = useConfig()
  const lookup = useCatalogMembership(catalogLookups(items))
  const identified = new Map(
    observed.flatMap((item) =>
      item ? [[`${item.kind}:${item.spotifyId}`, item]] : [],
    ),
  )
  const catalog = [...identified].sort(([a], [b]) => a.localeCompare(b))
  const queries = useQueries({
    queries: Array.from(
      { length: Math.ceil(catalog.length / 50) },
      (_, chunk) => {
        const batch = catalog.slice(chunk * 50, (chunk + 1) * 50)
        return {
          queryKey: ['playback-catalog', operation, batch],
          queryFn: ({ signal }: { signal: AbortSignal }) =>
            recordPlaybackCatalog(
              apiBaseUrl,
              operation,
              batch.map(([, item]) => item),
              signal,
            ),
          staleTime: Infinity,
        }
      },
    ),
  })
  const references = queries.flatMap(({ data }) => data?.items ?? [])
  return {
    data: lookup.data,
    references,
    pending: queries.some((query) => query.isLoading) || lookup.isLoading,
    failed: queries.some((query) => query.isError) || lookup.isError,
  }
}

export type PlayerLibraryMembership = ReturnType<
  typeof usePlayerLibraryMembership
>

export function observedPlaybackItem(
  item: PlaybackLibraryItem,
  references: PlaybackCatalogResult['items'],
) {
  const [exact] = item.catalog
  return references.find(
    ({ kind, spotifyId }) =>
      kind === item.kind && spotifyId === exact?.externalId,
  )
}

export function playerItemIdentity(
  item: PlaybackLibraryItem,
  membership: PlayerLibraryMembership,
) {
  const stored = observedPlaybackItem(item, membership.references)?.item
  const album =
    item.kind === 'album'
      ? membership.references.find(
          ({ album }) => album && album.id === item.mediaItemId,
        )?.album
      : null
  const match = playbackItemMembership(item, membership.data)
  return {
    mediaItemId: stored?.id ?? album?.id ?? match.mediaItemId,
    inLibrary:
      stored?.inLibrary ?? album?.inLibrary ?? Boolean(match.mediaItemId),
    ambiguous: !stored && match.ambiguous,
  }
}

export function PlayerLibraryAction({
  item,
  membership,
  touch,
}: {
  item: PlaybackLibraryItem
  membership: PlayerLibraryMembership
  touch?: boolean
}) {
  const { save, find } = useContext(PlayerLibraryContext)
  const { mediaItemId, inLibrary, ambiguous } = playerItemIdentity(
    item,
    membership,
  )
  const [exact] = item.catalog
  const needsSearch = !mediaItemId && (!exact || ambiguous || membership.failed)
  const saving = useMutationState({
    filters: { mutationKey, status: 'pending' },
    select: (mutation) => mutation.state.variables,
  }).some(
    (pending) =>
      typeof pending === 'object' &&
      pending !== null &&
      (('mediaItemId' in pending && pending.mediaItemId === mediaItemId) ||
        item.catalog.some(
          (entry) =>
            'externalId' in pending &&
            'mediaType' in pending &&
            pending.externalId === entry.externalId &&
            pending.mediaType === entry.mediaType,
        )),
  )
  return (
    <LibraryAction
      kind={item.kind}
      name={item.title}
      touch={touch}
      saved={inLibrary}
      disabled={Boolean(!inLibrary && membership.pending)}
      pending={!inLibrary && saving}
      action={needsSearch ? 'find' : 'add'}
      onAdd={() => {
        if (needsSearch) find(item)
        else
          save({
            mediaType: item.kind,
            mediaItemId: mediaItemId ?? undefined,
            externalId: exact?.externalId,
          })
      }}
    />
  )
}
