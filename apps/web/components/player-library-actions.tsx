'use client'

import { createContext, useContext, useState, type ReactNode } from 'react'
import {
  useMutation,
  useMutationState,
  useQueryClient,
} from '@tanstack/react-query'
import type { CatalogMembershipResult } from '@repo/schemas/manual-add'
import { LibraryAction } from '@repo/ui/components/ds/library-action'
import { useCatalogMembership } from '@/hooks/use-catalog-membership'
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

const PlayerLibraryContext = createContext<{
  save: (item: CatalogItem) => void
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
    mutationFn: ({ mediaType, externalId }: CatalogItem) =>
      addManualMediaItem(apiBaseUrl, mediaType, {
        externalId,
        mediaItemId: null,
      }),
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
) {
  const lookup = useCatalogMembership(catalogLookups(items))
  return {
    data: lookup.data,
    pending: lookup.isLoading,
    failed: lookup.isError,
  }
}

export type PlayerLibraryMembership = ReturnType<
  typeof usePlayerLibraryMembership
>

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
  const { mediaItemId, ambiguous } = playbackItemMembership(
    item,
    membership.data,
  )
  const [exact] = item.catalog
  const needsSearch = !exact || ambiguous || membership.failed
  const saving = useMutationState({
    filters: { mutationKey, status: 'pending' },
    select: (mutation) => mutation.state.variables,
  }).some(
    (pending) =>
      typeof pending === 'object' &&
      pending !== null &&
      item.catalog.some(
        (entry) =>
          'externalId' in pending &&
          'mediaType' in pending &&
          pending.externalId === entry.externalId &&
          pending.mediaType === entry.mediaType,
      ),
  )
  return (
    <LibraryAction
      kind={item.kind}
      name={item.title}
      touch={touch}
      saved={Boolean(mediaItemId)}
      disabled={Boolean(exact && !mediaItemId && membership.pending)}
      pending={!mediaItemId && saving}
      action={needsSearch ? 'find' : 'add'}
      onAdd={() => {
        if (needsSearch) find(item)
        else save(exact)
      }}
    />
  )
}
