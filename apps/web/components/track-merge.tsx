'use client'

import { useDeferredValue, useEffect, useId, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { PaginatedDataSchema } from '@repo/schemas/common'
import {
  TrackListItemSchema,
  TrackMergeInputSchema,
  TrackMergeResultSchema,
  trackSpotifyMatchLabels,
  type TrackListItem,
} from '@repo/schemas/tracks'
import { Button } from '@repo/ui/components/ui/button'
import { Input } from '@repo/ui/components/ui/input'
import { fetchApiData } from '@/utils/api'
import { trackServiceLinks } from '@/utils/track-links'
import { errorMessage, invalidateScrobbleLinks } from './lastfm-sync'
import { useConfig } from './providers'
import ServiceIconLinks from './service-icon-links'

const TrackPageSchema = PaginatedDataSchema(TrackListItemSchema)
const SEARCH_RESULTS = 20

export function canMergeLastfmTrack(track: TrackListItem) {
  return (
    track.sources.includes('lastfm') && track.spotifyMatch !== 'spotify-import'
  )
}

/** Searches stored imported Spotify tracks without contacting a provider. */
export async function loadTrackMergeCandidates(
  apiBaseUrl: string,
  query: string,
  page: number,
  signal?: AbortSignal,
) {
  const params = new URLSearchParams({
    q: query,
    page: String(page),
    size: String(SEARCH_RESULTS),
    sortBy: 'title',
    direction: 'asc',
    filters: JSON.stringify([
      {
        field: 'spotifyMatch',
        value: trackSpotifyMatchLabels['spotify-import'],
        mode: 'required',
      },
    ]),
  })
  return fetchApiData(apiBaseUrl, `/api/v1/tracks?${params}`, TrackPageSchema, {
    signal,
  })
}

/** Submits only the reviewed pair; the server rechecks current membership. */
export async function mergeLibraryTrack(
  apiBaseUrl: string,
  source: TrackListItem,
  target: TrackListItem,
) {
  if (!canMergeLastfmTrack(source))
    throw new Error('This track is not a separate Last.fm record.')
  if (target.id === source.id || target.spotifyMatch !== 'spotify-import')
    throw new Error('Choose an imported Spotify track to keep.')
  return fetchApiData(
    apiBaseUrl,
    `/api/v1/tracks/${encodeURIComponent(source.id)}/merge`,
    TrackMergeResultSchema,
    {
      method: 'POST',
      body: JSON.stringify(
        TrackMergeInputSchema.parse({ targetId: target.id }),
      ),
    },
  )
}

function TrackIdentity({ track }: { track: TrackListItem }) {
  return (
    <div className="min-w-0 break-words">
      <div className="flex flex-wrap items-center gap-x-2">
        <strong>{track.title}</strong>
        <ServiceIconLinks links={trackServiceLinks(track)} />
      </div>
      <p>{track.artists.join(', ') || 'Unknown artist'}</p>
      <p className="quiet">{track.albumName ?? 'Album unknown'}</p>
    </div>
  )
}

export function TrackMergeReview({
  source,
  target,
  pending,
  onConfirm,
  onBack,
}: {
  source: TrackListItem
  target: TrackListItem
  pending: boolean
  onConfirm: () => void
  onBack: () => void
}) {
  return (
    <div
      className="space-y-4 text-sm"
      role="group"
      aria-label="Confirm track merge"
    >
      <section aria-label="Last.fm record to merge">
        <h3 className="mb-1 font-medium">Last.fm record to merge</h3>
        <TrackIdentity track={source} />
        <p className="quiet">{source.scrobbles.toLocaleString()} scrobbles</p>
      </section>
      <section aria-label="Spotify track to keep">
        <h3 className="mb-1 font-medium">Spotify track to keep</h3>
        <TrackIdentity track={target} />
      </section>
      <p>
        The Spotify track keeps its Spotify ID and playlists. The separate
        Last.fm record is removed, and its recorded names and listening history
        belong to the Spotify track. Later syncs keep this choice.
      </p>
      <div className="form-actions">
        <Button size="sm" disabled={pending} onClick={onConfirm}>
          {pending ? 'Merging...' : 'Confirm merge'}
        </Button>
        <Button size="sm" variant="outline" disabled={pending} onClick={onBack}>
          Choose another track
        </Button>
      </div>
    </div>
  )
}

export function TrackMergePanel({
  track,
  onClose,
  onMerged,
}: {
  track: TrackListItem
  onClose: () => void
  onMerged: (targetId: string) => void
}) {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const [draft, setDraft] = useState(track.title.slice(0, 200))
  const query = useDeferredValue(draft.trim())
  const [page, setPage] = useState(1)
  const [target, setTarget] = useState<TrackListItem | null>(null)
  const candidates = useQuery({
    queryKey: ['tracks', 'merge-candidates', query, page],
    enabled: target === null && query.length > 0,
    queryFn: ({ signal }) =>
      loadTrackMergeCandidates(apiBaseUrl, query, page, signal),
  })
  const merge = useMutation({
    retry: false,
    mutationFn: (chosen: TrackListItem) =>
      mergeLibraryTrack(apiBaseUrl, track, chosen),
    onSuccess: async (result) => {
      onMerged(result.targetId)
      onClose()
      await invalidateScrobbleLinks(client, track.id)
    },
  })
  useEffect(() => {
    const element = dialog.current
    const previous = document.activeElement
    if (!element?.open) element?.showModal()
    element?.querySelector('input')?.focus()
    return () => {
      element?.close()
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus({ preventScroll: true })
    }
  }, [])
  const items =
    candidates.data?.items.filter(
      (item) => item.id !== track.id && item.spotifyMatch === 'spotify-import',
    ) ?? []
  return (
    <dialog
      ref={dialog}
      className="tag-drawer"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault()
        event.stopPropagation()
        if (!merge.isPending) onClose()
      }}
      onClick={(event) => {
        event.stopPropagation()
        if (!merge.isPending && event.target === event.currentTarget) onClose()
      }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <div className="tag-drawer-inner">
        <div className="detail-topbar">
          <span id={titleId}>Track match</span>
          <button
            type="button"
            aria-label="Close track merge"
            disabled={merge.isPending}
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </div>
        <div className="tag-drawer-body">
          {target ? (
            <TrackMergeReview
              source={track}
              target={target}
              pending={merge.isPending}
              onConfirm={() => merge.mutate(target)}
              onBack={() => {
                setTarget(null)
                merge.reset()
              }}
            />
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-x-2">
                <h1>{track.title}</h1>
                <ServiceIconLinks links={trackServiceLinks(track)} />
              </div>
              <p className="break-words">
                {track.artists.join(', ') || 'Unknown artist'}
              </p>
              <p className="quiet text-xs">
                {track.albumName ?? 'Album unknown'} ·{' '}
                {track.scrobbles.toLocaleString()} scrobbles
              </p>
              <h2 className="mt-2 text-sm font-medium">
                Spotify library track
              </h2>
              <Input
                type="search"
                aria-label="Search Spotify library tracks"
                placeholder="Search library tracks"
                maxLength={200}
                value={draft}
                onChange={(event) => {
                  setDraft(event.target.value)
                  setPage(1)
                }}
              />
              {query.length > 0 && candidates.isFetching && (
                <p role="status">Searching tracks...</p>
              )}
              {candidates.isError && (
                <p role="alert">
                  {errorMessage(candidates.error, 'Could not search tracks.')}{' '}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => candidates.refetch()}
                  >
                    Retry
                  </Button>
                </p>
              )}
              {candidates.isSuccess && !items.length && (
                <p className="quiet">No imported Spotify tracks found.</p>
              )}
              {items.length > 0 && (
                <ul className="grid gap-2" aria-label="Spotify library tracks">
                  {items.map((item) => (
                    <li
                      key={item.id}
                      className="flex items-start gap-2 text-sm"
                    >
                      <Button
                        size="sm"
                        variant="outline"
                        className="shrink-0"
                        aria-label={`Merge with ${item.title} by ${item.artists.join(', ')}`}
                        onClick={() => setTarget(item)}
                      >
                        Merge
                      </Button>
                      <TrackIdentity track={item} />
                    </li>
                  ))}
                </ul>
              )}
              {candidates.data && candidates.data.pageCount > 1 && (
                <div className="form-actions" aria-label="Track search pages">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={page <= 1 || candidates.isFetching}
                    onClick={() => setPage(page - 1)}
                  >
                    Previous
                  </Button>
                  <span className="text-sm">
                    Page {page} of {candidates.data.pageCount}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={
                      page >= candidates.data.pageCount || candidates.isFetching
                    }
                    onClick={() => setPage(page + 1)}
                  >
                    Next
                  </Button>
                </div>
              )}
            </>
          )}
          {merge.isError && (
            <p role="alert">
              {errorMessage(merge.error, 'Could not merge these tracks.')}
            </p>
          )}
        </div>
      </div>
    </dialog>
  )
}

export default function TrackMerge({
  track,
  onMerged,
}: {
  track: TrackListItem
  onMerged: (targetId: string) => void
}) {
  const [open, setOpen] = useState(false)
  if (!canMergeLastfmTrack(track)) return null
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        Merge with Spotify track
      </Button>
      {open && (
        <TrackMergePanel
          key={track.id}
          track={track}
          onClose={() => setOpen(false)}
          onMerged={onMerged}
        />
      )}
    </>
  )
}
