'use client'

import { useEffect, useRef } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import {
  TidalSimilarSchema,
  type TidalSimilar,
  type TidalSimilarItem,
  type TidalSimilarJob,
  type TidalSimilarKind,
  type TidalSimilarSource,
} from '@repo/schemas/tidal'
import { Notice, State } from '@repo/ui/components/ds/feedback'
import { List, RowTitle } from '@repo/ui/components/ds/list-row'
import { PlayPair } from '@repo/ui/components/ds/play'
import { Status } from '@repo/ui/components/ds/status'
import {
  SuggestionLink,
  SuggestionRow,
  SuggestionRowSkeleton,
} from '@repo/ui/components/ds/suggestion'
import { FilterLine, ToolbarCount } from '@repo/ui/components/ds/toolbar'
import { Button } from '@repo/ui/components/ui/button'
import { formatCount, formatDate } from '@repo/ui/lib/format'
import { fetchApiData } from '@/utils/api'
import { LASTFM_SYNC_POLL_MS } from '@/utils/lastfm-sync'
import type { PlayableItem } from '@/utils/playback'
import { formatTrackDuration } from '@/utils/track-browse'
import { DetailLink } from './detail-link'
import { errorMessage } from './lastfm-sync'
import { MediaThumb } from './media-artwork'
import {
  AlbumReferencePlayButton,
  LibraryTrackPlayButton,
  playFromView,
  unavailableReason,
} from './play-controls'
import { usePlayback, usePlaybackControls } from './playback-provider'
import { useConfig } from './providers'

const similarPath = (kind: TidalSimilarKind, id: string) =>
  `/api/v1/tidal/similar/${kind === 'album' ? 'albums' : 'tracks'}/${encodeURIComponent(id)}`
const similarKey = (kind: TidalSimilarKind, id: string) => [
  'tidal-similar',
  kind,
  id,
]
const plural = { album: 'albums', track: 'tracks' }

export function isActiveSimilarJob(job: TidalSimilarJob | null | undefined) {
  return job?.status === 'queued' || job?.status === 'running'
}

function anyActive(similar: TidalSimilar | undefined) {
  return Boolean(
    similar &&
    (isActiveSimilarJob(similar.matchJob) ||
      isActiveSimilarJob(similar.job) ||
      isActiveSimilarJob(similar.lookupJob)),
  )
}

/** The item's similar albums or tracks, polled while a job is at work. */
export function useTidalSimilar(kind: TidalSimilarKind, id: string) {
  const { apiBaseUrl } = useConfig()
  return useQuery({
    queryKey: similarKey(kind, id),
    queryFn: ({ signal }) =>
      fetchApiData(apiBaseUrl, similarPath(kind, id), TidalSimilarSchema, {
        signal,
      }),
    refetchInterval: (query) =>
      anyActive(query.state.data) ? LASTFM_SYNC_POLL_MS : false,
  })
}

/** Matches the item on TIDAL, or reads it once matched, in the request. */
export function useRefreshTidalSimilar(kind: TidalSimilarKind, id: string) {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  return useMutation({
    retry: false,
    mutationFn: () =>
      fetchApiData(apiBaseUrl, similarPath(kind, id), TidalSimilarSchema, {
        method: 'POST',
      }),
    onSuccess: (similar) => client.setQueryData(similarKey(kind, id), similar),
  })
}

function suggestionTitle(item: TidalSimilarItem) {
  if (item.library) return item.library.title
  return item.version && !item.title.includes(item.version)
    ? `${item.title} (${item.version})`
    : item.title
}

/** A suggestion on Spotify only, as an item the player can start. */
export function spotifyPlayable(
  kind: TidalSimilarKind,
  item: TidalSimilarItem,
): PlayableItem | null {
  const spotify = item.spotify
  if (!spotify) return null
  return {
    kind,
    uri: `spotify:${kind}:${spotify.spotifyId}`,
    title: spotify.title,
    artist: spotify.artists.join(', '),
    albumId: null,
    albumTitle: kind === 'album' ? spotify.title : (spotify.albumName ?? ''),
    artworkUrl: spotify.artworkUrl,
    trackCount: kind === 'album' ? spotify.trackCount : 1,
    credits: spotify.artists.map((name) => ({ id: null, name })),
  }
}

function SpotifyPlayButton({ item }: { item: PlayableItem }) {
  const view = usePlayback()
  const controls = usePlaybackControls()
  if (!view.enabled)
    return (
      <PlayPair
        place="row"
        title={item.title}
        disabled
        disabledReason={unavailableReason(true, false)}
        onPlay={() => undefined}
        onQueue={() => undefined}
      />
    )
  const { snapshot } = view
  const current =
    item.kind === 'album'
      ? view.current?.uri === item.uri
      : snapshot !== null &&
        (snapshot.trackUri === item.uri || snapshot.linkedFromUri === item.uri)
  return (
    <PlayPair
      place="row"
      title={item.title}
      playing={current && snapshot !== null && !snapshot.paused}
      onPlay={() => playFromView(controls, view, item, current)}
      onQueue={() => controls.enqueue(item)}
    />
  )
}

/** The row's play pair; none where it cannot be played, keeping the slot. */
function suggestionPlay(
  kind: TidalSimilarKind,
  item: TidalSimilarItem,
  title: string,
) {
  const library = item.library
  if (item.state === 'library' && library)
    return kind === 'album' ? (
      <AlbumReferencePlayButton id={library.id} title={title} />
    ) : (
      <LibraryTrackPlayButton
        track={{
          id: library.id,
          spotifyTrackId: library.spotifyId,
          title,
          artists: item.artists,
          album: library.album,
          albumName: library.albumName,
          artworkUrl: library.artworkUrl,
        }}
      />
    )
  const playable = item.state === 'spotify' ? spotifyPlayable(kind, item) : null
  return playable ? <SpotifyPlayButton item={playable} /> : undefined
}

export function SimilarRow({
  kind,
  item,
}: {
  kind: TidalSimilarKind
  item: TidalSimilarItem
}) {
  const title = suggestionTitle(item)
  const library = item.state === 'library' ? item.library : null
  return (
    <SuggestionRow
      place={item.state}
      thumb={
        <MediaThumb
          kind={kind}
          src={item.library?.artworkUrl ?? item.spotify?.artworkUrl ?? null}
          size={40}
        />
      }
      title={
        library ? (
          <RowTitle>
            <DetailLink kind={kind} id={library.id} title={title}>
              {title}
            </DetailLink>
          </RowTitle>
        ) : (
          <span className="ds-row-title" title={title}>
            {title}
          </span>
        )
      }
      details={[
        item.artists.join(', '),
        kind === 'album'
          ? item.releaseDate?.slice(0, 4)
          : item.durationSec !== null
            ? formatTrackDuration(item.durationSec)
            : null,
      ]}
      play={suggestionPlay(kind, item, title)}
      open={
        library ? undefined : item.state === 'spotify' && item.spotify ? (
          <SuggestionLink href={item.spotify.url} service="Spotify" />
        ) : (
          <SuggestionLink href={item.url} service="TIDAL" />
        )
      }
    />
  )
}

function SimilarLoading({ label }: { label?: string }) {
  return (
    <div>
      {label && (
        <FilterLine>
          <Status state="running">{label}</Status>
        </FilterLine>
      )}
      <List compact>
        <SuggestionRowSkeleton />
        <SuggestionRowSkeleton />
        <SuggestionRowSkeleton />
      </List>
    </div>
  )
}

export function similarCounts(items: readonly TidalSimilarItem[]) {
  const count = (state: TidalSimilarItem['state']) =>
    items.filter((item) => item.state === state).length
  return `${formatCount(items.length)} from TIDAL · ${formatCount(count('library'))} in library · ${formatCount(count('spotify'))} on Spotify`
}

/**
 * Which TIDAL ID the list was read with (SONO-27), opening the job that
 * recorded it.
 */
function SimilarSource({ source }: { source: TidalSimilarSource }) {
  const label =
    source.kind === 'sonovault' ? 'TIDAL ID from Sonovault' : 'TIDAL match'
  return (
    <>
      {' · '}
      {source.jobId ? (
        <DetailLink kind="job" id={source.jobId} title="Open job">
          {label}
        </DetailLink>
      ) : (
        label
      )}
    </>
  )
}

/** The tab's content for one loaded `TidalSimilar`. */
export function SimilarBody({
  similar,
  requesting,
  requestFailed = false,
  onRequest,
}: {
  similar: TidalSimilar
  /** The match or read is running in a request. */
  requesting: boolean
  /** The request failed: an unread item stops showing Loading. */
  requestFailed?: boolean
  onRequest: () => void
}) {
  const { kind, matched, matchJob, job, lookupJob, readAt, source, items } =
    similar
  const noun = plural[kind]
  // A track's read also maps its similar tracks through Sonovault.
  const reading =
    kind === 'track' ? 'Reading from TIDAL and Sonovault' : 'Reading from TIDAL'
  if (isActiveSimilarJob(matchJob) || (requesting && !matched))
    return <SimilarLoading label="Matching on TIDAL" />
  if (
    isActiveSimilarJob(job) ||
    (requesting && !items.length) ||
    (matched && !job && !readAt && !requestFailed)
  )
    return <SimilarLoading label={reading} />
  const readAgain = (
    <Button size="xs" disabled={requesting} onClick={onRequest}>
      <RefreshCw className="ds-i" data-size="sm" aria-hidden />
      Read again
    </Button>
  )
  if (!matched)
    return (
      <State
        size="sm"
        title="Not matched on TIDAL"
        action={
          <Button size="xs" disabled={requesting} onClick={onRequest}>
            Match on TIDAL
          </Button>
        }
      >
        {matchJob?.status === 'failed' && matchJob.errorMessage
          ? matchJob.errorMessage
          : `Similar ${noun} come from TIDAL.`}
      </State>
    )
  if (!readAt)
    return (
      <State
        size="sm"
        title="Could not read from TIDAL"
        action={readAgain}
        error
      >
        {job?.errorMessage}
      </State>
    )
  if (!items.length)
    return (
      <State
        size="sm"
        title={`TIDAL has no similar ${noun}`}
        action={readAgain}
      >
        Read {formatDate(readAt)}
        {source && <SimilarSource source={source} />}
      </State>
    )
  return (
    <div>
      {job?.status === 'failed' && (
        <Notice tone="danger">
          The last read from TIDAL failed
          {job.errorMessage ? `: ${job.errorMessage}` : '.'}
        </Notice>
      )}
      <FilterLine>
        {requesting ? (
          <Status state="running">{reading}</Status>
        ) : isActiveSimilarJob(lookupJob) ? (
          <Status state="running">Finding on Spotify</Status>
        ) : (
          <ToolbarCount>
            {similarCounts(items)}
            {source && <SimilarSource source={source} />}
          </ToolbarCount>
        )}
        <Button
          size="xs"
          variant="ghost"
          icon
          aria-label="Read again from TIDAL"
          title={`Read again from TIDAL · updated ${formatDate(readAt)}`}
          disabled={requesting}
          onClick={onRequest}
        >
          <RefreshCw className="ds-i" data-size="sm" aria-hidden />
        </Button>
      </FilterLine>
      <List compact aria-label={`Similar ${noun}`}>
        {items.map((item) => (
          <SimilarRow key={item.tidalId} kind={kind} item={item} />
        ))}
      </List>
    </div>
  )
}

/**
 * The Similar tab of an album or track: TIDAL's similar items, played
 * through Spotify. A matched item that was never read is read once when the
 * tab opens, in that request, which also maps a track's suggestions through
 * Sonovault; the Spotify search of the rest is a job.
 */
export function SimilarItems({
  kind,
  id,
}: {
  kind: TidalSimilarKind
  id: string
}) {
  const similar = useTidalSimilar(kind, id)
  const refresh = useRefreshTidalSimilar(kind, id)
  const requested = useRef(false)
  const data = similar.data
  const unread = Boolean(data?.matched && !data.job && !data.readAt)
  const { mutate } = refresh
  useEffect(() => {
    if (!unread || requested.current) return
    requested.current = true
    mutate()
  }, [unread, mutate])
  if (!data) {
    if (similar.isError)
      return (
        <State
          size="sm"
          title={`Could not load similar ${plural[kind]}`}
          error
          action={
            <Button size="xs" onClick={() => similar.refetch()}>
              <RefreshCw className="ds-i" data-size="sm" aria-hidden />
              Retry
            </Button>
          }
        >
          The request failed.
        </State>
      )
    return <SimilarLoading />
  }
  return (
    <>
      <SimilarBody
        similar={data}
        requesting={refresh.isPending}
        requestFailed={refresh.isError}
        onRequest={() => refresh.mutate()}
      />
      {refresh.isError && (
        <Notice tone="danger">
          {errorMessage(refresh.error, 'Could not reach TIDAL.')}
        </Notice>
      )}
    </>
  )
}
