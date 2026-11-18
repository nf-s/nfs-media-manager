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
import { Button } from '@repo/ui/components/ui/button'
import { DetailLink } from './detail-link'
import { MediaInspector } from './media-inspector'
import ServiceIconLinks from './service-icon-links'
import MediaArtwork from './media-artwork'
import {
  ConnectionOutcome,
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
  formatClock,
  positionAt,
  queueSummary,
  spotifyWebUrl,
  type PlayableItem,
  type PlaybackSnapshot,
  type QueueEntry,
} from '@/utils/playback'
import type { DetailTarget } from '@/utils/detail-inspector'
import type {
  PlaybackRejoin,
  PlaybackTarget,
  SelectableTarget,
} from '@/utils/playback-engine'
import { spotifyAuthorizationUrl } from '@/utils/spotify-authorize'

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
    artwork: current?.artworkUrl ?? snapshot?.artworkUrl ?? null,
    spotifyUrl: spotifyWebUrl(snapshot?.trackUri ?? current?.uri ?? null),
  }
}

/** Something the player names: its library page when there is one, else its Spotify page. */
type Reference = {
  label: string
  detail: DetailTarget | null
  url: string | null
}

/** Where the playing track, its artists and its album lead. */
function references(view: PlaybackView) {
  const { snapshot, current } = view
  const credits = current?.credits ?? []
  const album: Reference = {
    label: snapshot?.albumName || current?.albumTitle || '',
    detail: current?.albumId ? { kind: 'album', id: current.albumId } : null,
    url: spotifyWebUrl(
      snapshot?.albumUri ?? (current?.kind === 'album' ? current.uri : null),
    ),
  }
  const track: Reference = {
    label: snapshot?.trackName ?? current?.title ?? 'Nothing playing',
    detail:
      current?.kind === 'track' && current.trackId
        ? { kind: 'track', id: current.trackId }
        : album.detail,
    url: spotifyWebUrl(
      snapshot?.trackUri ?? (current?.kind === 'track' ? current.uri : null),
    ),
  }
  const named = snapshot
    ? snapshot.artistLinks
    : credits.map(({ name }) => ({ name, uri: null }))
  const plain = snapshot?.artists ?? current?.artist ?? ''
  const artists: Reference[] = named.length
    ? named.map(({ name, uri }) => {
        const id = credits.find((credit) => credit.name === name)?.id
        return {
          label: name,
          detail: id ? { kind: 'artist', id } : null,
          url: spotifyWebUrl(uri),
        }
      })
    : plain
      ? [{ label: plain, detail: null, url: null }]
      : []
  return { track, artists, album }
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

/** The playing track, its artists and its album, each linked. */
function NowPlaying({
  view,
  onNavigate,
}: {
  view: PlaybackView
  onNavigate?: () => void
}) {
  const { track, artists, album } = references(view)
  return (
    <span className="player-text">
      <strong>
        <PlayerLink to={track} onNavigate={onNavigate} />
      </strong>
      <span>
        {artists.map((artist, index) => (
          <Fragment key={`${artist.label}:${index}`}>
            {index > 0 && ', '}
            <PlayerLink to={artist} onNavigate={onNavigate} />
          </Fragment>
        ))}
        {artists.length > 0 && album.label && ' · '}
        {album.label && <PlayerLink to={album} onNavigate={onNavigate} />}
      </span>
    </span>
  )
}

function itemDetail(item: PlayableItem) {
  if (item.kind === 'track')
    return [item.artist, item.albumTitle].filter(Boolean).join(' · ')
  return [
    item.artist,
    item.trackCount === null
      ? ''
      : `${item.trackCount} ${item.trackCount === 1 ? 'track' : 'tracks'}`,
  ]
    .filter(Boolean)
    .join(' · ')
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
  const position = usePosition(snapshot)
  const [drag, setDrag] = useState<number | null>(null)
  const duration = snapshot?.durationMs ?? 0
  const shown = Math.min(drag ?? position, duration)
  function commit() {
    if (drag === null) return
    seek(drag)
    setDrag(null)
  }
  return (
    <div className="player-scrub">
      <span className="player-time">{formatClock(shown)}</span>
      <div className="player-range">
        <span
          className="player-range-fill"
          style={{ width: percent(shown, duration) }}
        />
        <input
          type="range"
          aria-label="Seek"
          aria-valuetext={`${formatClock(shown)} of ${formatClock(duration)}`}
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
      <span className="player-time">{formatClock(duration)}</span>
    </div>
  )
}

function Transport({ view }: { view: PlaybackView }) {
  const controls = usePlaybackControls()
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
  return (
    <div className="player-buttons">
      <button
        type="button"
        className="player-skip"
        aria-label="Shuffle"
        aria-pressed={view.shuffle}
        title="Shuffle"
        onClick={controls.toggleShuffle}
      >
        <Shuffle size={16} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="player-skip"
        aria-label="Previous"
        disabled={
          !snapshot ||
          readOnly ||
          (sonos !== null && !sonos.previous && !sonos.seek)
        }
        onClick={controls.previous}
      >
        <SkipBack size={16} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="player-toggle"
        aria-label={starting ? 'Starting' : playing ? 'Pause' : 'Play'}
        disabled={
          starting ||
          nothingToPlay ||
          readOnly ||
          (sonos !== null && !(playing ? sonos.pause : sonos.play))
        }
        onClick={controls.toggle}
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
      </button>
      <button
        type="button"
        className="player-skip"
        aria-label="Next"
        disabled={
          sonos
            ? !snapshot || (!sonos.next && !startsNext)
            : readOnly || (!snapshot && !hasNext)
        }
        onClick={controls.next}
      >
        <SkipForward size={16} aria-hidden="true" />
      </button>
    </div>
  )
}

function VolumeControl({ volume }: { volume: number | null }) {
  const { setVolume } = usePlaybackControls()
  const restore = useRef(0.5)
  if (volume === null) return null
  const muted = volume === 0
  return (
    <div className="player-volume">
      <button
        type="button"
        className="player-tool"
        aria-label={muted ? 'Unmute' : 'Mute'}
        onClick={() => {
          if (muted) return setVolume(restore.current)
          restore.current = volume
          setVolume(0)
        }}
      >
        {muted ? (
          <VolumeX size={16} aria-hidden="true" />
        ) : (
          <Volume2 size={16} aria-hidden="true" />
        )}
      </button>
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
          onChange={(event) => setVolume(Number(event.target.value))}
        />
      </div>
    </div>
  )
}

function ItemText({ item }: { item: PlayableItem }) {
  return (
    <span className="player-text">
      <strong>{item.title}</strong>
      <span>{itemDetail(item)}</span>
    </span>
  )
}

/** The two lists of the queue panel that hold tracks still to play. */
type QueueSection = 'queue' | 'upcoming'
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
}: {
  section: QueueSection
  entries: QueueEntry[]
  drag: QueueDrag
}) {
  const controls = usePlaybackControls()
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
    if (dragged.section !== section) controls.queueUpcoming(dragged.key, index)
    else if (from >= 0 && placeAt(index) !== null)
      move(from, index > from ? index - 1 : index)
  }
  return (
    <ol className="queue-list">
      {entries.map((entry, index) => {
        const { title } = entry.item
        const play = queued ? `Play ${title} now` : `Skip to ${title}`
        const remove = queued
          ? `Remove ${title} from queue`
          : `Remove ${title} from upcoming tracks`
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
              <ItemText item={entry.item} />
            </span>
            <span className="queue-actions">
              <button
                type="button"
                aria-label={play}
                title={play}
                onClick={() =>
                  queued
                    ? controls.playFromQueue(entry.key)
                    : controls.playUpcoming(entry.key)
                }
              >
                <Play size={14} aria-hidden="true" />
              </button>
              {!queued && (
                <button
                  type="button"
                  aria-label={`Move ${title} to queue`}
                  title={`Move ${title} to queue`}
                  onClick={() => controls.queueUpcoming(entry.key)}
                >
                  <ListPlus size={14} aria-hidden="true" />
                </button>
              )}
              <button
                type="button"
                aria-label={`Move ${title} up`}
                title={`Move ${title} up`}
                disabled={index === 0}
                onClick={() => move(index, index - 1)}
              >
                <ChevronUp size={14} aria-hidden="true" />
              </button>
              <button
                type="button"
                aria-label={`Move ${title} down`}
                title={`Move ${title} down`}
                disabled={index === entries.length - 1}
                onClick={() => move(index, index + 1)}
              >
                <ChevronDown size={14} aria-hidden="true" />
              </button>
              <button
                type="button"
                aria-label={remove}
                title={remove}
                onClick={() =>
                  queued
                    ? controls.removeFromQueue(entry.key)
                    : controls.removeUpcoming(entry.key)
                }
              >
                <X size={14} aria-hidden="true" />
              </button>
            </span>
          </li>
        )
      })}
    </ol>
  )
}

function QueueContents({
  view,
  onNavigate,
}: {
  view: PlaybackView
  onNavigate: () => void
}) {
  const { target, sharing } = view
  const drag = useQueueDrag()
  const upcoming = view.upcoming.slice(0, UPCOMING_SHOWN)
  /** A source track dragged over the empty queue becomes its first entry. */
  const intoEmptyQueue = drag.dragging?.section === 'upcoming'
  const controls = usePlaybackControls()
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
      {view.current && (
        <section>
          <h3>Playing</h3>
          <div className="queue-row">
            <span className="queue-item">
              <Artwork src={view.current.artworkUrl} className="queue-art" />
              <ItemText item={view.current} />
            </span>
          </div>
        </section>
      )}
      <section>
        <h3>Queued</h3>
        {view.queue.length > 0 &&
          !view.current &&
          view.snapshot &&
          (view.target.kind === 'sonos'
            ? view.target.group.playable
            : view.target.kind !== 'restricted') && (
            <p className="quiet">Press Next to start the queue.</p>
          )}
        {view.queue.length ? (
          <QueueRows section="queue" entries={view.queue} drag={drag} />
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
              if (dragged?.section === 'upcoming')
                controls.queueUpcoming(dragged.key, 0)
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
            <QueueRows section="upcoming" entries={upcoming} drag={drag} />
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
  const { target } = view
  const listed =
    target.kind === 'remote' &&
    !view.devices.some((device) => device.id === target.device.id)
      ? [target.device, ...view.devices]
      : target.kind === 'restricted' || target.kind === 'sonos'
        ? view.devices.filter((device) => device.name !== target.name)
        : view.devices
  function choose(next: SelectableTarget) {
    void controls.selectDevice(next)
    onChosen()
  }
  return (
    <div className="device-list">
      <ul>
        <li>
          <button
            type="button"
            aria-pressed={target.kind === 'local'}
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
                disabled={device.restricted}
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
      {view.devicesStatus === 'loading' && !view.devices.length && (
        <p role="status">Looking for devices...</p>
      )}
      {view.devicesStatus === 'error' && (
        <p role="alert">
          Devices could not be loaded.{' '}
          <button
            type="button"
            className="underline"
            onClick={() => void controls.refreshDevices()}
          >
            Retry
          </button>
        </p>
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
  children,
}: {
  label: string
  title: string
  trigger: ReactNode
  action?: ReactNode
  highlighted?: boolean
  onOpen?: () => void
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
      <button
        type="button"
        ref={trigger}
        className="player-tool"
        popoverTarget={id}
        aria-label={label}
        aria-expanded={open}
        aria-controls={id}
        data-highlighted={highlighted}
      >
        {triggerContent}
      </button>
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

function NowPlayingSheet({
  view,
  onClose,
}: {
  view: PlaybackView
  onClose: () => void
}) {
  const controls = usePlaybackControls()
  const panel = useRef<HTMLElement>(null)
  const [devicesOpen, setDevicesOpen] = useState(false)
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
    // Heard first, so Escape closes the player before a drawer beneath it.
    function onEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape' || document.querySelector('dialog[open]'))
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
            <NowPlaying view={view} onNavigate={onClose} />
            <Scrubber
              snapshot={view.snapshot}
              readOnly={!seekable(view.target)}
            />
            <Transport view={view} />
            <div className="player-sheet-actions">
              <button
                type="button"
                className="player-tool"
                aria-expanded={devicesOpen}
                data-highlighted={view.target.kind !== 'local'}
                onClick={() => {
                  if (!devicesOpen) void controls.refreshDevices()
                  setDevicesOpen(!devicesOpen)
                }}
              >
                <TargetIcon view={view} />
                <span>{targetLabel(view.target)}</span>
              </button>
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
            <QueueContents view={view} onNavigate={onClose} />
          </div>
        </div>
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
  const { apiBaseUrl } = useConfig()
  const phone = usePhoneLayout()
  const [sheet, setSheet] = useState(false)
  const reconnect = useMutation({
    mutationFn: () => spotifyAuthorizationUrl(apiBaseUrl, { playback: true }),
    onSuccess: (url) => window.location.assign(url),
  })
  const shown = describe(view)
  const { failure } = view

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
              disabled={reconnect.isPending}
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
          ) : (
            <div className="player-track">
              <PlayerLink to={references(view).album}>{artwork}</PlayerLink>
              <NowPlaying view={view} />
            </div>
          )}
        </div>
        <div className="player-transport">
          <Transport view={view} />
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
                onClick={controls.clearQueue}
              >
                Clear
              </Button>
            }
          >
            {(close) => <QueueContents view={view} onNavigate={close} />}
          </DockPopover>
          <DockPopover
            label={`Play on: ${targetLabel(view.target)}`}
            title="Play on"
            highlighted={view.target.kind !== 'local'}
            onOpen={() => void controls.refreshDevices()}
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
      <p className="sr-only" role="status">
        {view.announcement}
      </p>
      {sheet && phone && (
        <NowPlayingSheet view={view} onClose={() => setSheet(false)} />
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
  return view.enabled ? <Dock view={view} /> : null
}
