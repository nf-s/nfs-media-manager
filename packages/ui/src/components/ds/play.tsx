import type { ReactNode } from 'react'
import { ListPlus, Pause, Play } from 'lucide-react'
import { Button } from '../ui/button'

/**
 * The only control that plays. Order is always Play, then Queue.
 *
 * `tile` floats on artwork (hover, focus, touch, or while playing).
 * `row` sits at the end of a title cell (row hover or focus; always on touch).
 * For a detail header use `PlayHeaderButtons`.
 *
 * Artwork and titles open the item; they never play it.
 */
export function PlayPair({
  place,
  title,
  playing = false,
  disabled = false,
  disabledReason,
  onPlay,
  onQueue,
  children,
}: {
  place: 'tile' | 'row'
  /** The item's name, used in the buttons' accessible names. */
  title: string
  playing?: boolean
  disabled?: boolean
  disabledReason?: string
  onPlay: () => void
  onQueue: () => void
  /** Replaces the default icons, for example a "now playing" indicator. */
  children?: ReactNode
}) {
  const verb = playing ? 'Pause' : 'Play'
  const suffix = disabled && disabledReason ? `: ${disabledReason}` : ''
  return (
    <span className="ds-play" data-place={place}>
      <button
        type="button"
        aria-label={`${verb} ${title}${suffix}`}
        title={disabled ? disabledReason : `${verb} ${title}`}
        aria-pressed={playing}
        disabled={disabled}
        onClick={(event) => {
          event.stopPropagation()
          onPlay()
        }}
      >
        {children ??
          (playing ? (
            <Pause className="ds-i" data-size="sm" data-fill="" aria-hidden />
          ) : (
            <Play className="ds-i" data-size="sm" data-fill="" aria-hidden />
          ))}
      </button>
      <button
        type="button"
        aria-label={`Add ${title} to queue${suffix}`}
        title={disabled ? disabledReason : `Add ${title} to queue`}
        disabled={disabled}
        onClick={(event) => {
          event.stopPropagation()
          onQueue()
        }}
      >
        <ListPlus className="ds-i" data-size="sm" aria-hidden />
      </button>
    </span>
  )
}

/**
 * The same pair for a detail header, under the artwork: a labelled Play that
 * takes the artwork's width and a square Queue button.
 */
export function PlayHeaderButtons({
  title,
  playing = false,
  disabled = false,
  disabledReason,
  onPlay,
  onQueue,
}: {
  title: string
  playing?: boolean
  disabled?: boolean
  disabledReason?: string
  onPlay: () => void
  onQueue: () => void
}) {
  return (
    <>
      <Button
        variant="primary"
        size="md"
        disabled={disabled}
        title={disabled ? disabledReason : undefined}
        aria-label={`${playing ? 'Pause' : 'Play'} ${title}`}
        onClick={onPlay}
      >
        {playing ? (
          <Pause className="ds-i" data-size="sm" data-fill="" aria-hidden />
        ) : (
          <Play className="ds-i" data-size="sm" data-fill="" aria-hidden />
        )}
        {playing ? 'Pause' : 'Play'}
      </Button>
      <Button
        size="md"
        icon
        disabled={disabled}
        title={disabled ? disabledReason : 'Add to queue'}
        aria-label={`Add ${title} to queue`}
        onClick={onQueue}
      >
        <ListPlus className="ds-i" data-size="sm" aria-hidden />
      </Button>
    </>
  )
}
