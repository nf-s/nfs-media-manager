'use client'

import Link from 'next/link'
import {
  Fragment,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type DragEvent,
  type ReactNode,
} from 'react'
import { useMutation } from '@tanstack/react-query'
import {
  Check,
  ChevronDown,
  ChevronUp,
  CornerUpLeft,
  GripVertical,
  Laptop,
  ListMusic,
  ListPlus,
  LoaderCircle,
  MonitorSpeaker,
  Pause,
  Play,
  Shuffle,
  SkipBack,
  SkipForward,
  Smartphone,
  Speaker,
  Tv,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react'
import {
  Button,
  ButtonFeedbackLabel,
  type ButtonFeedback,
} from '@repo/ui/components/ui/button'
import { DetailLink } from './detail-link'
import { SpotifyAlbumReferenceLink } from './spotify-album-reference-link'
import { MediaInspector } from './media-inspector'
import { ItemMore } from './item-more'
import { ResultLineSlot } from './result-line'
import ServiceIconLinks from './service-icon-links'
import MediaArtwork from './media-artwork'
import {
  PlayerLibraryAction,
  PlayerLibraryActions,
  observedPlaybackItem,
  playerItemIdentity,
  usePlayerLibraryMembership,
  type PlayerLibraryMembership,
} from './player-library-actions'
import {
  ConnectionOutcome,
  connectionFeedback,
  ConnectPrompt,
  PlayerConnections,
  SonosMark,
  SonosRooms,
} from './player-connections'
import { useConfig } from './providers'
import {
  usePlayback,
  usePlaybackControls,
  type PlaybackView,
} from './playback-provider'
import {
  playButtonRequest,
  queueButtonRequest,
  usePlaybackCommand,
} from './playback-button-feedback'
import {
  formatClock,
  playbackReportsTrack,
  positionAt,
  queueSummary,
  spotifyWebUrl,
  type PlayableItem,
  type PlaybackSnapshot,
  type QueueEntry,
} from '@/utils/playback'
import {
  playingLibraryItems,
  queuedLibraryItem,
  type PlaybackLibraryItem,
} from '@/utils/playback-library'
import {
  currentPlaybackCatalog,
  playbackSpotifyId,
  queuedPlaybackCatalog,
} from '@/utils/playback-catalog'
import type { DetailTarget } from '@/utils/detail-inspector'
import {
  sameDevice,
  type PlaybackState,
  type PlaybackRejoin,
  type PlaybackTarget,
  type SelectableTarget,
} from '@/utils/playback-engine'
import { spotifyAuthorizationUrl } from '@/utils/spotify-authorize'
import { browseFilterHref } from '@/utils/browse-items'
import { workspaceTabLinkProps } from '@/utils/workspace-tab-destination'

const phoneQuery = '(max-width: 700px)'

function subscribePhone(notify: () => void) {
  const media = window.matchMedia(phoneQuery)
  media.addEventListener('change', notify)
  return () => media.removeEventListener('change', notify)
}

/** Whether the shell is in its phone layout, where the player is a mini-player. */
function usePhoneLayout() {
  return useSyncExternalStore(
    subscribePhone,
    () => window.matchMedia(phoneQuery).matches,
    () => false,
  )
}

function usePosition(snapshot: PlaybackSnapshot | null) {
  const [now, setNow] = useState(() => Date.now())
  const moving = snapshot !== null && !snapshot.paused
  useEffect(() => {
    if (!moving) return
    const timer = window.setInterval(() => setNow(Date.now()), 500)
    return () => window.clearInterval(timer)
  }, [moving])
  return snapshot ? positionAt(snapshot, Math.max(now, snapshot.at)) : 0
}

function percent(value: number, total: number) {
  return `${total > 0 ? Math.min(100, (value / total) * 100) : 0}%`
}

function describe(view: PlaybackView) {
  const { snapshot, current } = view
  return {
    title: snapshot?.trackName ?? current?.title ?? 'Nothing playing',
    detail: snapshot
      ? [snapshot.artists, snapshot.albumName].filter(Boolean).join(' · ')
      : (current?.artist ?? ''),
    artwork: snapshot?.artworkUrl ?? current?.artworkUrl ?? null,
    spotifyUrl: spotifyWebUrl(snapshot?.trackUri ?? current?.uri ?? null),
  }
}

/** Something the player names: its library page when there is one, else its Spotify page. */
type Reference = {
  label: string
  detail: DetailTarget | null
  url: string | null
  albumReference?: {
    trackId: string
    spotifyAlbumId?: string
    catalogId?: string
  }
}

type PlayingIdentity = {
  items: ReturnType<typeof playingLibraryItems>
  links: ReturnType<typeof references>
  membership: PlayerLibraryMembership
}

/** Where the playing track, its artists and its album lead. */
function references(
  view: PlaybackView,
  playing: ReturnType<typeof playingLibraryItems>,
  membership: PlayerLibraryMembership,
) {
  const { snapshot, current } = view
  const credits =
    !snapshot ||
    (current && playbackReportsTrack(snapshot, current.uri)) ||
    current?.uri === snapshot.albumUri
      ? (current?.credits ?? [])
      : []
  const album = libraryReference(playing.album, membership)
  const track = libraryReference(playing.track, membership)
  const exactTrack =
    playing.track && observedPlaybackItem(playing.track, membership.references)
  const exactAlbum =
    playing.album && observedPlaybackItem(playing.album, membership.references)
  const spotifyAlbumId = playbackSpotifyId('album', playing.album?.uri)
  const trackId = track.detail?.id
  const fromCurrentTrack =
    current?.kind === 'track' &&
    current.trackId === trackId &&
    current.uri === playing.track?.uri &&
    Boolean(playbackSpotifyId('track', current.uri))
  const fromObservation =
    exactTrack?.item.id === trackId &&
    exactTrack?.album?.id === album.detail?.id &&
    Boolean(spotifyAlbumId)
  if (playing.album && trackId && (fromObservation || fromCurrentTrack)) {
    album.albumReference = {
      trackId,
      spotifyAlbumId,
      catalogId:
        fromObservation && exactTrack?.album?.inLibrary
          ? exactTrack.album.id
          : undefined,
    }
  }
  const known = exactTrack?.artists ?? exactAlbum?.artists ?? credits
  const plain = snapshot?.artists ?? current?.artist ?? ''
  const artists = snapshot?.artistLinks.length
    ? snapshot.artistLinks.map(({ name, uri }) => {
        const spotifyId = playbackSpotifyId('artist', uri)
        const matches = spotifyId
          ? (exactTrack?.artists ?? []).filter(
              (credit) => credit.spotifyId === spotifyId,
            )
          : known.filter((credit) => credit.name === name)
        return { name, id: matches.length === 1 ? matches[0]?.id : null }
      })
    : known.length &&
        (!snapshot || known.map(({ name }) => name).join(', ') === plain)
      ? known
      : []
  return { track, artists, album, artistLabel: plain }
}

function libraryReference(
  item: PlaybackLibraryItem | null,
  membership: PlayerLibraryMembership,
): Reference {
  if (!item) return { label: '', detail: null, url: null }
  const { mediaItemId } = playerItemIdentity(item, membership)
  return {
    label: item.title,
    detail: mediaItemId ? { kind: item.kind, id: mediaItemId } : null,
    url: spotifyWebUrl(item.uri),
  }
}

function PlayerLink({
  to,
  onNavigate,
  children,
}: {
  to: Reference
  onNavigate?: () => void
  /** Artwork shown in place of the label. */
  children?: ReactNode
}) {
  const label = children ? `Open ${to.label}` : undefined
  if (to.albumReference)
    return (
      <SpotifyAlbumReferenceLink {...to.albumReference} onNavigate={onNavigate}>
        {children ?? to.label}
      </SpotifyAlbumReferenceLink>
    )
  if (to.detail)
    return (
      <DetailLink
        {...to.detail}
        title={`Open ${to.label}`}
        aria-label={label}
        onClick={onNavigate}
      >
        {children ?? to.label}
      </DetailLink>
    )
  if (to.url)
    return (
      <a
        href={to.url}
        target="_blank"
        rel="noopener noreferrer"
        title={`Open ${to.label} in Spotify (opens in a new tab)`}
        aria-label={label ? `${label} in Spotify` : undefined}
      >
        {children ?? to.label}
      </a>
    )
  return <>{children ?? to.label}</>
}

function PlayerArtists({
  artists,
  fallback,
  onNavigate,
}: {
  artists: readonly { name: string; id?: string | null }[]
  fallback: string
  onNavigate?: () => void
}) {
  const entries = artists.length
    ? artists
    : fallback
      ? [{ name: fallback, id: null }]
      : []
  return entries.map(({ name, id }, index) => {
    const href = browseFilterHref('/artists?libraryScope=all', [
      { field: 'name', value: name, mode: 'required' },
    ])
    return (
      <Fragment key={`${id ?? name}:${index}`}>
        {index > 0 && ', '}
        {id ? (
          <DetailLink
            kind="artist"
            id={id}
            title={`Open ${name}`}
            onClick={onNavigate}
          >
            {name}
          </DetailLink>
        ) : (
          <Link
            {...workspaceTabLinkProps(href, name)}
            href={href}
            title={`Find ${name} in Artists`}
            prefetch={false}
            onClick={onNavigate}
          >
            {name}
          </Link>
        )}
      </Fragment>
    )
  })
}

/** The playing track, its artists and its album, each linked. */
function NowPlaying({
  shown,
  playing,
  membership,
  onNavigate,
  touch,
  inQueue = false,
}: {
  shown: ReturnType<typeof references>
  playing: ReturnType<typeof playingLibraryItems>
  membership: PlayerLibraryMembership
  onNavigate?: () => void
  touch?: boolean
  inQueue?: boolean
}) {
  const { track, artists, album, artistLabel } = shown
  const title = playing.track ? track : album
  const titleItem = playing.track ?? playing.album
  const release = playing.track ? playing.album : null
  const hasArtists = artists.length > 0 || Boolean(artistLabel)
  const LibraryControl = inQueue ? QueueLibrarySlot : PlayerLibraryAction
  // More is for a library track: one the player finds saved in the library.
  const libraryTrackId =
    !inQueue &&
    playing.track &&
    track.detail?.kind === 'track' &&
    !playerItemIdentity(playing.track, membership).add
      ? track.detail.id
      : null
  return (
    <span className="player-text">
      <span className="player-identity-line">
        <strong title={inQueue ? title.label : undefined}>
          <PlayerLink
            to={title.label ? title : { ...title, label: 'Nothing playing' }}
            onNavigate={onNavigate}
          />
        </strong>
        {titleItem && (
          <LibraryControl
            item={titleItem}
            membership={membership}
            touch={touch}
          />
        )}
        {libraryTrackId && (
          <ItemMore
            library="tracks"
            item={{ id: libraryTrackId, title: track.label }}
            variant="ghost"
          />
        )}
      </span>
      {(hasArtists || release) && (
        <span className="player-identity-line">
          <span>
            <PlayerArtists
              artists={artists}
              fallback={artistLabel}
              onNavigate={onNavigate}
            />
            {hasArtists && release && ' · '}
            {release && <PlayerLink to={album} onNavigate={onNavigate} />}
          </span>
          {release && (
            <LibraryControl
              item={release}
              membership={membership}
              touch={touch}
            />
          )}
        </span>
      )}
    </span>
  )
}

function targetLabel(target: PlaybackTarget) {
  if (target.kind === 'local') return 'This browser'
  if (target.kind === 'room') return target.room.name
  return target.kind === 'remote' ? target.device.name : target.name
}

/** Seeking is refused on restricted devices and on Sonos playback that disallows it. */
function seekable(target: PlaybackTarget) {
  if (target.kind === 'sonos') return target.group.actions.seek
  return target.kind !== 'restricted'
}

function DeviceIcon({ type }: { type: string }) {
  const Icon =
    type === 'computer'
      ? Laptop
      : type === 'smartphone' || type === 'tablet'
        ? Smartphone
        : type === 'speaker' || type === 'avr' || type === 'stb'
          ? Speaker
          : type === 'tv'
            ? Tv
            : MonitorSpeaker
  return <Icon size={16} aria-hidden="true" />
}

function Artwork({
  src,
  className,
}: {
  src: string | null
  className: string
}) {
  return (
    <MediaArtwork
      src={src}
      alt=""
      fallbackLabel=""
      containerClassName={className}
      imageClassName="player-art-image"
      fallbackClassName="player-art-image"
    />
  )
}

function Hairline({ snapshot }: { snapshot: PlaybackSnapshot | null }) {
  const position = usePosition(snapshot)
  return (
    <div className="player-hairline" aria-hidden="true">
      <span style={{ width: percent(position, snapshot?.durationMs ?? 0) }} />
    </div>
  )
}

function Scrubber({
  snapshot,
  readOnly,
}: {
  snapshot: PlaybackSnapshot | null
  readOnly: boolean
}) {
  const { seek } = usePlaybackControls()
  const action = usePlaybackCommand('transport:seek')
  const position = usePosition(snapshot)
  const [drag, setDrag] = useState<number | null>(null)
  const duration = snapshot?.durationMs ?? 0
  const shown = Math.min(drag ?? position, duration)
  const end = formatClock(duration)
  function commit() {
    if (drag === null) return
    const position = drag
    action.run(
      {
        pending: 'Seeking…',
        lane: 'seek',
        repeated: true,
        observe(next, previous) {
          const snapshot = next.observation?.snapshot
          if (
            snapshot &&
            next.observation !== previous.observation &&
            Math.abs(snapshot.positionMs - position) < 2500
          )
            return {
              phase: 'done',
              label: `At ${formatClock(snapshot.positionMs)}`,
            }
          return undefined
        },
      },
      () => seek(position),
    )
    setDrag(null)
  }
  return (
    <div className="player-scrub">
      <span className="player-time player-time-elapsed">
        <span aria-hidden="true">{end}</span>
        <span>{formatClock(shown)}</span>
      </span>
      <div className="player-range">
        <span
          className="player-range-fill"
          style={{ width: percent(shown, duration) }}
        />
        <input
          type="range"
          aria-label="Seek"
          aria-valuetext={`${formatClock(shown)} of ${end}`}
          min={0}
          max={Math.max(duration, 1)}
          step={1000}
          value={shown}
          disabled={duration === 0 || readOnly}
          onChange={(event) => setDrag(Number(event.target.value))}
          onPointerUp={commit}
          onKeyUp={commit}
          onBlur={commit}
        />
      </div>
      <span className="player-time">{end}</span>
      <PlayerControlReceipt feedback={action.feedback} />
    </div>
  )
}

function PlayerControlReceipt({ feedback }: { feedback?: ButtonFeedback }) {
  return (
    <span className="sr-only" role="status">
      {feedback?.label}
    </span>
  )
}

function Transport({
  view,
  showFeedback = true,
}: {
  view: PlaybackView
  showFeedback?: boolean
}) {
  const controls = usePlaybackControls()
  const shuffle = usePlaybackCommand('transport:shuffle')
  const previous = usePlaybackCommand('transport:previous')
  const toggle = usePlaybackCommand('transport:toggle')
  const next = usePlaybackCommand('transport:next')
  const { snapshot, starting } = view
  const playing = snapshot !== null && !snapshot.paused
  const hasNext = view.queue.length > 0 || view.upcoming.length > 0
  const nothingToPlay = !snapshot && !view.current && !hasNext
  // Spotify does not let apps control a restricted device.
  const readOnly = view.target.kind === 'restricted'
  // A Sonos group accepts the controls Sonos reports for its current playback.
  const sonos = view.target.kind === 'sonos' ? view.target.group.actions : null
  // Sonos can start the track due on the group when its own tracks run out.
  const startsNext =
    view.target.kind === 'sonos' && view.target.group.playable && hasNext
  function skip(action: typeof next, direction: 'previous' | 'next') {
    action.run(
      {
        pending: direction === 'next' ? 'Skipping…' : 'Going back…',
        lane: 'transport',
        repeated: true,
        observe(after, before) {
          const report = after.observation?.snapshot
          if (
            !report ||
            after.observation === before.observation ||
            after.starting
          )
            return undefined
          if (report.trackUri !== before.snapshot?.trackUri)
            return {
              phase: 'done',
              label: direction === 'next' ? 'Skipped' : 'Previous track',
            }
          if (
            direction === 'previous' &&
            report.positionMs < 2500 &&
            (before.snapshot?.positionMs ?? 0) > 2500
          )
            return { phase: 'done', label: 'Track restarted' }
          return undefined
        },
      },
      controls[direction],
    )
  }
  function togglePlayback() {
    const item = view.current ?? view.queue[0]?.item ?? view.upcoming[0]?.item
    toggle.run(
      item
        ? playButtonRequest(item, playing)
        : {
            pending: playing ? 'Pausing…' : 'Starting…',
            lane: 'transport',
            observe(after, before) {
              if (
                !after.starting &&
                after.observation !== before.observation &&
                after.observation?.snapshot.paused === playing
              )
                return { phase: 'done', label: playing ? 'Paused' : 'Playing' }
              return undefined
            },
          },
      controls.toggle,
    )
  }
  return (
    <div className="player-buttons">
      <Button
        type="button"
        icon
        variant="ghost"
        className="player-skip"
        aria-label="Shuffle"
        aria-pressed={view.shuffle}
        title="Shuffle"
        feedback={shuffle.feedback}
        onClick={() =>
          shuffle.run(
            queueButtonRequest(
              (after, before) => after.shuffle !== before.shuffle,
              view.shuffle ? 'Shuffle off' : 'Shuffle on',
            ),
            controls.toggleShuffle,
          )
        }
      >
        <Shuffle size={16} aria-hidden="true" />
      </Button>
      <Button
        type="button"
        icon
        variant="ghost"
        className="player-skip"
        aria-label="Previous"
        disabled={
          !snapshot ||
          readOnly ||
          (sonos !== null && !sonos.previous && !sonos.seek)
        }
        feedback={previous.feedback}
        onClick={() => skip(previous, 'previous')}
      >
        <SkipBack size={16} aria-hidden="true" />
      </Button>
      <Button
        type="button"
        icon
        className="player-toggle"
        aria-label={starting ? 'Starting' : playing ? 'Pause' : 'Play'}
        disabled={
          starting ||
          nothingToPlay ||
          readOnly ||
          (sonos !== null && !(playing ? sonos.pause : sonos.play))
        }
        aria-busy={starting || undefined}
        feedback={showFeedback ? toggle.feedback : undefined}
        onClick={togglePlayback}
      >
        {starting ? (
          <LoaderCircle
            size={16}
            aria-hidden="true"
            className="motion-safe:animate-spin"
          />
        ) : playing ? (
          <Pause size={16} aria-hidden="true" />
        ) : (
          <Play size={16} aria-hidden="true" />
        )}
      </Button>
      <Button
        type="button"
        icon
        variant="ghost"
        className="player-skip"
        aria-label="Next"
        disabled={
          sonos
            ? !snapshot || (!sonos.next && !startsNext)
            : readOnly || (!snapshot && !hasNext)
        }
        feedback={next.feedback}
        onClick={() => skip(next, 'next')}
      >
        <SkipForward size={16} aria-hidden="true" />
      </Button>
    </div>
  )
}

function VolumeControl({ volume }: { volume: number | null }) {
  const { setVolume } = usePlaybackControls()
  const mute = usePlaybackCommand('transport:mute')
  const slider = usePlaybackCommand('transport:volume')
  const restore = useRef(0.5)
  if (volume === null) return null
  const muted = volume === 0
  function change(value: number, action: typeof mute) {
    action.run(
      {
        pending: 'Setting volume…',
        lane: 'volume',
        repeated: true,
        observe(after, before) {
          if (
            after.volumeReceipt !== before.volumeReceipt &&
            after.volumeReceipt?.volume === value
          )
            return {
              phase: 'done',
              label:
                value === 0 ? 'Muted' : `Volume ${Math.round(value * 100)}%`,
            }
          return undefined
        },
      },
      () => setVolume(value),
    )
  }
  return (
    <div className="player-volume">
      <Button
        type="button"
        icon
        variant="ghost"
        className="player-tool"
        aria-label={muted ? 'Unmute' : 'Mute'}
        feedback={mute.feedback}
        onClick={() => {
          if (muted) return change(restore.current, mute)
          restore.current = volume
          change(0, mute)
        }}
      >
        {muted ? (
          <VolumeX size={16} aria-hidden="true" />
        ) : (
          <Volume2 size={16} aria-hidden="true" />
        )}
      </Button>
      <div className="player-range">
        <span
          className="player-range-fill"
          style={{ width: percent(volume, 1) }}
        />
        <input
          type="range"
          aria-label="Volume"
          aria-valuetext={`${Math.round(volume * 100)}%`}
          min={0}
          max={1}
          step={0.01}
          value={volume}
          onChange={(event) => change(Number(event.target.value), slider)}
        />
      </div>
      <PlayerControlReceipt feedback={slider.feedback} />
    </div>
  )
}

function ItemText({
  item,
  library,
  membership,
  onNavigate,
}: {
  item: PlayableItem
  library: PlaybackLibraryItem
  membership: PlayerLibraryMembership
  onNavigate: () => void
}) {
  const known = observedPlaybackItem(library, membership.references)
  const artists = known?.artists.length ? known.artists : (item.credits ?? [])
  const hasArtists = artists.length > 0 || Boolean(item.artist)
  const albumTitle = item.kind === 'track' ? item.albumTitle : ''
  const trackCount = item.kind === 'album' ? item.trackCount : null
  const albumId = known?.album?.id ?? item.albumId
  const trackId = playerItemIdentity(library, membership).mediaItemId
  const spotifyAlbumId = playbackSpotifyId('album', item.albumUri)
  const fromObservation =
    known?.item.id === trackId && Boolean(known?.album && spotifyAlbumId)
  const fromQueueTrack =
    item.kind === 'track' &&
    item.trackId === trackId &&
    Boolean(playbackSpotifyId('track', item.uri))
  return (
    <span className="player-text">
      <strong title={item.title}>
        <PlayerLink
          to={libraryReference(library, membership)}
          onNavigate={onNavigate}
        />
      </strong>
      {(hasArtists || albumTitle || trackCount !== null) && (
        <span>
          <PlayerArtists
            artists={artists}
            fallback={item.artist}
            onNavigate={onNavigate}
          />
          {hasArtists && (albumTitle || trackCount !== null) && ' · '}
          {albumTitle && (
            <PlayerLink
              to={{
                label: albumTitle,
                detail: albumId ? { kind: 'album', id: albumId } : null,
                url: spotifyWebUrl(item.albumUri ?? null),
                ...(trackId && (fromObservation || fromQueueTrack)
                  ? {
                      albumReference: {
                        trackId,
                        spotifyAlbumId,
                        catalogId:
                          fromObservation && known?.album?.inLibrary
                            ? known.album.id
                            : undefined,
                      },
                    }
                  : {}),
              }}
              onNavigate={onNavigate}
            />
          )}
          {trackCount !== null &&
            `${trackCount} ${trackCount === 1 ? 'track' : 'tracks'}`}
        </span>
      )}
    </span>
  )
}

function focusQueueTitleOnRemoval(action: HTMLSpanElement | null) {
  if (!action) return
  return () => {
    if (!action.contains(document.activeElement)) return
    action
      .closest('.queue-row')
      ?.querySelector<HTMLElement>('.player-text strong a')
      ?.focus({ preventScroll: true })
  }
}

function QueueLibrarySlot({
  item,
  membership,
  touch,
}: {
  item: PlaybackLibraryItem
  membership: PlayerLibraryMembership
  touch?: boolean
}) {
  return (
    <span className="queue-library-slot" data-touch={touch ? '' : undefined}>
      <span ref={focusQueueTitleOnRemoval}>
        <PlayerLibraryAction
          item={item}
          membership={membership}
          touch={touch}
        />
      </span>
    </span>
  )
}

/** The two lists of the queue panel that hold tracks still to play. */
type QueueSection = 'queue' | 'upcoming'
type QueueActionOrigin = {
  section: QueueSection
  key: string
  button: 'play' | 'remove' | 'enqueue'
}

function useQueueAction(actionKey: 'queue:play' | 'queue:edit') {
  const command = usePlaybackCommand(actionKey)
  const [origin, setOrigin] = useState<QueueActionOrigin>()
  return {
    origin,
    feedback: command.feedback,
    pending: command.pending,
    forButton: (
      section: QueueSection,
      key: string,
      button: QueueActionOrigin['button'],
    ) =>
      origin?.section === section &&
      origin.key === key &&
      origin.button === button
        ? command.feedback
        : undefined,
    run(
      nextOrigin: QueueActionOrigin | undefined,
      ...[request, send]: Parameters<typeof command.run>
    ) {
      if (command.pending && !request.repeated) return
      setOrigin(nextOrigin)
      command.run(
        {
          ...request,
          unconfirmedLabel:
            actionKey === 'queue:play'
              ? 'Playback unconfirmed'
              : 'Queue update unconfirmed',
        },
        send,
      )
    },
  }
}

type QueueActions = {
  play: ReturnType<typeof useQueueAction>
  edit: ReturnType<typeof useQueueAction>
}

function queueReceipt(
  action: ReturnType<typeof useQueueAction>,
  queue: readonly QueueEntry[],
  upcoming: readonly QueueEntry[],
) {
  const { feedback, origin } = action
  if (!feedback) return undefined
  if (!origin) return feedback
  const rows = origin.section === 'queue' ? queue : upcoming
  return rows.some(({ key }) => key === origin.key) ? undefined : feedback
}

type Dragging = { section: QueueSection; key: string }
/** Where a dragged row would land: before `entries[index]`, or at the end. */
type DropPlace = { section: QueueSection; index: number }
type QueueDrag = {
  dragging: Dragging | null
  place: DropPlace | null
  start: (dragging: Dragging) => void
  over: (place: DropPlace | null) => void
  end: () => void
}

/** Rows shown from the source; the player resolves more than it lists. */
const UPCOMING_SHOWN = 10

/**
 * A row can be dropped within its own list, and a source track into the
 * manual queue. The source has no place for a queued item.
 */
function accepts(dragging: Dragging | null, section: QueueSection) {
  return (
    dragging !== null && (dragging.section === section || section === 'queue')
  )
}

function useQueueDrag(): QueueDrag {
  const [dragging, setDragging] = useState<Dragging | null>(null)
  const [place, setPlace] = useState<DropPlace | null>(null)
  return {
    dragging,
    place,
    start: setDragging,
    over: (next) =>
      setPlace((shown) =>
        shown?.section === next?.section && shown?.index === next?.index
          ? shown
          : next,
      ),
    end: () => {
      setDragging(null)
      setPlace(null)
    },
  }
}

function QueueRows({
  section,
  entries,
  drag,
  actions,
  onNavigate,
}: {
  section: QueueSection
  entries: QueueEntry[]
  drag: QueueDrag
  actions: QueueActions
  onNavigate: () => void
}) {
  const controls = usePlaybackControls()
  const { edit } = actions
  const rows = entries.map((entry) => ({
    ...entry,
    identity: queuedLibraryItem(entry.item),
  }))
  const membership = usePlayerLibraryMembership(
    rows.map(({ identity }) => identity),
    'playback-queue',
    rows.map(({ item }) => queuedPlaybackCatalog(item)),
  )
  const queued = section === 'queue'
  const from =
    drag.dragging?.section === section
      ? entries.findIndex((entry) => entry.key === drag.dragging?.key)
      : -1
  const move = queued ? controls.moveInQueue : controls.moveUpcoming
  /** A drop that would leave the row where it is shows no place. */
  const placeAt = (index: number) =>
    from >= 0 && (index === from || index === from + 1) ? null : index
  const shown = drag.place?.section === section ? drag.place.index : null
  const drop = (index: number) => {
    const dragged = drag.dragging
    drag.end()
    if (!dragged || !accepts(dragged, section)) return
    if (dragged.section !== section) {
      edit.run(
        undefined,
        queueButtonRequest(
          (next) => !next.upcoming.some(({ key }) => key === dragged.key),
          'Moved to queue',
        ),
        () => controls.queueUpcoming(dragged.key, index),
      )
    } else if (from >= 0 && placeAt(index) !== null) {
      const to = index > from ? index - 1 : index
      edit.run(
        undefined,
        queueButtonRequest(
          (next) => next[section][to]?.key === dragged.key,
          `Moved to position ${to + 1}`,
        ),
        () => move(from, to),
      )
    }
  }
  return (
    <ol className="queue-list">
      {rows.map((entry, index) => {
        const { title } = entry.item
        /** The half of the row the pointer is over decides the side. */
        const target = (event: DragEvent<HTMLLIElement>) => {
          const box = event.currentTarget.getBoundingClientRect()
          return event.clientY < box.top + box.height / 2 ? index : index + 1
        }
        return (
          <li
            key={entry.key}
            className="queue-row"
            data-dragging={from === index}
            data-drop={
              shown === index
                ? 'before'
                : shown === index + 1 && index === entries.length - 1
                  ? 'after'
                  : undefined
            }
            draggable
            onDragStart={(event) => {
              drag.start({ section, key: entry.key })
              event.dataTransfer.effectAllowed = 'move'
              event.dataTransfer.setData('text/plain', title)
            }}
            onDragEnd={drag.end}
            onDragOver={(event) => {
              if (!accepts(drag.dragging, section)) return
              event.preventDefault()
              event.stopPropagation()
              const at = placeAt(target(event))
              drag.over(at === null ? null : { section, index: at })
            }}
            onDrop={(event) => {
              event.preventDefault()
              drop(target(event))
            }}
          >
            <span className="queue-grip" aria-hidden="true">
              <GripVertical size={14} />
            </span>
            <span className="queue-item">
              <Artwork src={entry.item.artworkUrl} className="queue-art" />
              <ItemText
                item={entry.item}
                library={entry.identity}
                membership={membership}
                onNavigate={onNavigate}
              />
            </span>
            <QueueLibrarySlot
              item={entry.identity}
              membership={membership}
              touch
            />
            <QueueRowActions
              section={section}
              entry={entry}
              index={index}
              count={entries.length}
              actions={actions}
            />
          </li>
        )
      })}
    </ol>
  )
}

function QueueRowActions({
  section,
  entry,
  index,
  count,
  actions,
}: {
  section: QueueSection
  entry: QueueEntry
  index: number
  count: number
  actions: QueueActions
}) {
  const controls = usePlaybackControls()
  const { play, edit } = actions
  const up = usePlaybackCommand(`queue:up:${entry.key}`)
  const down = usePlaybackCommand(`queue:down:${entry.key}`)
  const queued = section === 'queue'
  const { key } = entry
  const { title } = entry.item
  const playFeedback = play.forButton(section, key, 'play')
  const playLabel = queued ? `Play ${title} now` : `Skip to ${title}`
  const removeLabel = queued
    ? `Remove ${title} from queue`
    : `Remove ${title} from upcoming tracks`
  const removed = (next: PlaybackState) =>
    !next[section].some(({ key }) => key === entry.key)

  function move(action: typeof up, to: number) {
    const send = queued ? controls.moveInQueue : controls.moveUpcoming
    action.run(
      queueButtonRequest(
        (next) => next[section][to]?.key === entry.key,
        `Position ${to + 1}`,
      ),
      () => send(index, to),
    )
  }
  return (
    <span className="queue-actions">
      <Button
        type="button"
        icon
        variant="ghost"
        aria-label={playLabel}
        title={playLabel}
        feedback={playFeedback}
        disabled={play.pending && Boolean(playFeedback)}
        onClick={() =>
          play.run(
            { section, key, button: 'play' },
            playButtonRequest(entry.item),
            () =>
              queued ? controls.playFromQueue(key) : controls.playUpcoming(key),
          )
        }
      >
        <Play size={14} aria-hidden="true" />
      </Button>
      {!queued && (
        <Button
          type="button"
          icon
          variant="ghost"
          aria-label={`Move ${title} to queue`}
          title={`Move ${title} to queue`}
          feedback={edit.forButton(section, key, 'enqueue')}
          onClick={() =>
            edit.run(
              { section, key, button: 'enqueue' },
              queueButtonRequest(removed, 'Moved to queue', 'Moving to queue…'),
              () => controls.queueUpcoming(key),
            )
          }
        >
          <ListPlus size={14} aria-hidden="true" />
        </Button>
      )}
      <Button
        type="button"
        icon
        variant="ghost"
        aria-label={`Move ${title} up`}
        title={`Move ${title} up`}
        feedback={up.feedback}
        disabled={index === 0}
        onClick={() => move(up, index - 1)}
      >
        <ChevronUp size={14} aria-hidden="true" />
      </Button>
      <Button
        type="button"
        icon
        variant="ghost"
        aria-label={`Move ${title} down`}
        title={`Move ${title} down`}
        feedback={down.feedback}
        disabled={index === count - 1}
        onClick={() => move(down, index + 1)}
      >
        <ChevronDown size={14} aria-hidden="true" />
      </Button>
      <Button
        type="button"
        icon
        variant="ghost"
        aria-label={removeLabel}
        title={removeLabel}
        feedback={edit.forButton(section, key, 'remove')}
        onClick={() =>
          edit.run(
            { section, key, button: 'remove' },
            queueButtonRequest(
              removed,
              queued ? 'Removed from queue' : 'Removed from upcoming',
              'Removing…',
            ),
            () =>
              queued
                ? controls.removeFromQueue(key)
                : controls.removeUpcoming(key),
          )
        }
      >
        <X size={14} aria-hidden="true" />
      </Button>
    </span>
  )
}

function QueueContents({
  view,
  playing,
  onNavigate,
}: {
  view: PlaybackView
  playing: PlayingIdentity
  onNavigate: () => void
}) {
  const { target, sharing } = view
  const drag = useQueueDrag()
  const upcoming = view.upcoming.slice(0, UPCOMING_SHOWN)
  /** A source track dragged over the empty queue becomes its first entry. */
  const intoEmptyQueue = drag.dragging?.section === 'upcoming'
  const controls = usePlaybackControls()
  const edit = useQueueAction('queue:edit')
  const play = useQueueAction('queue:play')
  const playReceipt = queueReceipt(play, view.queue, upcoming)
  const editReceipt = queueReceipt(edit, view.queue, upcoming)
  return (
    <div
      className="queue-contents"
      onDragOver={() => drag.over(null)}
      onDragLeave={(event) => {
        const to = event.relatedTarget
        if (!(to instanceof Node) || !event.currentTarget.contains(to))
          drag.over(null)
      }}
    >
      {sharing.role === 'follower' && (
        <p className="quiet">
          This queue is run from {sharing.driverName ?? 'another browser'}. A
          change made here moves it to this browser.
        </p>
      )}
      {(target.kind === 'restricted' ||
        (target.kind === 'sonos' && !target.group.playable)) && (
        <p className="quiet">
          {target.name} plays the tracks it was sent when playback moved there.
          Changes to the queue reach it after playback is started again on a
          device this app can start.
        </p>
      )}
      {target.kind === 'sonos' && target.group.playable && (
        <p className="quiet">
          {target.name} plays the tracks Spotify was given when playback moved
          there. Changes to the queue reach it with the next track started from
          here.
        </p>
      )}
      {view.source && (
        <Link
          href={view.source.href}
          className="player-source"
          onClick={onNavigate}
          title={`Back to source: ${view.source.label}`}
        >
          <CornerUpLeft size={14} aria-hidden="true" />
          <span>Back to source: {view.source.label}</span>
        </Link>
      )}
      {(playing.items.track || playing.items.album) && (
        <section>
          <h3>Playing</h3>
          <div className="queue-row">
            <span className="queue-item">
              <Artwork src={describe(view).artwork} className="queue-art" />
              <NowPlaying
                shown={playing.links}
                playing={playing.items}
                membership={playing.membership}
                onNavigate={onNavigate}
                inQueue
              />
            </span>
          </div>
        </section>
      )}
      <section>
        <div className="queue-heading">
          <h3>Queued</h3>
          <div className="queue-feedback-slot">
            <span className="queue-feedback" role="status">
              {editReceipt && (
                <span title={editReceipt.label}>
                  <ButtonFeedbackLabel feedback={editReceipt} />
                </span>
              )}
              {playReceipt && (
                <span title={playReceipt.label}>
                  <ButtonFeedbackLabel feedback={playReceipt} />
                </span>
              )}
            </span>
          </div>
        </div>
        {view.queue.length > 0 &&
          !view.current &&
          view.snapshot &&
          (view.target.kind === 'sonos'
            ? view.target.group.playable
            : view.target.kind !== 'restricted') && (
            <p className="quiet">Press Next to start the queue.</p>
          )}
        {view.queue.length ? (
          <QueueRows
            section="queue"
            entries={view.queue}
            drag={drag}
            actions={{ play, edit }}
            onNavigate={onNavigate}
          />
        ) : (
          <p
            className="quiet queue-empty"
            data-drop={drag.place?.section === 'queue' ? 'before' : undefined}
            onDragOver={(event) => {
              if (!intoEmptyQueue) return
              event.preventDefault()
              event.stopPropagation()
              drag.over({ section: 'queue', index: 0 })
            }}
            onDrop={(event) => {
              event.preventDefault()
              const dragged = drag.dragging
              drag.end()
              if (dragged?.section === 'upcoming') {
                edit.run(
                  undefined,
                  queueButtonRequest(
                    (next) =>
                      !next.upcoming.some(({ key }) => key === dragged.key),
                    'Moved to queue',
                  ),
                  () => controls.queueUpcoming(dragged.key, 0),
                )
              }
            }}
          >
            Nothing queued.
          </p>
        )}
      </section>
      {view.queue.length > 0 && (
        <p className="queue-summary">{queueSummary(view.queue)}</p>
      )}
      {view.source && (
        <section>
          <h3>Next from {view.source.label}</h3>
          {upcoming.length > 0 && (
            <QueueRows
              section="upcoming"
              entries={upcoming}
              drag={drag}
              actions={{ play, edit }}
              onNavigate={onNavigate}
            />
          )}
          {view.sourceLoading ? (
            <p className="quiet" role="status">
              Loading tracks…
            </p>
          ) : view.upcoming.length === 0 ? (
            <p className="quiet">No upcoming tracks.</p>
          ) : null}
        </section>
      )}
    </div>
  )
}

function DeviceList({
  view,
  open,
  onChosen,
}: {
  view: PlaybackView
  /** The list is on screen; Sonos rooms are read only then. */
  open: boolean
  onChosen: () => void
}) {
  const controls = usePlaybackControls()
  const transfer = usePlaybackCommand('device-transfer')
  const discovery = useDeviceDiscovery('device-discovery-retry')
  const [retrying, setRetrying] = useState(false)
  const { target } = view
  const listed =
    target.kind === 'remote' &&
    !view.devices.some((device) => device.id === target.device.id)
      ? [target.device, ...view.devices]
      : target.kind === 'restricted' || target.kind === 'sonos'
        ? view.devices.filter((device) => device.name !== target.name)
        : view.devices
  function choose(next: SelectableTarget) {
    transfer.run(
      {
        pending: `Switching to ${targetLabel(next)}…`,
        lane: 'device-transfer',
        observe(after, before) {
          const result =
            after.transfer !== before.transfer &&
            after.transfer &&
            sameDevice(after.transfer.target, next)
              ? after.transfer
              : null
          if (result?.status === 'fallback')
            return {
              phase: 'partial',
              label: 'Selected for next play · current audio stayed',
            }
          if (result?.status === 'selected')
            return {
              phase: 'done',
              label:
                before.observation &&
                sameDevice(before.observation.target, next) &&
                !before.observation.snapshot.paused
                  ? 'Already playing here'
                  : 'Selected for next play',
            }
          const report = after.observation
          const current = before.observation?.snapshot ?? before.snapshot
          if (
            report &&
            report !== before.observation &&
            sameDevice(report.target, next) &&
            (!current?.trackUri ||
              playbackReportsTrack(report.snapshot, current.trackUri)) &&
            !after.starting
          )
            return {
              phase: 'done',
              label: report.snapshot.paused
                ? `Paused on ${targetLabel(next)}`
                : `Playing on ${targetLabel(next)}`,
            }
          if (
            result?.status === 'accepted' ||
            (after.startAccepted &&
              after.starting &&
              sameDevice(next, after.target))
          )
            return { phase: 'running', label: 'Accepted · waiting for device' }
          return undefined
        },
      },
      () => controls.selectDevice(next),
    )
    onChosen()
  }
  return (
    <div className="device-list">
      <ul>
        <li>
          <button
            type="button"
            aria-pressed={target.kind === 'local'}
            disabled={transfer.pending}
            onClick={() => choose({ kind: 'local' })}
          >
            <Laptop size={16} aria-hidden="true" />
            <span>This browser</span>
            {target.kind === 'local' && <Check size={14} aria-hidden="true" />}
          </button>
        </li>
        {target.kind === 'restricted' && (
          <li>
            <button type="button" aria-pressed disabled>
              <DeviceIcon type={target.type} />
              <span>{target.name}</span>
              <Check size={14} aria-hidden="true" />
            </button>
          </li>
        )}
        {listed.map((device) => {
          const chosen =
            target.kind === 'remote' && target.device.id === device.id
          return (
            <li key={device.id}>
              <button
                type="button"
                aria-pressed={chosen}
                disabled={device.restricted || transfer.pending}
                onClick={() => choose({ kind: 'remote', device })}
              >
                <DeviceIcon type={device.type} />
                <span>{device.name}</span>
                {chosen && <Check size={14} aria-hidden="true" />}
              </button>
            </li>
          )
        })}
      </ul>
      {(view.devicesStatus === 'error' || retrying) && (
        <div className="ds-actions">
          <Button
            size="xs"
            type="button"
            variant="link"
            aria-label="Retry device list"
            feedback={retrying ? discovery.feedback : undefined}
            disabled={discovery.pending}
            onClick={() => {
              setRetrying(true)
              discovery.refresh()
            }}
          >
            {view.devicesStatus === 'error' ? 'Retry' : 'Find devices again'}
          </Button>
        </div>
      )}
      {target.kind === 'restricted' && !view.findingSonos && (
        <p className="quiet">
          Spotify does not let apps control {target.name}. Choosing a device
          moves the playback there.
        </p>
      )}
      {target.kind === 'sonos' && (
        <p className="quiet">
          {target.name} is controlled through Sonos. Choosing a device moves the
          playback there.
        </p>
      )}
      <p className="quiet">Devices appear when Spotify is open on them.</p>
      {open && (
        <SonosRooms
          view={view}
          onChoose={(room) => choose({ kind: 'room', room })}
        />
      )}
      {open && <PlayerConnections />}
    </div>
  )
}

function DockPopover({
  label,
  title,
  trigger: triggerContent,
  action,
  highlighted = false,
  onOpen,
  onOpenChange,
  feedback,
  children,
}: {
  label: string
  title: string
  trigger: ReactNode
  action?: ReactNode
  highlighted?: boolean
  onOpen?: () => void
  onOpenChange?: (open: boolean) => void
  feedback?: ButtonFeedback
  children: (close: () => void, open: boolean) => ReactNode
}) {
  const id = useId()
  const titleId = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open) return
    panel.current?.focus({ preventScroll: true })
    function position() {
      if (!trigger.current || !panel.current) return
      const rect = trigger.current.getBoundingClientRect()
      const box = panel.current.getBoundingClientRect()
      panel.current.style.left = `${Math.max(8, Math.min(rect.right - box.width, window.innerWidth - box.width - 8))}px`
      panel.current.style.top = `${Math.max(8, rect.top - box.height - 10)}px`
    }
    position()
    const observer = new ResizeObserver(position)
    if (panel.current) observer.observe(panel.current)
    window.addEventListener('resize', position)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', position)
    }
  }, [open])
  function close() {
    panel.current?.hidePopover()
    trigger.current?.focus()
  }
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        ref={trigger}
        className="player-tool"
        popoverTarget={id}
        aria-label={label}
        aria-expanded={open}
        aria-controls={id}
        data-highlighted={highlighted}
        feedback={feedback}
      >
        {triggerContent}
      </Button>
      <div
        id={id}
        ref={panel}
        popover="auto"
        role="region"
        tabIndex={-1}
        aria-labelledby={titleId}
        className="player-popover"
        onToggle={(event) => {
          const opened = event.newState === 'open'
          setOpen(opened)
          onOpenChange?.(opened)
          if (opened) onOpen?.()
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return
          event.preventDefault()
          event.stopPropagation()
          close()
        }}
      >
        <div className="player-popover-heading">
          <h2 id={titleId}>{title}</h2>
          {action}
        </div>
        {children(close, open)}
      </div>
    </>
  )
}

function TargetIcon({ view }: { view: PlaybackView }) {
  if (view.target.kind === 'sonos' || view.target.kind === 'room')
    return <SonosMark />
  if (view.findingSonos)
    return (
      <LoaderCircle
        size={16}
        aria-hidden="true"
        className="motion-safe:animate-spin"
      />
    )
  return <MonitorSpeaker size={16} aria-hidden="true" />
}

function useDeviceDiscovery(action = 'device-discovery') {
  const controls = usePlaybackControls()
  const lookup = usePlaybackCommand(action)
  return {
    ...lookup,
    refresh: () =>
      lookup.run(
        {
          pending: 'Finding devices…',
          observe(after, before) {
            if (after.devicesStatus === 'error')
              return { phase: 'failed', label: 'Device list failed · retry' }
            if (
              after.devicesStatus === 'idle' &&
              after.devices !== before.devices
            )
              return {
                phase: 'done',
                label:
                  after.devices.length === 0
                    ? 'No other Spotify devices'
                    : `${after.devices.length} Spotify ${after.devices.length === 1 ? 'device' : 'devices'} found`,
              }
            return undefined
          },
        },
        controls.refreshDevices,
      ),
  }
}

function useDevicePickerFeedback(view: PlaybackView, retryVisible: boolean) {
  const transfer = usePlaybackCommand('device-transfer')
  const discovery = useDeviceDiscovery()
  const retry = usePlaybackCommand('device-discovery-retry')
  if (transfer.feedback) return { ...discovery, feedback: transfer.feedback }
  if (retry.feedback)
    return { ...discovery, feedback: retryVisible ? undefined : retry.feedback }
  if (discovery.feedback) return discovery
  if (view.devicesStatus === 'loading')
    return {
      ...discovery,
      feedback: {
        phase: 'pending',
        label: 'Finding devices…',
      } satisfies ButtonFeedback,
    }
  if (view.devicesStatus === 'error')
    return {
      ...discovery,
      feedback: {
        phase: 'failed',
        label: 'Device list failed · retry',
      } satisfies ButtonFeedback,
    }
  return discovery
}

function NowPlayingSheet({
  view,
  playing,
  onClose,
}: {
  view: PlaybackView
  playing: PlayingIdentity
  onClose: () => void
}) {
  const panel = useRef<HTMLElement>(null)
  const [devicesOpen, setDevicesOpen] = useState(false)
  const devices = useDevicePickerFeedback(view, devicesOpen)
  const shown = describe(view)
  useEffect(() => {
    const previous = document.activeElement
    panel.current?.focus({ preventScroll: true })
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus({ preventScroll: true })
    }
  }, [])
  useEffect(() => {
    // Heard first, so Escape closes the player before a drawer beneath it,
    // but after a menu or picker opened inside it.
    function onEscape(event: KeyboardEvent) {
      if (
        event.key !== 'Escape' ||
        document.querySelector('dialog[open], [popover]:popover-open')
      )
        return
      event.preventDefault()
      event.stopPropagation()
      onClose()
    }
    document.addEventListener('keydown', onEscape, true)
    return () => document.removeEventListener('keydown', onEscape, true)
  }, [onClose])
  return (
    <>
      <div
        className="inspector-backdrop player-sheet-backdrop"
        onClick={(event) => {
          event.stopPropagation()
          onClose()
        }}
      />
      <MediaInspector
        ref={panel}
        className="player-sheet"
        tabIndex={-1}
        aria-label="Player"
        onDismiss={onClose}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
        header={
          <>
            <span>Player</span>
            <button type="button" aria-label="Close player" onClick={onClose}>
              <X size={18} aria-hidden="true" />
            </button>
          </>
        }
      >
        <div className="inspector-scroll">
          <div className="player-sheet-body">
            <Artwork src={shown.artwork} className="player-sheet-art" />
            <NowPlaying
              shown={playing.links}
              playing={playing.items}
              membership={playing.membership}
              onNavigate={onClose}
              touch
            />
            <Scrubber
              snapshot={view.snapshot}
              readOnly={!seekable(view.target)}
            />
            <Transport view={view} />
            <div className="player-sheet-actions">
              <Button
                type="button"
                variant="ghost"
                className="player-tool"
                aria-label={`Play on: ${targetLabel(view.target)}`}
                aria-expanded={devicesOpen}
                data-highlighted={view.target.kind !== 'local'}
                feedback={devices.feedback}
                onClick={() => {
                  if (!devicesOpen) devices.refresh()
                  setDevicesOpen(!devicesOpen)
                }}
              >
                <TargetIcon view={view} />
                <span>{targetLabel(view.target)}</span>
              </Button>
              {shown.spotifyUrl && (
                <ServiceIconLinks
                  links={[
                    {
                      provider: 'spotify',
                      label: 'Spotify',
                      url: shown.spotifyUrl,
                    },
                  ]}
                />
              )}
            </div>
            {devicesOpen && (
              <DeviceList
                view={view}
                open
                onChosen={() => setDevicesOpen(false)}
              />
            )}
            <VolumeControl volume={view.volume} />
            <QueueContents view={view} playing={playing} onNavigate={onClose} />
          </div>
        </div>
        <ResultLineSlot place="panel" />
      </MediaInspector>
    </>
  )
}

/** What the player says about taking over a saved session's device. */
export function rejoinMessage({ status, device }: PlaybackRejoin) {
  const on = device ? ` on ${device}` : ''
  const name = device ?? 'The device'
  switch (status) {
    case 'checking':
      return `Rejoining the queue${on}…`
    case 'rejoined':
      return `Rejoined the queue${on}.`
    case 'changed':
      return `${name} no longer has this queue, so the player did not rejoin it.`
    case 'ended':
      return `The queue is no longer playing${on}.`
    case 'unreadable':
      return `${name} could not be read, so the player did not rejoin it.`
  }
}

function RejoinNotice({ rejoin }: { rejoin: PlaybackRejoin }) {
  const { clearFailure } = usePlaybackControls()
  return (
    <div className="player-alert" role="status" data-tone="info">
      <span>{rejoinMessage(rejoin)}</span>
      {rejoin.status !== 'checking' && (
        <button type="button" aria-label="Dismiss" onClick={clearFailure}>
          <X size={14} aria-hidden="true" />
        </button>
      )}
    </div>
  )
}

function Dock({ view }: { view: PlaybackView }) {
  const controls = usePlaybackControls()
  const [devicesOpen, setDevicesOpen] = useState(false)
  const devices = useDevicePickerFeedback(view, devicesOpen)
  const clearQueue = usePlaybackCommand('queue:clear')
  const { apiBaseUrl } = useConfig()
  const phone = usePhoneLayout()
  const [sheet, setSheet] = useState(false)
  const reconnect = useMutation({
    mutationFn: () => spotifyAuthorizationUrl(apiBaseUrl, { playback: true }),
    onSuccess: (url) => window.location.assign(url),
  })
  const shown = describe(view)
  const { failure } = view
  const items = playingLibraryItems(view.snapshot, view.current)
  const observed = currentPlaybackCatalog(view.snapshot, view.current)
  const membership = usePlayerLibraryMembership(
    [items.track, items.album],
    'playback',
    [observed],
  )
  const playing = {
    items,
    links: references(view, items, membership),
    membership,
  }
  const miniTitle = items.track ?? items.album

  if (failure?.status === 'expired')
    return (
      <section className="player-dock" aria-label="Player">
        <div className="player-row" data-state="expired">
          <div className="player-now" role="alert">
            <span className="player-text">
              <strong>Spotify disconnected</strong>
              <span>{failure.message}</span>
            </span>
          </div>
          <div className="player-tools">
            <Button
              variant="primary"
              type="button"
              disabled={reconnect.isPending || reconnect.isSuccess}
              feedback={connectionFeedback(reconnect)}
              onClick={() => reconnect.mutate()}
            >
              Reconnect
            </Button>
          </div>
        </div>
      </section>
    )

  const artwork = <Artwork src={shown.artwork} className="player-art" />
  return (
    <section className="player-dock" aria-label="Player">
      <Hairline snapshot={view.snapshot} />
      {!failure && <ConnectionOutcome />}
      {!failure && view.rejoin && <RejoinNotice rejoin={view.rejoin} />}
      {failure && (
        <div className="player-alert" role="alert">
          <span>{failure.message}</span>
          {shown.spotifyUrl && (
            <ServiceIconLinks
              links={[
                {
                  provider: 'spotify',
                  label: 'Spotify',
                  url: shown.spotifyUrl,
                },
              ]}
            />
          )}
          <button
            type="button"
            aria-label="Dismiss"
            onClick={controls.clearFailure}
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      )}
      <div className="player-row">
        <div className="player-now">
          {phone ? (
            <>
              <button
                type="button"
                className="player-track"
                aria-label={`Open player: ${shown.title}`}
                onClick={() => setSheet(true)}
              >
                {artwork}
                <span className="player-text">
                  <strong>{shown.title}</strong>
                  <span>{shown.detail}</span>
                </span>
              </button>
              {miniTitle && (
                <PlayerLibraryAction
                  item={miniTitle}
                  membership={membership}
                  showFeedback={!sheet}
                  touch
                />
              )}
            </>
          ) : (
            <div className="player-track">
              <PlayerLink to={playing.links.album}>{artwork}</PlayerLink>
              <NowPlaying
                shown={playing.links}
                playing={playing.items}
                membership={membership}
              />
            </div>
          )}
        </div>
        <div className="player-transport">
          <Transport view={view} showFeedback={!phone || !sheet} />
          <Scrubber
            snapshot={view.snapshot}
            readOnly={!seekable(view.target)}
          />
        </div>
        <div className="player-tools">
          <DockPopover
            label={
              view.source
                ? `Queue: ${view.queue.length} queued, ${view.upcoming.length} upcoming`
                : `Queue: ${view.queue.length} next`
            }
            title="Queue"
            trigger={
              <>
                <ListMusic size={16} aria-hidden="true" />
                {view.queue.length > 0 && (
                  <span className="player-count">{view.queue.length}</span>
                )}
              </>
            }
            action={
              <Button
                type="button"
                variant="ghost"
                disabled={!view.queue.length}
                feedback={clearQueue.feedback}
                onClick={() =>
                  clearQueue.run(
                    queueButtonRequest(
                      (next, before) =>
                        before.queue.length > 0 && next.queue.length === 0,
                      'Queue cleared',
                    ),
                    controls.clearQueue,
                  )
                }
              >
                Clear
              </Button>
            }
          >
            {(close) => (
              <QueueContents view={view} playing={playing} onNavigate={close} />
            )}
          </DockPopover>
          <DockPopover
            label={`Play on: ${targetLabel(view.target)}`}
            title="Play on"
            feedback={devices.feedback}
            highlighted={view.target.kind !== 'local'}
            onOpen={devices.refresh}
            onOpenChange={setDevicesOpen}
            trigger={
              <>
                <TargetIcon view={view} />
                <span>{targetLabel(view.target)}</span>
              </>
            }
          >
            {(close, open) => (
              <DeviceList view={view} open={open} onChosen={close} />
            )}
          </DockPopover>
          <VolumeControl volume={view.volume} />
          {shown.spotifyUrl && (
            <a
              className="player-tool"
              href={shown.spotifyUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Open in Spotify (opens in a new tab)"
            >
              <img
                src="/icons/services/spotify.svg"
                width={16}
                height={16}
                alt=""
              />
            </a>
          )}
        </div>
      </div>
      {sheet && phone && (
        <NowPlayingSheet
          view={view}
          playing={playing}
          onClose={() => setSheet(false)}
        />
      )}
    </section>
  )
}

/**
 * The player bar, shown at all times: the player once Spotify playback is
 * connected, and until then a prompt to connect it that can be dismissed.
 */
export default function PlayerDock() {
  const view = usePlayback()
  if (view.connection === 'loading') return null
  if (view.connection !== 'connected')
    return <ConnectPrompt configured={view.connection === 'disconnected'} />
  return view.enabled ? (
    <PlayerLibraryActions>
      <Dock view={view} />
    </PlayerLibraryActions>
  ) : null
}
