import {
  forwardRef,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from 'react'
import { Ellipsis, ListPlus, Pause, Play } from 'lucide-react'
import { Button, type ButtonFeedback } from '../ui/button'

type PlayFeedback = {
  playFeedback?: ButtonFeedback
  queueFeedback?: ButtonFeedback
  playDisabled?: boolean
  queueDisabled?: boolean
}

/**
 * Actions on Browse artwork or at the end of a row's identity. An item that
 * cannot be played holds a `MoreButton` alone here, where the group would be.
 */
export function BrowseActions({
  place,
  children,
}: {
  place: 'tile' | 'row'
  children: ReactNode
}) {
  return (
    <span className="ds-play" data-place={place}>
      {children}
    </span>
  )
}

type MoreButtonProps = Omit<
  ComponentPropsWithoutRef<'button'>,
  'title' | 'children' | 'type'
> & {
  /** The item's name, used in the button's accessible name. */
  title: string
  /** Whether its menu, or a popover opened from it, is showing. */
  expanded?: boolean
  /** `ghost` outside a play group, as after the player's title. */
  variant?: 'ghost'
}

/**
 * More actions for one item: the last control of the play group, or alone in
 * `BrowseActions` for an item that cannot be played. It opens a menu; a click
 * or key on it never reaches the row or card that holds it.
 */
export const MoreButton = forwardRef<HTMLButtonElement, MoreButtonProps>(
  function MoreButton(
    { title, expanded = false, onClick, onDoubleClick, onKeyDown, ...props },
    ref,
  ) {
    return (
      <Button
        ref={ref}
        type="button"
        size="xs"
        icon
        aria-label={`More actions for ${title}`}
        title="More actions"
        aria-haspopup="menu"
        aria-expanded={expanded}
        {...props}
        onClick={(event) => {
          event.stopPropagation()
          onClick?.(event)
        }}
        onDoubleClick={(event) => {
          event.stopPropagation()
          onDoubleClick?.(event)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ')
            event.stopPropagation()
          onKeyDown?.(event)
        }}
      >
        <Ellipsis className="ds-i" data-size="sm" data-dots="" aria-hidden />
      </Button>
    )
  },
)

/**
 * The only control that plays. Order is always Play, then Queue, then More
 * (`more`, a `MoreButton` with its menu), then any provider marks
 * (`afterQueue`).
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
  playFeedback,
  queueFeedback,
  playDisabled = false,
  queueDisabled = false,
  onPlay,
  onQueue,
  more,
  afterQueue,
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
  /** More actions, right after Queue. It stays enabled when the pair is not. */
  more?: ReactNode
  /** Provider marks, after the group. */
  afterQueue?: ReactNode
  /** Replaces the default icons, for example a "now playing" indicator. */
  children?: ReactNode
} & PlayFeedback) {
  const verb = playing ? 'Pause' : 'Play'
  const suffix = disabled && disabledReason ? `: ${disabledReason}` : ''
  return (
    <BrowseActions place={place}>
      <Button
        type="button"
        size="xs"
        icon
        aria-label={`${verb} ${title}${suffix}`}
        title={disabled ? disabledReason : `${verb} ${title}`}
        aria-pressed={playing}
        disabled={disabled || playDisabled}
        feedback={playFeedback}
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
      </Button>
      <Button
        type="button"
        size="xs"
        icon
        aria-label={`Add ${title} to queue${suffix}`}
        title={disabled ? disabledReason : `Add ${title} to queue`}
        disabled={disabled || queueDisabled}
        feedback={queueFeedback}
        onClick={(event) => {
          event.stopPropagation()
          onQueue()
        }}
      >
        <ListPlus className="ds-i" data-size="sm" aria-hidden />
      </Button>
      {more}
      {afterQueue}
    </BrowseActions>
  )
}

/**
 * The same pair for a detail header, under the artwork: a labelled Play that
 * takes the artwork's width and a square Queue button. More stays in the
 * header's actions.
 */
export function PlayHeaderButtons({
  title,
  playing = false,
  disabled = false,
  disabledReason,
  playFeedback,
  queueFeedback,
  playDisabled = false,
  queueDisabled = false,
  onPlay,
  onQueue,
}: {
  title: string
  playing?: boolean
  disabled?: boolean
  disabledReason?: string
  onPlay: () => void
  onQueue: () => void
} & PlayFeedback) {
  return (
    <>
      <Button
        variant="primary"
        size="md"
        disabled={disabled || playDisabled}
        feedback={playFeedback}
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
        disabled={disabled || queueDisabled}
        feedback={queueFeedback}
        title={disabled ? disabledReason : 'Add to queue'}
        aria-label={`Add ${title} to queue`}
        onClick={onQueue}
      >
        <ListPlus className="ds-i" data-size="sm" aria-hidden />
      </Button>
    </>
  )
}
