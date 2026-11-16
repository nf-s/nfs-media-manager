import type { HTMLAttributes, ReactNode } from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cn } from '../../lib/utils'

/**
 * Grid card: clean artwork, title, creator, one meta line and one line of
 * tags. `meta` takes up to two values: the first sits left (year, count) and
 * the last sits right (one rating, or the value the grid is sorted by).
 */
export function Card({
  art,
  title,
  by,
  meta,
  tags,
  selected = false,
  playing = false,
  className,
  ...props
}: Omit<HTMLAttributes<HTMLElement>, 'title'> & {
  art: ReactNode
  title: ReactNode
  by?: ReactNode
  meta?: ReactNode
  tags?: ReactNode
  selected?: boolean
  playing?: boolean
}) {
  return (
    <article
      className={cn('ds-card', className)}
      aria-selected={selected ? true : undefined}
      data-state={playing ? 'playing' : undefined}
      {...props}
    >
      {art}
      {title}
      {by != null && by !== false && <span className="ds-card-by">{by}</span>}
      {meta != null && meta !== false && (
        <span className="ds-card-meta">{meta}</span>
      )}
      {tags}
    </article>
  )
}

/** Makes its child (a link or button) the card's title. */
export function CardTitle({ children }: { children: ReactNode }) {
  return <Slot className="ds-card-title">{children}</Slot>
}

/** The responsive grid cards sit in. `min` is the smallest card width in px. */
export function CardGrid({
  min,
  className,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement> & { min?: number }) {
  const custom: Record<string, string> = min
    ? { '--ds-card-min': `${min}px` }
    : {}
  return (
    <div className={cn('ds-grid', className)} style={{ ...custom }} {...props}>
      {children}
    </div>
  )
}
