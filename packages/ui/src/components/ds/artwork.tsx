import type { CSSProperties, ReactNode } from 'react'
import { cn } from '../../lib/utils'

export type ArtRatio = 'poster' | 'video' | 'round'

/**
 * Artwork for a card or detail header. Square unless `ratio` says otherwise.
 * Children are the image (class `ds-artimg`) or an `ArtFallback`; `badge` is a
 * short label such as a video length; `overlay` is the tile play pair, which
 * sits above the badge when there is one.
 */
export function Art({
  ratio,
  size,
  badge,
  overlay,
  className,
  children,
}: {
  ratio?: ArtRatio
  size?: 'sm'
  badge?: ReactNode
  overlay?: ReactNode
  className?: string
  children: ReactNode
}) {
  const hasBadge = badge != null && badge !== false
  return (
    <span
      className={cn('ds-art', className)}
      data-ratio={ratio}
      data-size={size}
      data-badge={hasBadge ? '' : undefined}
    >
      {children}
      {hasBadge && <span className="ds-art-badge">{badge}</span>}
      {overlay}
    </span>
  )
}

/** Shown when an item has no artwork, or its image failed to load. */
export function ArtFallback({ children }: { children: ReactNode }) {
  return <span className="ds-art-fallback">{children}</span>
}

/** Small artwork in rows and tables: 24px, or 40px in a list row. */
export function Thumb({
  ratio,
  size,
  className,
  children,
}: {
  ratio?: ArtRatio
  size?: number
  className?: string
  children: ReactNode
}) {
  const custom: Record<string, string> = size
    ? { '--ds-thumb': `${size}px` }
    : {}
  const style: CSSProperties = { ...custom }
  return (
    <span
      className={cn('ds-thumb', className)}
      data-ratio={ratio}
      style={style}
    >
      {children}
    </span>
  )
}
