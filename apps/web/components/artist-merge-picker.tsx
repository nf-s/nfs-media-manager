'use client'

import { ReadButton } from '@/components/read-button'
import { useDeferredValue, useEffect, useId, useRef, useState } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { BrowsePageSliceSchema } from '@repo/schemas/browse'
import { ArtistSummarySchema, type ArtistSummary } from '@repo/schemas/creators'
import { Notice, Skeleton, State } from '@repo/ui/components/ds/feedback'
import { List, ListRow, RowTitle } from '@repo/ui/components/ds/list-row'
import { Button } from '@repo/ui/components/ui/button'
import { Input } from '@repo/ui/components/ui/input'
import { formatItemCount } from '@repo/ui/lib/format'
import { fetchApiData } from '@/utils/api'
import { MediaThumb } from './media-artwork'
import { useConfig } from './providers'

const candidatePage = BrowsePageSliceSchema(ArtistSummarySchema)
const tracks = { one: 'library track', other: 'library tracks' }
const albums = { one: 'library album', other: 'library albums' }

function candidateSummary(artist: ArtistSummary) {
  return [
    artist.inLibrary === false ? 'Outside library' : 'In library',
    formatItemCount(artist.trackCount, tracks),
    formatItemCount(artist.albumCount, albums),
  ].join(' · ')
}

export function ArtistMergePicker({
  artist,
  onClose,
  onPick,
}: {
  artist: ArtistSummary
  onClose: () => void
  onPick: (id: string) => void
}) {
  const { apiBaseUrl } = useConfig()
  const dialog = useRef<HTMLDialogElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const titleId = useId()
  const initial = artist.name
  const [draft, setDraft] = useState<string | null>(null)
  const search = useDeferredValue(draft)
  const term = search === null ? initial.trim() : search.trim().slice(0, 200)
  const candidates = useInfiniteQuery({
    queryKey: ['artists', 'merge-candidates', term, search === null],
    initialPageParam: 1,
    enabled: Boolean(term),
    queryFn: ({ pageParam, signal }) => {
      const params = new URLSearchParams({
        libraryScope: 'all',
        page: String(pageParam),
        size: '12',
      })
      if (search === null)
        params.set(
          'filters',
          JSON.stringify([{ field: 'name', value: term, mode: 'required' }]),
        )
      else params.set('q', term)
      return fetchApiData(
        apiBaseUrl,
        `/api/v1/artists/browse-page?${params}`,
        candidatePage,
        { signal },
      )
    },
    getNextPageParam: (page) => (page.hasMore ? page.page + 1 : undefined),
  })
  useEffect(() => {
    const element = dialog.current
    const previous = document.activeElement
    if (!element?.open) element?.showModal()
    input.current?.focus()
    input.current?.select()
    return () => {
      element?.close()
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus({ preventScroll: true })
    }
  }, [])
  const items =
    candidates.data?.pages
      .flatMap((page) => page.items)
      .filter((item) => item.id !== artist.id) ?? []
  const searching = search !== draft || (Boolean(term) && candidates.isPending)
  return (
    <dialog
      ref={dialog}
      className="dtl-dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault()
        event.stopPropagation()
        onClose()
      }}
      onClick={(event) => {
        event.stopPropagation()
        if (event.target === event.currentTarget) onClose()
      }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <div className="dtl-dialog-inner">
        <div className="ds-inspector-bar">
          <div className="ds-crumbs">
            <b id={titleId}>Merge “{artist.name}” with…</b>
          </div>
          <Button variant="ghost" icon aria-label="Close" onClick={onClose}>
            <X className="ds-i" aria-hidden="true" />
          </Button>
        </div>
        <div className="dtl-dialog-body">
          <Input
            ref={input}
            type="search"
            aria-label="Search artists"
            placeholder="Search artists"
            maxLength={200}
            value={draft ?? initial}
            onChange={(event) => setDraft(event.target.value)}
          />
          {candidates.isError && (
            <Notice
              tone="danger"
              action={
                <ReadButton size="xs" read={() => candidates.refetch()}>
                  Retry
                </ReadButton>
              }
            >
              Could not search artists.
            </Notice>
          )}
          {searching ? (
            <div className="data-stack" role="status" aria-busy="true">
              <span className="sr-only">Searching artists</span>
              <Skeleton height={48} />
            </div>
          ) : (
            <>
              {items.length > 0 ? (
                <List compact aria-label="Artists to merge with">
                  {items.map((item) => {
                    const summary = candidateSummary(item)
                    return (
                      <ListRow
                        key={item.id}
                        thumb={
                          <MediaThumb kind="artist" src={item.artworkUrl} />
                        }
                        title={
                          <RowTitle>
                            <span title={item.name}>{item.name}</span>
                          </RowTitle>
                        }
                        by={summary}
                        play={
                          <Button
                            size="xs"
                            aria-label={`Choose ${item.name} · ${summary}`}
                            onClick={() => onPick(item.id)}
                          >
                            Choose
                          </Button>
                        }
                      />
                    )
                  })}
                </List>
              ) : (
                candidates.isSuccess &&
                !candidates.hasNextPage && (
                  <State size="sm" title="No other artists found" />
                )
              )}
              {candidates.hasNextPage && (
                <div className="ds-actions">
                  <ReadButton
                    size="xs"
                    disabled={candidates.isFetching}
                    loadingLabel="Loading more…"
                    loadedLabel="Loaded more"
                    read={() => candidates.fetchNextPage()}
                  >
                    {candidates.isFetchingNextPage ? 'Loading...' : 'Show more'}
                  </ReadButton>
                </div>
              )}
            </>
          )}
          <div className="ds-actions">
            <Button onClick={onClose}>Cancel</Button>
          </div>
        </div>
      </div>
    </dialog>
  )
}
