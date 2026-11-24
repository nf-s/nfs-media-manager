'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import {
  TidalSimilarAddResultSchema,
  TidalSimilarSchema,
  tidalSuggestionTitle,
  type TidalSimilar,
  type TidalSimilarItem,
  type TidalSimilarJob,
  type TidalSimilarKind,
  type TidalSimilarSource,
} from '@repo/schemas/tidal'
import { TrackDetailSchema, type TrackDetail } from '@repo/schemas/tracks'
import { Section } from '@repo/ui/components/ds/facts'
import { Notice, State } from '@repo/ui/components/ds/feedback'
import { LibraryAction } from '@repo/ui/components/ds/library-action'
import { List, RowTitle } from '@repo/ui/components/ds/list-row'
import { Pill, Pills } from '@repo/ui/components/ds/pill'
import { PlayPair } from '@repo/ui/components/ds/play'
import { Status } from '@repo/ui/components/ds/status'
import {
  SuggestionLink,
  SuggestionRow,
  SuggestionRowSkeleton,
} from '@repo/ui/components/ds/suggestion'
import { FilterLine, ToolbarCount } from '@repo/ui/components/ds/toolbar'
import { Button } from '@repo/ui/components/ui/button'
import { formatCount, formatDate, formatItemCount } from '@repo/ui/lib/format'
import { fetchApiData } from '@/utils/api'
import { LASTFM_SYNC_POLL_MS } from '@/utils/lastfm-sync'
import { invalidateManualMediaAddition } from '@/utils/manual-media-add'
import { libraryTrackPlayable, type PlayableItem } from '@/utils/playback'
import { trackAlbumReference } from '@/utils/track-album-notices'
import { trackServiceLinks } from '@/utils/track-links'
import { TrackDetailHeader } from './track-detail-header'
import { SpotifyAlbumReferenceLink } from './spotify-album-reference-link'
import { DetailLink } from './detail-link'
import { errorMessage } from './lastfm-sync'
import { MediaThumb } from './media-artwork'
import {
  AlbumReferencePlayButton,
  playFromView,
  unavailableReason,
} from './play-controls'
import { usePlayback, usePlaybackControls } from './playback-provider'
import { useAnnounceLibraryAddition, useConfig } from './providers'
import {
  TidalTrackMatchReviewDialog,
  useTidalTrackMatch,
  type TidalReviewTrack,
} from './tidal-track-match'
import { TrackBrowseAlbum } from './track-browse-cells'

const similarPath = (kind: TidalSimilarKind, id: string) =>
  `/api/v1/tidal/similar/${kind === 'album' ? 'albums' : 'tracks'}/${encodeURIComponent(id)}`
const similarKey = (kind: TidalSimilarKind, id: string) => [
  'tidal-similar',
  kind,
  id,
]
const plural = { album: 'albums', track: 'tracks' }
const libraryMatchLabels = {
  'tidal-id': 'TIDAL ID',
  isrc: 'ISRC',
  upc: 'UPC',
  'spotify-id': 'Spotify ID',
}
const TIDAL_TRACKS = { one: 'TIDAL track', other: 'TIDAL tracks' }

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
export function useTidalSimilar(
  kind: TidalSimilarKind,
  id: string,
  refreshing = false,
) {
  const { apiBaseUrl } = useConfig()
  return useQuery({
    queryKey: similarKey(kind, id),
    queryFn: ({ signal }) =>
      fetchApiData(apiBaseUrl, similarPath(kind, id), TidalSimilarSchema, {
        signal,
      }),
    refetchInterval: (query) =>
      refreshing || anyActive(query.state.data) ? LASTFM_SYNC_POLL_MS : false,
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
    onSuccess: async (similar) => {
      const queryKey = similarKey(kind, id)
      await client.cancelQueries({ queryKey, exact: true })
      client.setQueryData(queryKey, similar)
    },
  })
}

/** An album suggestion with a Spotify match, including one already saved locally. */
export function spotifyAlbumPlayable(
  item: TidalSimilarItem,
): PlayableItem | null {
  const spotify = item.spotify
  if (!spotify) return null
  const library = item.library
  return {
    kind: 'album',
    uri: `spotify:album:${spotify.spotifyId}`,
    title: spotify.title,
    artist: spotify.artists.join(', '),
    albumId: library?.id ?? null,
    albumTitle: spotify.title,
    artworkUrl: spotify.artworkUrl,
    trackCount: spotify.trackCount,
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
  const current = view.current?.uri === item.uri
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

/** The album suggestion's play pair, including a cached Spotify lookup. */
function suggestedAlbumPlay(item: TidalSimilarItem, title: string) {
  const library = item.library
  const playable = library?.spotifyId ? null : spotifyAlbumPlayable(item)
  if (playable) return <SpotifyPlayButton item={playable} />
  if (item.state === 'library' && library)
    return <AlbumReferencePlayButton id={library.id} title={title} />
  return undefined
}

function SimilarGenres({
  item,
  title,
}: {
  item: TidalSimilarItem
  title: string
}) {
  if (item.genres.length === 0) return null
  const genres = (
    <Pills wrap label={`Genres for ${title}`}>
      {item.genres.map((genre) => (
        <Pill key={genre}>{genre}</Pill>
      ))}
    </Pills>
  )
  if (item.genreEvidence) {
    return (
      <DetailLink
        kind="job"
        id={item.genreEvidence.jobId}
        tab="data"
        view={{ jobResponse: item.genreEvidence.responseId }}
      >
        {genres}
      </DetailLink>
    )
  }
  if (item.genreSource === 'artist' && item.genreArtist) {
    return (
      <DetailLink kind="artist" id={item.genreArtist.id}>
        {genres}
      </DetailLink>
    )
  }
  return genres
}

function SimilarTrack({
  item,
  title,
  detailId,
  libraryAction,
  matchEvidence,
}: {
  item: TidalSimilarItem
  title: string
  detailId: string | undefined
  libraryAction: ReactNode
  matchEvidence: ReactNode
}) {
  const { track: stored, library, spotify } = item
  const artistCredits = stored?.artistCredits ?? []
  const spotifyTrackId =
    stored?.spotifyTrackId ?? library?.spotifyId ?? spotify?.spotifyId ?? null
  const track = {
    ...(detailId ? { id: detailId } : {}),
    title,
    artists: artistCredits.length
      ? artistCredits.map(({ name }) => name)
      : item.artists,
    artistCredits,
    album: stored?.album ?? library?.album ?? null,
    albumName:
      stored?.albumName ??
      library?.albumName ??
      spotify?.albumName ??
      item.linkedAlbums?.[0]?.title ??
      null,
    artworkUrl:
      stored?.artworkUrl ?? library?.artworkUrl ?? spotify?.artworkUrl ?? null,
    spotifyTrackId,
    spotifyAlbumId: stored?.spotifyAlbumId ?? spotify?.spotifyAlbumId ?? null,
    spotifyUrl:
      stored?.spotifyUrl ??
      (spotifyTrackId === spotify?.spotifyId ? spotify.url : null) ??
      (spotifyTrackId
        ? `https://open.spotify.com/track/${spotifyTrackId}`
        : null),
    durationSec:
      stored?.durationSec ?? item.durationSec ?? spotify?.durationSec ?? null,
    releaseDate:
      stored?.releaseDate ??
      item.releaseDate ??
      item.linkedAlbums?.[0]?.releaseDate ??
      null,
  }
  const reference =
    stored?.albumLinkStrategy !== undefined && stored.spotifyMatch !== undefined
      ? trackAlbumReference({
          ...stored,
          albumLinkStrategy: stored.albumLinkStrategy,
          spotifyMatch: stored.spotifyMatch,
        })
      : null
  const albumName =
    reference?.album?.title ??
    track.albumName ??
    track.album?.title ??
    (reference?.openBySpotify ? 'Album' : null)
  const unavailable = libraryTrackPlayable(track) === null
  return (
    <Section>
      <div className="dtl-stack">
        <TrackDetailHeader
          track={track}
          detailId={detailId}
          album={
            albumName &&
            (reference?.openBySpotify && detailId ? (
              <SpotifyAlbumReferenceLink
                trackId={detailId}
                spotifyAlbumId={reference.exactId}
              >
                {albumName}
              </SpotifyAlbumReferenceLink>
            ) : (
              <TrackBrowseAlbum track={{ album: track.album, albumName }} />
            ))
          }
          links={[
            ...trackServiceLinks(track, stored?.lastfmSource),
            { provider: 'tidal', label: 'TIDAL', url: item.url },
          ]}
          actions={libraryAction}
        />
        {(matchEvidence || unavailable || item.genres.length > 0) && (
          <div className="dtl-filters">
            {matchEvidence}
            {unavailable && <span>Unavailable</span>}
            <SimilarGenres item={item} title={title} />
          </div>
        )}
      </div>
    </Section>
  )
}

export function SimilarRow({
  kind,
  itemId,
  item,
  awaitingSave = false,
}: {
  kind: TidalSimilarKind
  itemId: string
  item: TidalSimilarItem
  awaitingSave?: boolean
}) {
  const client = useQueryClient()
  const { apiBaseUrl } = useConfig()
  const announceAddition = useAnnounceLibraryAddition()
  const title =
    item.track?.title ?? item.library?.title ?? tidalSuggestionTitle(item)
  const add = useMutation({
    retry: false,
    mutationFn: () =>
      fetchApiData(
        apiBaseUrl,
        `${similarPath(kind, itemId)}/${encodeURIComponent(item.tidalId)}/library`,
        TidalSimilarAddResultSchema,
        { method: 'POST' },
      ),
    onSuccess: () => {
      announceAddition(kind, title)
      void invalidateManualMediaAddition(client, kind)
    },
  })
  const detailId =
    add.data?.id ??
    item.track?.id ??
    item.library?.id ??
    item.catalogMediaItemId
  const inLibrary = Boolean(add.data || item.track?.inLibrary || item.library)
  const place = inLibrary
    ? 'library'
    : item.state === 'library'
      ? item.spotify
        ? 'spotify'
        : 'unsearched'
      : item.state
  const match = item.libraryMatch
  const matchEvidence =
    item.library && match ? (
      <DetailLink
        kind={kind}
        id={item.library.id}
        tab="sources"
        title={`Matched by ${libraryMatchLabels[match.basis]} ${match.value}`}
      >
        {kind === 'track' ? 'Library match' : 'In library'}
      </DetailLink>
    ) : null
  const libraryAction = (
    <LibraryAction
      kind={kind}
      name={title}
      saved={inLibrary || item.hiddenLibraryMatch}
      pending={add.isPending}
      disabled={awaitingSave}
      onAdd={() => add.mutate()}
    />
  )
  return (
    <>
      {kind === 'track' ? (
        <SimilarTrack
          item={item}
          title={title}
          detailId={detailId}
          libraryAction={libraryAction}
          matchEvidence={matchEvidence}
        />
      ) : (
        <SuggestionRow
          place={place}
          thumb={
            <MediaThumb
              kind={kind}
              src={item.library?.artworkUrl ?? item.spotify?.artworkUrl ?? null}
              size={40}
            />
          }
          title={
            detailId ? (
              <RowTitle>
                <DetailLink kind={kind} id={detailId} title={title}>
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
            detailId && !inLibrary ? 'Outside library' : null,
            item.artists.join(', '),
            item.releaseDate?.slice(0, 4),
          ]}
          placeEvidence={matchEvidence}
          badges={<SimilarGenres item={item} title={title} />}
          play={suggestedAlbumPlay(item, title)}
          actions={
            <span className="ds-actions">
              {!inLibrary &&
                (place === 'spotify' && item.spotify ? (
                  <SuggestionLink
                    href={item.spotify.url}
                    service="Spotify"
                    itemTitle={title}
                  />
                ) : (
                  <SuggestionLink
                    href={item.url}
                    service="TIDAL"
                    itemTitle={title}
                  />
                ))}
              {libraryAction}
            </span>
          }
        />
      )}
      {add.isError && (
        <Notice tone="danger">
          {errorMessage(add.error, `Could not add ${title} to the library.`)}
        </Notice>
      )}
    </>
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

/** Why the item is not matched on TIDAL, with what can be done about it. */
function UnmatchedState({
  similar,
  requesting,
  onRequest,
  onReview,
}: {
  similar: TidalSimilar
  requesting: boolean
  onRequest: () => void
  onReview?: () => void
}) {
  const { kind, matchJob, unmatched } = similar
  const match = (
    <Button size="xs" disabled={requesting} onClick={onRequest}>
      Match on TIDAL
    </Button>
  )
  if (unmatched?.reason === 'review')
    return (
      <State
        size="sm"
        title={`${formatItemCount(unmatched.candidateCount, TIDAL_TRACKS)} to review`}
        action={
          <Button
            size="xs"
            aria-haspopup="dialog"
            disabled={!onReview}
            onClick={onReview}
          >
            Review
          </Button>
        }
      >
        Choose one to read similar tracks.
      </State>
    )
  if (unmatched?.reason === 'no-isrc')
    return (
      <State size="sm" title="No ISRC">
        TIDAL matches tracks by ISRC.
      </State>
    )
  if (unmatched?.reason === 'not-found')
    return (
      <State size="sm" title="Not on TIDAL" action={match}>
        TIDAL has no track with ISRC {unmatched.isrc}
        {matchJob && (
          <>
            {' · '}
            <DetailLink kind="job" id={matchJob.jobId} title="Open job">
              Match job
            </DetailLink>
          </>
        )}
      </State>
    )
  return (
    <State size="sm" title="Not matched on TIDAL" action={match}>
      {matchJob?.status === 'failed' && matchJob.errorMessage
        ? matchJob.errorMessage
        : `Similar ${plural[kind]} come from TIDAL.`}
    </State>
  )
}

/** The tab's content for one loaded `TidalSimilar`. */
export function SimilarBody({
  similar,
  requesting,
  requestFailed = false,
  onRequest,
  onReview,
}: {
  similar: TidalSimilar
  /** The match or read is running in a request. */
  requesting: boolean
  /** The request failed: an unread item stops showing Loading. */
  requestFailed?: boolean
  onRequest: () => void
  /** Opens the review of the TIDAL tracks a match left; none until it can. */
  onReview?: () => void
}) {
  const { kind, matched, matchJob, job, lookupJob, readAt, source, items } =
    similar
  const noun = plural[kind]
  // A track's read also maps its similar tracks through Sonovault.
  const reading =
    kind === 'track' ? 'Reading from TIDAL and Sonovault' : 'Reading from TIDAL'
  if (isActiveSimilarJob(matchJob) || (requesting && !matched))
    return <SimilarLoading label="Matching on TIDAL" />
  const readingList = requesting || isActiveSimilarJob(job)
  if (
    !items.length &&
    (readingList || (matched && !job && !readAt && !requestFailed))
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
      <UnmatchedState
        similar={similar}
        requesting={requesting}
        onRequest={onRequest}
        {...(onReview ? { onReview } : {})}
      />
    )
  if (!readAt && !items.length)
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
          {readAt
            ? `The last read from TIDAL failed${job.errorMessage ? `: ${job.errorMessage}` : '.'}`
            : 'TIDAL returned these tracks, but the library update failed. Read again to retry.'}
        </Notice>
      )}
      <FilterLine>
        {readingList ? (
          <Status state="running">
            {readAt
              ? reading
              : 'Received from TIDAL · updating library matches'}
          </Status>
        ) : isActiveSimilarJob(lookupJob) ? (
          <Status state="running">Finding on Spotify</Status>
        ) : (
          <ToolbarCount>
            {kind === 'track'
              ? `${formatCount(items.length)} from TIDAL`
              : similarCounts(items)}
            {source && <SimilarSource source={source} />}
          </ToolbarCount>
        )}
        <Button
          size="xs"
          variant="ghost"
          icon
          aria-label="Read again from TIDAL"
          title={
            readAt
              ? `Read again from TIDAL · updated ${formatDate(readAt)}`
              : 'Read again from TIDAL'
          }
          disabled={readingList}
          onClick={onRequest}
        >
          <RefreshCw className="ds-i" data-size="sm" aria-hidden />
        </Button>
      </FilterLine>
      <List compact={kind === 'album'} aria-label={`Similar ${noun}`}>
        {items.map((item) => (
          <SimilarRow
            key={item.tidalId}
            kind={kind}
            itemId={similar.itemId}
            item={item}
            awaitingSave={!readAt}
          />
        ))}
      </List>
    </div>
  )
}

/** The track as the TIDAL review shows it, from its cached detail. */
function useReviewTrack(id: string, enabled: boolean) {
  const { apiBaseUrl } = useConfig()
  const detail = useQuery({
    queryKey: ['track', id],
    enabled,
    queryFn: () =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/tracks/${encodeURIComponent(id)}`,
        TrackDetailSchema,
      ),
  })
  return detail.data ? reviewTrack(detail.data) : null
}

function reviewTrack(item: TrackDetail): TidalReviewTrack {
  return { ...item, isrc: item.isrc ?? item.isrcs[0]?.isrc ?? null }
}

/**
 * The Similar tab of an album or track: TIDAL's similar items, played
 * through Spotify. A matched item that was never read is read once when the
 * tab opens, in that request, which also maps a track's suggestions through
 * Sonovault; the Spotify search of the rest is a job. A track whose match
 * left TIDAL tracks for review opens that review here, and is read once the
 * owner has chosen one.
 */
export function SimilarItems({
  kind,
  id,
}: {
  kind: TidalSimilarKind
  id: string
}) {
  const client = useQueryClient()
  const refresh = useRefreshTidalSimilar(kind, id)
  const similar = useTidalSimilar(kind, id, refresh.isPending)
  const requested = useRef(false)
  const data = similar.data
  const unread = Boolean(data?.matched && !data.job && !data.readAt)
  const { mutate } = refresh
  useEffect(() => {
    if (!unread || requested.current) return
    requested.current = true
    mutate()
  }, [unread, mutate])
  const [reviewing, setReviewing] = useState(false)
  const track = useReviewTrack(
    id,
    kind === 'track' && data?.unmatched?.reason === 'review',
  )
  // The dialog's choice matches the track: load the tab again to read it.
  const chosen =
    useTidalTrackMatch(id, kind === 'track' && reviewing).data?.match
      ?.tidalTrackId ?? null
  useEffect(() => {
    if (chosen)
      void client.invalidateQueries({ queryKey: similarKey(kind, id) })
  }, [chosen, client, kind, id])
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
        {...(track ? { onReview: () => setReviewing(true) } : {})}
      />
      {refresh.isError && (
        <Notice tone="danger">
          {errorMessage(refresh.error, 'Could not reach TIDAL.')}
        </Notice>
      )}
      {reviewing && track && (
        <TidalTrackMatchReviewDialog
          track={track}
          onClose={() => setReviewing(false)}
        />
      )}
    </>
  )
}
