'use client'

import { useDeferredValue, useEffect, useId, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { PaginatedDataSchema } from '@repo/schemas/common'
import {
  TrackListItemSchema,
  TrackMergeInputSchema,
  TrackMergeResultSchema,
  TrackScrobbleMatchInputSchema,
  trackSpotifyMatchLabels,
  type TrackListItem,
} from '@repo/schemas/tracks'
import { Button } from '@repo/ui/components/ui/button'
import { Input } from '@repo/ui/components/ui/input'
import { fetchApiData } from '@/utils/api'
import { useVirtualTable } from '@/hooks/useVirtualTable'
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableState,
} from '@repo/ui/components/ui/table'
import { Notice } from '@repo/ui/components/ds/feedback'
import { Section } from '@repo/ui/components/ds/facts'
import { formatCount } from '@repo/ui/lib/format'
import {
  SecondaryCell,
  SecondaryTableScroll,
  SecondaryVirtualRows,
} from './secondary-table'
import { trackServiceLinks } from '@/utils/track-links'
import { errorMessage, invalidateScrobbleLinks } from './lastfm-sync'
import { useConfig } from './providers'
import ServiceIconLinks from './service-icon-links'

const TrackPageSchema = PaginatedDataSchema(TrackListItemSchema)
const SEARCH_RESULTS = 20

export type TrackScrobbleCorrection = {
  artistKey: string
  trackKey: string
  artistName: string | null
  trackName: string | null
}

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
  includeAlbumTracks = false,
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
        value:
          trackSpotifyMatchLabels[
            includeAlbumTracks ? 'unmatched' : 'spotify-import'
          ],
        mode: includeAlbumTracks ? 'exclude' : 'required',
      },
    ]),
  })
  return fetchApiData(apiBaseUrl, `/api/v1/tracks?${params}`, TrackPageSchema, {
    signal,
  })
}

export async function changeTrackScrobbleMatch(
  apiBaseUrl: string,
  sourceId: string,
  target: TrackListItem,
  { artistKey, trackKey }: TrackScrobbleCorrection,
) {
  if (target.id === sourceId || !target.spotifyTrackId)
    throw new Error('Choose another track with a Spotify ID.')
  return fetchApiData(
    apiBaseUrl,
    `/api/v1/tracks/${encodeURIComponent(sourceId)}/scrobble-match`,
    TrackMergeResultSchema,
    {
      method: 'POST',
      body: JSON.stringify(
        TrackScrobbleMatchInputSchema.parse({
          artistKey,
          trackKey,
          targetId: target.id,
        }),
      ),
    },
  )
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
    <div className="dtl-identity">
      <span className="ds-cell-id">
        <strong>{track.title}</strong>
        <ServiceIconLinks links={trackServiceLinks(track)} />
      </span>
      <span>{track.artists.join(', ') || 'Unknown artist'}</span>
      <span className="ds-muted">{track.albumName ?? 'Album unknown'}</span>
    </div>
  )
}

export function TrackMergeReview({
  source,
  target,
  correction,
  pending,
  onConfirm,
  onBack,
}: {
  source: TrackListItem
  target: TrackListItem
  correction?: TrackScrobbleCorrection
  pending: boolean
  onConfirm: () => void
  onBack: () => void
}) {
  if (correction)
    return (
      <div role="group" aria-label="Confirm scrobble match">
        <Section title="Last.fm record" flush>
          <div className="dtl-identity">
            <strong>{correction.trackName ?? source.title}</strong>
            <span>{correction.artistName ?? source.artists.join(', ')}</span>
          </div>
        </Section>
        <Section title="Current track">
          <TrackIdentity track={source} />
        </Section>
        <Section title="Spotify track to match">
          <TrackIdentity track={target} />
        </Section>
        <Section>
          <p>
            Listening history for this recorded name moves to the selected
            track. Both tracks keep their releases and playlists.
          </p>
        </Section>
        <div className="ds-actions">
          <Button variant="primary" disabled={pending} onClick={onConfirm}>
            {pending ? 'Saving...' : 'Confirm match'}
          </Button>
          <Button disabled={pending} onClick={onBack}>
            Choose another track
          </Button>
        </div>
      </div>
    )
  return (
    <div role="group" aria-label="Confirm track merge">
      <Section title="Last.fm record to merge" flush>
        <TrackIdentity track={source} />
        <span className="ds-muted">
          {formatCount(source.scrobbles)} scrobbles
        </span>
      </Section>
      <Section title="Spotify track to keep">
        <TrackIdentity track={target} />
      </Section>
      <Section>
        <p>
          The Spotify track keeps its Spotify ID and playlists. The separate
          Last.fm record is removed, and its recorded names and listening
          history belong to the Spotify track. Later syncs keep this choice.
        </p>
      </Section>
      <div className="ds-actions">
        <Button variant="primary" disabled={pending} onClick={onConfirm}>
          {pending ? 'Merging...' : 'Confirm merge'}
        </Button>
        <Button disabled={pending} onClick={onBack}>
          Choose another track
        </Button>
      </div>
    </div>
  )
}

export function TrackMergePanel({
  track,
  initialTarget,
  correction,
  onClose,
  onMerged,
}: {
  track: TrackListItem
  initialTarget?: TrackListItem
  correction?: TrackScrobbleCorrection
  onClose: () => void
  onMerged: (targetId: string) => void
}) {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const [draft, setDraft] = useState(
    (correction?.trackName ?? track.title).slice(0, 200),
  )
  const query = useDeferredValue(draft.trim())
  const [target, setTarget] = useState<TrackListItem | null>(
    initialTarget ?? null,
  )
  const candidates = useVirtualTable({
    queryKey: [
      'tracks',
      correction ? 'scrobble-match-candidates' : 'merge-candidates',
      query,
    ],
    pageSize: SEARCH_RESULTS,
    enabled: target === null && query.length > 0,
    loadPage: (page, _size, signal) =>
      loadTrackMergeCandidates(
        apiBaseUrl,
        query,
        page,
        signal,
        correction !== undefined,
      ),
  })
  const merge = useMutation({
    retry: false,
    mutationFn: (chosen: TrackListItem) =>
      correction
        ? changeTrackScrobbleMatch(apiBaseUrl, track.id, chosen, correction)
        : mergeLibraryTrack(apiBaseUrl, track, chosen),
    onSuccess: async (result) => {
      onMerged(result.targetId)
      onClose()
      await invalidateScrobbleLinks(client, correction ? undefined : track.id)
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
  return (
    <dialog
      ref={dialog}
      className="dtl-dialog"
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
      <div className="dtl-dialog-inner">
        <div className="ds-inspector-bar">
          <div className="ds-crumbs">
            <b id={titleId}>
              {correction ? 'Change scrobble match' : 'Track match'}
            </b>
          </div>
          <Button
            variant="ghost"
            icon
            aria-label={
              correction ? 'Close scrobble match' : 'Close track merge'
            }
            disabled={merge.isPending}
            onClick={onClose}
          >
            <X className="ds-i" aria-hidden="true" />
          </Button>
        </div>
        <div className="dtl-dialog-body">
          {target ? (
            <TrackMergeReview
              source={track}
              target={target}
              correction={correction}
              pending={merge.isPending}
              onConfirm={() => merge.mutate(target)}
              onBack={() => {
                setTarget(null)
                merge.reset()
              }}
            />
          ) : (
            <>
              <TrackIdentity track={track} />
              {!correction && (
                <span className="ds-muted">
                  {formatCount(track.scrobbles)} scrobbles
                </span>
              )}
              <label className="ds-field">
                <span className="ds-label">Spotify library track</span>
                <Input
                  type="search"
                  aria-label="Search Spotify library tracks"
                  placeholder="Search library tracks"
                  maxLength={200}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                />
              </label>
              {query.length > 0 && (
                <>
                  {candidates.hasTotal && (
                    <span className="ds-muted" role="status">
                      {formatCount(candidates.total)} matching tracks
                    </span>
                  )}
                  {candidates.isError && (
                    <Notice
                      tone="danger"
                      action={
                        <Button size="xs" onClick={candidates.retry}>
                          Retry
                        </Button>
                      }
                    >
                      Could not search tracks.
                    </Notice>
                  )}
                  <SecondaryTableScroll
                    ref={candidates.scroller}
                    onScroll={candidates.onScroll}
                    className="dtl-bounded"
                    role="region"
                    aria-label="Spotify library tracks"
                    aria-busy={candidates.isFetching}
                  >
                    <table
                      className="ds-table"
                      aria-label="Spotify library tracks"
                    >
                      <TableHeader>
                        <TableRow>
                          <TableHead>Track</TableHead>
                          <TableHead>Artist</TableHead>
                          <TableHead>Album</TableHead>
                          <TableHead>
                            <span className="sr-only">Action</span>
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {candidates.hasTotal && !candidates.total && (
                          <TableState colSpan={4}>
                            {correction
                              ? 'No tracks with Spotify IDs found.'
                              : 'No imported Spotify tracks found.'}
                          </TableState>
                        )}
                        {(!candidates.isError || candidates.hasTotal) && (
                          <SecondaryVirtualRows
                            window={candidates}
                            colSpan={4}
                            renderRow={(item) =>
                              item.id === track.id ||
                              (correction
                                ? !item.spotifyTrackId
                                : item.spotifyMatch !== 'spotify-import') ? (
                                <tr aria-hidden="true">
                                  <td
                                    colSpan={4}
                                    style={{
                                      height: candidates.rowHeight,
                                      border: 0,
                                      padding: 0,
                                    }}
                                  />
                                </tr>
                              ) : (
                                <TableRow key={item.id}>
                                  <TableCell>
                                    <div className="ds-cell-id">
                                      <SecondaryCell text={item.title}>
                                        {item.title}
                                      </SecondaryCell>
                                      <ServiceIconLinks
                                        links={trackServiceLinks(item)}
                                      />
                                    </div>
                                  </TableCell>
                                  <TableCell>
                                    <SecondaryCell
                                      text={item.artists.join(', ')}
                                    >
                                      {item.artists.join(', ') ||
                                        'Unknown artist'}
                                    </SecondaryCell>
                                  </TableCell>
                                  <TableCell>
                                    <SecondaryCell
                                      text={item.albumName ?? undefined}
                                    >
                                      {item.albumName ?? 'Album unknown'}
                                    </SecondaryCell>
                                  </TableCell>
                                  <TableCell align="end">
                                    <Button
                                      size="xs"
                                      aria-label={`${correction ? 'Match to' : 'Merge with'} ${item.title} by ${item.artists.join(', ')}`}
                                      onClick={() => setTarget(item)}
                                    >
                                      {correction ? 'Match' : 'Merge'}
                                    </Button>
                                  </TableCell>
                                </TableRow>
                              )
                            }
                          />
                        )}
                      </TableBody>
                    </table>
                  </SecondaryTableScroll>
                </>
              )}
            </>
          )}
          {merge.isError && (
            <Notice tone="danger">
              {errorMessage(
                merge.error,
                correction
                  ? 'Could not change the scrobble match.'
                  : 'Could not merge these tracks.',
              )}
            </Notice>
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
      <Button size="md" onClick={() => setOpen(true)}>
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
