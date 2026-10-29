'use client'

import React, { useEffect, useId, useRef, useState } from 'react'
import {
  metascoreTone,
  isCompactRating,
  providerIconUrl,
  ratingDescription,
  ratingScore,
  safeRatingHref,
  type ProviderRating,
} from '../utils/provider-ratings'
import { youtubeTrailerUrl } from '@repo/schemas/trailer'

function ProviderMark({ rating }: { rating: ProviderRating }) {
  const [failedIcon, setFailedIcon] = useState<string>()
  const provider = rating.display.provider
  const icon = providerIconUrl(provider, rating.display.iconUrl)
  if (icon && failedIcon !== icon)
    return (
      <img
        className={`rating-icon ${provider === 'imdb' ? 'rating-imdb' : ''}`}
        src={icon}
        alt=""
        width={provider === 'imdb' ? 26 : 14}
        height={14}
        onError={() => setFailedIcon(icon)}
      />
    )
  return (
    <span className="rating-label">
      {rating.display.shortLabel ?? (provider === 'rym' ? 'RYM' : rating.label)}
    </span>
  )
}

export function ProviderRatingBadge({
  rating,
  stacked = false,
}: {
  rating: ProviderRating
  stacked?: boolean
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
  const metascore =
    rating.display.provider === 'metacritic' && rating.score !== undefined
  const toneClasses = {
    positive: 'rating-positive',
    mixed: 'rating-mixed',
    negative: 'rating-negative',
  }
  const metascoreClassName = `rating-metascore ${toneClasses[metascoreTone(rating.score ?? 0)]}`
  const badgeClassName = `rating-badge ${metascore && !href && !stacked ? metascoreClassName : ''}${href ? ' cursor-pointer' : ''}`
  const badgeContent = (
    <>
      {(!metascore || stacked) && <ProviderMark rating={rating} />}
      {(rating.score !== undefined || stacked) && (
        <span
          className={`rating-score ${metascore && (href || stacked) ? `inline-flex items-center justify-center ${metascoreClassName}` : ''}`}
          aria-hidden="true"
        >
          {rating.score === undefined ? '—' : ratingScore(rating)}
          {rating.score !== undefined &&
          ['rottentomatoes', 'rottentomatoes-audience', 'trakt'].includes(
            rating.display.provider,
          )
            ? '%'
            : ''}
        </span>
      )}
    </>
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
      className="rating-anchor"
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
          className={badgeClassName}
          aria-label={`${description} Opens in a new tab.`}
          aria-describedby={open ? id : undefined}
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
        >
          {badgeContent}
        </a>
      ) : (
        <button
          type="button"
          className={badgeClassName}
          aria-label={description}
          aria-describedby={open ? id : undefined}
          onClick={(event) => {
            event.stopPropagation()
            event.currentTarget.focus()
            setDismissed(false)
          }}
          onDoubleClick={(event) => event.stopPropagation()}
        >
          {badgeContent}
        </button>
      )}
      <span
        ref={tooltip}
        id={id}
        role="tooltip"
        popover="manual"
        className="rating-tooltip"
      >
        {description}
      </span>
    </span>
  )
}

export default function ProviderRatings({
  ratings,
  context,
  trailerUrl,
}: {
  ratings: ProviderRating[]
  context: 'poster' | 'table' | 'detail'
  trailerUrl?: string
}) {
  const visibleRatings =
    context === 'detail' ? ratings : ratings.filter(isCompactRating)
  const trailer =
    context === 'detail' ? youtubeTrailerUrl(trailerUrl) : undefined
  if (!visibleRatings.length && !trailer) return null
  const contextClasses = {
    poster: 'ratings-poster',
    table: 'ratings-table',
    detail: 'ratings-detail',
  }
  return (
    <div
      className={`provider-ratings ${contextClasses[context]}`}
      role="group"
      aria-label="Provider ratings"
    >
      {visibleRatings.map((rating) => (
        <ProviderRatingBadge
          key={rating.key}
          rating={rating}
          stacked={context === 'poster'}
        />
      ))}
      {trailer && (
        <a
          href={trailer}
          target="_blank"
          rel="noopener noreferrer"
          className="rating-badge cursor-pointer"
          aria-label="Watch trailer on YouTube. Opens in a new tab."
          title="Watch trailer on YouTube"
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ')
              event.stopPropagation()
          }}
        >
          <img src="/icons/ratings/youtube.svg" alt="" width={20} height={14} />
        </a>
      )}
    </div>
  )
}
