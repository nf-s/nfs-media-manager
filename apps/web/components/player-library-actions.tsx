'use client'

import { createContext, useContext, type ReactNode } from 'react'
import { useMutation, useQueries, useQueryClient } from '@tanstack/react-query'
import type { CatalogMembershipResult } from '@repo/schemas/manual-add'
import type {
  PlaybackCatalogInput,
  PlaybackCatalogItem,
  PlaybackCatalogResult,
} from '@repo/schemas/playback'
import { LibraryAction } from '@repo/ui/components/ds/library-action'
import { useCatalogMembership } from '@/hooks/use-catalog-membership'
import {
  libraryAdditionUnavailable,
  saveLibraryAddition,
  useLibraryAddition,
} from '@/hooks/use-library-addition'
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
  rememberManualMediaAddition,
} from '@/utils/manual-media-add'
import { useAnnounceLibraryAddition, useConfig } from './providers'

const mutationKey = ['player-library-add']
type PlayerAddition = {
  mediaType: PlaybackLibraryItem['kind']
  externalId: string
  catalogId?: string
  title: string
}

const PlayerLibraryContext = createContext<(item: PlayerAddition) => void>(
  () => undefined,
)

export function PlayerLibraryActions({ children }: { children: ReactNode }) {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const announce = useAnnounceLibraryAddition()
  const save = useMutation({
    mutationKey,
    mutationFn: ({ mediaType, catalogId, externalId }: PlayerAddition) =>
      saveLibraryAddition(
        client,
        { kind: mediaType, catalogId, externalId },
        async () =>
          catalogId
            ? (await addCatalogMedia(apiBaseUrl, catalogId)).mediaItemId
            : addManualMediaItem(apiBaseUrl, mediaType, {
                externalId,
                mediaItemId: null,
              }),
      ),
    onSuccess: async (
      mediaItemId,
      { mediaType, externalId, catalogId, title },
    ) => {
      rememberManualMediaAddition(client, mediaType, externalId, mediaItemId)
      await Promise.all([
        client.cancelQueries({ queryKey: ['catalog-membership'] }),
        client.cancelQueries({ queryKey: ['playback-catalog'] }),
      ])
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
      if (catalogId) {
        const saved = { id: mediaItemId, inLibrary: true }
        client.setQueriesData<PlaybackCatalogResult>(
          { queryKey: ['playback-catalog'] },
          (data) =>
            data && {
              items: data.items.map((row) => ({
                ...row,
                item: row.item.id === catalogId ? saved : row.item,
                album: row.album?.id === catalogId ? saved : row.album,
              })),
            },
        )
      }
      announce(mediaType, title, mediaItemId)
      void invalidateManualMediaAddition(client, mediaType)
    },
  })
  return (
    <PlayerLibraryContext.Provider value={save.mutate}>
      {children}
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
  const client = useQueryClient()
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
          queryFn: async ({ signal }: { signal: AbortSignal }) => {
            const result = await recordPlaybackCatalog(
              apiBaseUrl,
              operation,
              batch.map(([, item]) => item),
              signal,
            )
            for (const { kind, item, album } of result.items) {
              if (!item.inLibrary)
                void client.invalidateQueries({
                  queryKey: [kind, item.id],
                  exact: true,
                })
              if (album && !album.inLibrary)
                void client.invalidateQueries({
                  queryKey: ['album', album.id],
                  exact: true,
                })
            }
            return result
          },
          staleTime: Infinity,
        }
      },
    ),
  })
  return {
    data: lookup.data,
    observed: [...identified.values()],
    references: queries.flatMap(({ data }) => data?.items ?? []),
    unresolved: lookup.isError || (lookup.isFetching && lookup.isStale),
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
  const [exact] = item.catalog
  const observation =
    exact &&
    membership.observed.find(
      ({ kind, spotifyId }) =>
        kind === item.kind && spotifyId === exact.externalId,
    )
  const albumTrack =
    exact &&
    item.kind === 'album' &&
    membership.observed.find(
      (entry) =>
        entry.kind === 'track' && entry.album?.spotifyId === exact.externalId,
    )
  const trackAlbum = albumTrack
    ? membership.references.find(
        ({ kind, spotifyId }) =>
          kind === 'track' && spotifyId === albumTrack.spotifyId,
      )?.album
    : null
  const observedItem = observedPlaybackItem(item, membership.references)
  const stored = observedItem?.item ?? trackAlbum
  const libraryTrackId = observedItem?.libraryTrackId
  const match = playbackItemMembership(item, membership.data)
  const originatingTrackId = item.kind === 'track' ? item.mediaItemId : null
  const catalogId = stored?.inLibrary
    ? stored.id
    : (libraryTrackId ?? item.mediaItemId ?? stored?.id ?? null)
  const mediaItemId =
    match.status === 'saved'
      ? match.mediaItemId
      : (originatingTrackId ?? catalogId)
  const awaitingObservation = (observation || albumTrack) && !stored
  const consistent = !item.mediaItemId || item.mediaItemId === stored?.id
  const add: PlayerAddition | null =
    match.status === 'missing' &&
    !membership.unresolved &&
    !awaitingObservation &&
    !stored?.inLibrary &&
    !libraryTrackId &&
    consistent
      ? {
          mediaType: item.kind,
          externalId: match.catalogItem.externalId,
          catalogId: stored?.id,
          title: item.title,
        }
      : null
  return { mediaItemId, add }
}

export function PlayerLibraryAction({
  item,
  membership,
  touch,
  showFeedback = true,
}: {
  item: PlaybackLibraryItem
  membership: PlayerLibraryMembership
  touch?: boolean
  showFeedback?: boolean
}) {
  const save = useContext(PlayerLibraryContext)
  const client = useQueryClient()
  const { add, mediaItemId } = playerItemIdentity(item, membership)
  const target = {
    kind: item.kind,
    catalogId: add?.catalogId ?? mediaItemId,
    externalId: add?.externalId ?? item.catalog[0]?.externalId,
  }
  const match = playbackItemMembership(item, membership.data)
  const confirmed =
    membership.unresolved ||
    (match.status !== 'saved' && match.status !== 'missing')
      ? undefined
      : match.status === 'saved'
  const receipt = useLibraryAddition(target, confirmed)
  return (
    <LibraryAction
      kind={item.kind}
      name={item.title}
      short
      touch={touch}
      saved={!add || Boolean(receipt?.committedId)}
      feedback={showFeedback ? receipt?.feedback : undefined}
      disabled={!showFeedback && receipt?.feedback?.phase === 'pending'}
      receiptId={receipt?.committedId}
      onAdd={() => {
        if (add && !libraryAdditionUnavailable(client, target)) save(add)
      }}
    />
  )
}
