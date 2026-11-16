'use client'

import React, {
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { Youtube } from 'lucide-react'
import { EMPTY_VALUE } from '@repo/ui/lib/format'
import { Rating } from '@repo/ui/components/ds/pill'
import {
  isCompactRating,
  ratingDescription,
  ratingScore,
  ratingSource,
  safeRatingHref,
  type ProviderRating,
} from '../utils/provider-ratings'
import { youtubeTrailerUrl } from '@repo/schemas/trailer'

const percentScales = new Set([
  'rottentomatoes',
  'rottentomatoes-audience',
  'trakt',
])

/** The score as shown: the source's own scale, with % where it is a percentage. */
function shownScore(rating: ProviderRating) {
  if (rating.score === undefined) return null
  return `${ratingScore(rating)}${percentScales.has(rating.display.provider) ? '%' : ''}`
}

/**
 * One provider rating. Inline it is a neutral `Rating` (short source and
 * score); `card` is the detail overview's rating card. Hover or focus shows
 * the score, scale and vote count; a stored link opens the provider.
 */
export function ProviderRatingBadge({
  rating,
  highlighted = false,
  card = false,
}: {
  rating: ProviderRating
  /** Kept for existing callers; the poster strip is no longer drawn. */
  stacked?: boolean
  highlighted?: boolean
  card?: boolean
}) {
  const id = useId()
  const trigger = useRef<HTMLSpanElement>(null)
  const tooltip = useRef<HTMLSpanElement>(null)
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const open = (hovered || focused) && !dismissed
  const description = `${ratingDescription(rating)}${rating.homepageLink ? ' No film URL stored; opens the provider homepage.' : ''}`
  const href = safeRatingHref(rating.href)
  const source = ratingSource(rating.display, rating.label)
  const score = shownScore(rating)
  const content = card ? (
    <span className="ds-ratingcard">
      <b>{score ?? EMPTY_VALUE}</b>
      <span>{rating.label}</span>
    </span>
  ) : score === null ? (
    <span className="ds-rating">
      <i>{source}</i>
    </span>
  ) : (
    <Rating source={source} value={score} sorted={highlighted} />
  )

  useEffect(() => {
    const content = tooltip.current
    const button = trigger.current
    if (!open || !content || !button) return
    // The top layer escapes virtualized cells' clipping and native dialogs.
    content.showPopover()
    function position() {
      if (!content || !button) return
      const anchor = button.getBoundingClientRect()
      const box = content.getBoundingClientRect()
      content.style.left = `${Math.max(8, Math.min(anchor.left, window.innerWidth - box.width - 8))}px`
      content.style.top = `${Math.max(
        8,
        Math.min(
          anchor.top >= box.height + 8
            ? anchor.top - box.height
            : anchor.bottom,
          window.innerHeight - box.height - 8,
        ),
      )}px`
    }
    position()
    window.addEventListener('scroll', position, true)
    window.addEventListener('resize', position)
    return () => {
      content.hidePopover()
      window.removeEventListener('scroll', position, true)
      window.removeEventListener('resize', position)
    }
  }, [open])

  return (
    <span
      ref={trigger}
      className="browse-rating"
      data-sorted={highlighted || undefined}
      onFocus={() => {
        setFocused(true)
        setDismissed(false)
      }}
      onBlur={() => setFocused(false)}
      onMouseEnter={() => {
        setHovered(true)
        setDismissed(false)
      }}
      onMouseLeave={() => setHovered(false)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') event.stopPropagation()
        if (event.key === 'Escape' && open) {
          event.preventDefault()
          event.stopPropagation()
          setDismissed(true)
        }
      }}
    >
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="browse-rating-link"
          aria-label={`${description} Opens in a new tab.`}
          aria-describedby={open ? id : undefined}
          onClick={(event) => event.stopPropagation()}
        >
          {content}
        </a>
      ) : (
        <button
          type="button"
          className="browse-open"
          aria-label={description}
          aria-describedby={open ? id : undefined}
          onClick={(event) => {
            event.stopPropagation()
            event.currentTarget.focus()
            setDismissed(false)
          }}
        >
          {content}
        </button>
      )}
      <span
        ref={tooltip}
        id={id}
        role="tooltip"
        popover="manual"
        className="browse-tooltip"
      >
        {description}
      </span>
    </span>
  )
}

/**
 * Provider ratings. In cards and rows only the compact sources appear, as
 * neutral inline ratings; the detail overview shows every rating as a card.
 */
export default function ProviderRatings({
  ratings,
  context,
  trailerUrl,
  highlightKey,
  children,
}: {
  ratings: ProviderRating[]
  context: 'poster' | 'table' | 'detail'
  trailerUrl?: string
  highlightKey?: string
  /** Additional provider links shown alongside ratings. */
  children?: ReactNode
}) {
  const detail = context === 'detail'
  const visibleRatings = detail ? ratings : ratings.filter(isCompactRating)
  const trailer = detail ? youtubeTrailerUrl(trailerUrl) : undefined
  if (!visibleRatings.length && !trailer && !children) return null
  return (
    <div
      className={detail ? 'ds-ratings' : 'browse-ratings'}
      role="group"
      aria-label={children ? 'Provider ratings and links' : 'Provider ratings'}
    >
      {visibleRatings.map((rating) => (
        <ProviderRatingBadge
          key={rating.key}
          rating={rating}
          card={detail}
          highlighted={rating.key === highlightKey}
        />
      ))}
      {trailer && (
        <a
          href={trailer}
          target="_blank"
          rel="noopener noreferrer"
          className="ds-btn"
          aria-label="Watch trailer on YouTube. Opens in a new tab."
          title="Watch trailer on YouTube"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ')
              event.stopPropagation()
          }}
        >
          <Youtube className="ds-i" data-size="sm" aria-hidden />
          Trailer
        </a>
      )}
      {children}
    </div>
  )
}
