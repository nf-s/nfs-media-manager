'use client'

import { usePathname, useRouter } from 'next/navigation'
import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import { useMutation } from '@tanstack/react-query'
import {
  Check,
  ChevronDown,
  ChevronUp,
  GripVertical,
  Laptop,
  ListMusic,
  LoaderCircle,
  MonitorSpeaker,
  Pause,
  Play,
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
import ExternalLink from './external-link'
import MediaArtwork from './media-artwork'
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
import type { PlaybackTarget, SelectableTarget } from '@/utils/playback-engine'
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
  return target.kind === 'remote' ? target.device.name : target.name
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
  const nothingToPlay = !snapshot && !view.current && view.queue.length === 0
  // Spotify does not let apps control a restricted device; the queue can still start here.
  const readOnly = view.target.kind === 'restricted'
  return (
    <div className="player-buttons">
      <button
        type="button"
        className="player-skip"
        aria-label="Previous"
        disabled={!snapshot || readOnly}
        onClick={controls.previous}
      >
        <SkipBack size={16} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="player-toggle"
        aria-label={starting ? 'Starting' : playing ? 'Pause' : 'Play'}
        disabled={starting || nothingToPlay || readOnly}
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
        disabled={(!snapshot || readOnly) && view.queue.length === 0}
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

function QueueList({ queue }: { queue: QueueEntry[] }) {
  const controls = usePlaybackControls()
  const [dragged, setDragged] = useState<string | null>(null)
  return (
    <ol className="queue-list">
      {queue.map((entry, index) => (
        <li
          key={entry.key}
          className="queue-row"
          data-dragging={dragged === entry.key}
          draggable
          onDragStart={(event) => {
            setDragged(entry.key)
            event.dataTransfer.effectAllowed = 'move'
            event.dataTransfer.setData('text/plain', entry.item.title)
          }}
          onDragEnd={() => setDragged(null)}
          onDragOver={(event) => {
            if (dragged === null) return
            event.preventDefault()
            const from = queue.findIndex(
              (candidate) => candidate.key === dragged,
            )
            if (from >= 0 && from !== index) controls.moveInQueue(from, index)
          }}
          onDrop={(event) => event.preventDefault()}
        >
          <span className="queue-grip" aria-hidden="true">
            <GripVertical size={14} />
          </span>
          <button
            type="button"
            className="queue-item"
            aria-label={`Play ${entry.item.title} now`}
            onClick={() => controls.playFromQueue(entry.key)}
          >
            <Artwork src={entry.item.artworkUrl} className="queue-art" />
            <ItemText item={entry.item} />
          </button>
          <span className="queue-actions">
            <button
              type="button"
              aria-label={`Move ${entry.item.title} up`}
              disabled={index === 0}
              onClick={() => controls.moveInQueue(index, index - 1)}
            >
              <ChevronUp size={14} aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label={`Move ${entry.item.title} down`}
              disabled={index === queue.length - 1}
              onClick={() => controls.moveInQueue(index, index + 1)}
            >
              <ChevronDown size={14} aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label={`Remove ${entry.item.title} from queue`}
              onClick={() => controls.removeFromQueue(entry.key)}
            >
              <X size={14} aria-hidden="true" />
            </button>
          </span>
        </li>
      ))}
    </ol>
  )
}

function QueueContents({ view }: { view: PlaybackView }) {
  return (
    <div className="queue-contents">
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
        <h3>Next</h3>
        {view.queue.length > 0 && !view.current && view.snapshot && (
          <p className="quiet">Press Next to start the queue.</p>
        )}
        {view.queue.length ? (
          <QueueList queue={view.queue} />
        ) : (
          <p className="quiet">Nothing queued.</p>
        )}
      </section>
      {view.queue.length > 0 && (
        <p className="queue-summary">{queueSummary(view.queue)}</p>
      )}
    </div>
  )
}

function DeviceList({
  view,
  onChosen,
}: {
  view: PlaybackView
  onChosen: () => void
}) {
  const controls = usePlaybackControls()
  const { target } = view
  const listed =
    target.kind === 'remote' &&
    !view.devices.some((device) => device.id === target.device.id)
      ? [target.device, ...view.devices]
      : target.kind === 'restricted'
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
      {target.kind === 'restricted' && (
        <p className="quiet">
          Spotify does not let apps control {target.name}. Choose a device to
          play there instead.
        </p>
      )}
      <p className="quiet">Devices appear when Spotify is open on them.</p>
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
  children: (close: () => void) => ReactNode
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
        {children(close)}
      </div>
    </>
  )
}

function NowPlayingSheet({
  view,
  onClose,
  onOpenAlbum,
}: {
  view: PlaybackView
  onClose: () => void
  onOpenAlbum: (albumId: string) => void
}) {
  const controls = usePlaybackControls()
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const [devicesOpen, setDevicesOpen] = useState(false)
  const shown = describe(view)
  const albumId = view.current?.albumId ?? null
  useEffect(() => {
    const element = dialog.current
    const previous = document.activeElement
    if (!element?.open) element?.showModal()
    return () => {
      element?.close()
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus({ preventScroll: true })
    }
  }, [])
  return (
    <dialog
      ref={dialog}
      className="tag-drawer player-sheet"
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
      <div className="tag-drawer-inner">
        <div className="detail-topbar">
          <span id={titleId}>Player</span>
          <button type="button" aria-label="Close player" onClick={onClose}>
            <X size={20} />
          </button>
        </div>
        <div className="player-sheet-body">
          <Artwork src={shown.artwork} className="player-sheet-art" />
          <div className="player-text">
            <strong>{shown.title}</strong>
            <span>{shown.detail}</span>
          </div>
          <Scrubber
            snapshot={view.snapshot}
            readOnly={view.target.kind === 'restricted'}
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
              <MonitorSpeaker size={16} aria-hidden="true" />
              <span>{targetLabel(view.target)}</span>
            </button>
            {albumId && (
              <button
                type="button"
                className="player-tool"
                onClick={() => {
                  onClose()
                  onOpenAlbum(albumId)
                }}
              >
                Open album
              </button>
            )}
            {shown.spotifyUrl && (
              <ExternalLink className="player-tool" href={shown.spotifyUrl}>
                Open in Spotify
              </ExternalLink>
            )}
          </div>
          {devicesOpen && (
            <DeviceList view={view} onChosen={() => setDevicesOpen(false)} />
          )}
          <VolumeControl volume={view.volume} />
          <QueueContents view={view} />
        </div>
      </div>
    </dialog>
  )
}

function Dock({ view }: { view: PlaybackView }) {
  const controls = usePlaybackControls()
  const { apiBaseUrl } = useConfig()
  const router = useRouter()
  const pathname = usePathname()
  const phone = usePhoneLayout()
  const [sheet, setSheet] = useState(false)
  const reconnect = useMutation({
    mutationFn: () => spotifyAuthorizationUrl(apiBaseUrl, { playback: true }),
    onSuccess: (url) => window.location.assign(url),
  })
  const shown = describe(view)
  const { current, failure } = view
  const albumId = current?.albumId ?? null

  function openAlbum(albumId: string) {
    const browsing = pathname === '/albums'
    const params = new URLSearchParams(browsing ? window.location.search : '')
    params.set('item', albumId)
    const url = `/albums?${params}`
    // The album browser reads the open item from the URL without a navigation.
    if (browsing) window.history.pushState(null, '', url)
    else router.push(url)
  }

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
              type="button"
              size="sm"
              disabled={reconnect.isPending}
              onClick={() => reconnect.mutate()}
            >
              Reconnect
            </Button>
          </div>
        </div>
      </section>
    )

  const track = (
    <>
      <Artwork src={shown.artwork} className="player-art" />
      <span className="player-text">
        <strong>{shown.title}</strong>
        <span>{shown.detail}</span>
      </span>
    </>
  )
  return (
    <section className="player-dock" aria-label="Player">
      <Hairline snapshot={view.snapshot} />
      {failure && (
        <div className="player-alert" role="alert">
          <span>{failure.message}</span>
          {shown.spotifyUrl && (
            <ExternalLink href={shown.spotifyUrl}>Open in Spotify</ExternalLink>
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
              {track}
            </button>
          ) : current && albumId ? (
            <button
              type="button"
              className="player-track"
              aria-label={`Open ${current.albumTitle}`}
              onClick={() => openAlbum(albumId)}
            >
              {track}
            </button>
          ) : (
            <div className="player-track">{track}</div>
          )}
        </div>
        <div className="player-transport">
          <Transport view={view} />
          <Scrubber
            snapshot={view.snapshot}
            readOnly={view.target.kind === 'restricted'}
          />
        </div>
        <div className="player-tools">
          <DockPopover
            label={`Queue: ${view.queue.length} next`}
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
                size="sm"
                disabled={!view.queue.length}
                onClick={controls.clearQueue}
              >
                Clear
              </Button>
            }
          >
            {() => <QueueContents view={view} />}
          </DockPopover>
          <DockPopover
            label={`Play on: ${targetLabel(view.target)}`}
            title="Play on"
            highlighted={view.target.kind !== 'local'}
            onOpen={() => void controls.refreshDevices()}
            trigger={
              <>
                <MonitorSpeaker size={16} aria-hidden="true" />
                <span>{targetLabel(view.target)}</span>
              </>
            }
          >
            {(close) => <DeviceList view={view} onChosen={close} />}
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
      {sheet && (
        <NowPlayingSheet
          view={view}
          onClose={() => setSheet(false)}
          onOpenAlbum={openAlbum}
        />
      )}
    </section>
  )
}

/** The player bar; hidden until playback is connected and the account plays or queues something. */
export default function PlayerDock() {
  const view = usePlayback()
  if (!view.enabled || !view.active) return null
  return <Dock view={view} />
}
