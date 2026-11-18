import type { HTMLAttributes, ReactNode } from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cn } from '../../lib/utils'

/**
 * List row: 48px with a 40px thumbnail. Tracks in order: thumbnail, title and
 * creator, play pair, tags, values, and an optional trailing action. Wrap rows
 * in `List`; `compact` drops tags and values for narrow containers.
 */
export function ListRow({
  thumb,
  title,
  by,
  play,
  tags,
  meta,
  action,
  selected = false,
  playing = false,
  className,
  ...props
}: Omit<HTMLAttributes<HTMLDivElement>, 'title'> & {
  thumb: ReactNode
  title: ReactNode
  by?: ReactNode
  play?: ReactNode
  tags?: ReactNode
  meta?: ReactNode
  /** Use null to reserve the slot on rows without an action. */
  action?: ReactNode
  selected?: boolean
  playing?: boolean
}) {
  return (
    <div
      className={cn('ds-row', className)}
      aria-selected={selected ? true : undefined}
      data-state={playing ? 'playing' : undefined}
      data-action={action !== undefined ? '' : undefined}
      {...props}
    >
      {thumb}
      <div className="ds-row-main">
        {title}
        <span className="ds-row-by">{by}</span>
      </div>
      {play ?? <span />}
      <div className="ds-row-tags">{tags}</div>
      <div className="ds-row-meta">{meta}</div>
      {action}
    </div>
  )
}

/** Makes its child (a link or button) the row's title. */
export function RowTitle({ children }: { children: ReactNode }) {
  return <Slot className="ds-row-title">{children}</Slot>
}

export function List({
  compact = false,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement> & { compact?: boolean }) {
  return (
    <div
      className={cn('ds-list', className)}
      data-compact={compact ? '' : undefined}
      {...props}
    />
  )
}

/**
 * One trailing value in a row or list head. The width classes keep values
 * aligned down the list: `rating` 64px, `num` 60px, `date` 76px, `spark` 72px.
 */
export function RowValue({
  kind,
  children,
}: {
  kind: 'rating' | 'num' | 'date' | 'spark'
  children?: ReactNode
}) {
  return <span className={`ds-w-${kind}`}>{children}</span>
}

/** Column labels above a list, on the same tracks as the rows. */
export function ListHead({
  title,
  tags,
  meta,
  thumbWidth = 40,
  playWidth = 50,
  action = false,
}: {
  title: ReactNode
  tags?: ReactNode
  meta?: ReactNode
  thumbWidth?: number
  playWidth?: number
  action?: boolean
}) {
  return (
    <div className="ds-listhead" data-action={action ? '' : undefined}>
      <span style={{ width: thumbWidth }} />
      <span>{title}</span>
      <span style={{ width: playWidth }} />
      <span>{tags}</span>
      <div className="ds-row-meta">{meta}</div>
    </div>
  )
}
