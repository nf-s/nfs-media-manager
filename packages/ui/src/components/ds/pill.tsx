import { Children, type HTMLAttributes, type ReactNode } from 'react'
import { Slot } from '@radix-ui/react-slot'
import { X } from 'lucide-react'
import { cn } from '../../lib/utils'
import { EMPTY_VALUE } from '../../lib/format'

export type PillMode = 'any' | 'required' | 'exclude'

/**
 * One pill shape for tags, filters and small labels. Pass `asChild` to make
 * a link or button the pill itself; wrap its text in `PillLabel` so a long
 * label shortens with an ellipsis.
 */
export function Pill({
  mode,
  tone,
  size,
  icon,
  removable = false,
  asChild = false,
  className,
  children,
  ...props
}: HTMLAttributes<HTMLElement> & {
  mode?: PillMode
  tone?: 'attention' | 'outline'
  size?: 'md'
  icon?: ReactNode
  removable?: boolean
  asChild?: boolean
}) {
  const shared = {
    className: cn('ds-pill', className),
    'data-mode': mode,
    'data-tone': tone,
    'data-size': size,
    ...props,
  }
  if (asChild) return <Slot {...shared}>{children}</Slot>
  return (
    <span {...shared}>
      {icon}
      <PillLabel>{children}</PillLabel>
      {removable && <X className="ds-i" aria-hidden="true" />}
    </span>
  )
}

export function PillLabel({ children }: { children: ReactNode }) {
  return <span className="ds-pill-label">{children}</span>
}

/**
 * A row of pills that is never clipped: the first `max` and a `+N` counter.
 * With `wrap` every pill is shown and the row wraps.
 */
export function Pills({
  children,
  max,
  wrap = false,
  className,
  label,
}: {
  children: ReactNode
  max?: number
  wrap?: boolean
  className?: string
  label?: string
}) {
  const items = Children.toArray(children)
  const shown = max === undefined || wrap ? items : items.slice(0, max)
  const rest = items.length - shown.length
  return (
    <span
      className={cn('ds-pills', className)}
      data-wrap={wrap ? '' : undefined}
      role={label ? 'group' : undefined}
      aria-label={label}
    >
      {shown}
      {rest > 0 && (
        <span className="ds-more" title={`${rest} more`}>
          +{rest}
        </span>
      )}
    </span>
  )
}

export function Count({
  children,
  tone,
}: {
  children: ReactNode
  tone?: 'attention' | 'danger'
}) {
  return (
    <span className="ds-count" data-tone={tone}>
      {children}
    </span>
  )
}

/** A provider's glyph, or its two-letter mark, in a fixed neutral box. */
export function ProviderMark({
  name,
  children,
}: {
  name: string
  children: ReactNode
}) {
  return (
    <span className="ds-mark" title={name}>
      {children}
    </span>
  )
}

/** The en dash shown for a value that is not known. */
export function EmptyValue() {
  return <span className="ds-empty-value">{EMPTY_VALUE}</span>
}

/**
 * A score with its source: a short neutral label and the value in the
 * monospace face. `sorted` marks the rating the list is ordered by.
 */
export function Rating({
  source,
  value,
  sorted = false,
  title,
}: {
  source: string
  value: ReactNode | null | undefined
  sorted?: boolean
  title?: string
}) {
  if (value === null || value === undefined || value === '')
    return <EmptyValue />
  return (
    <span
      className="ds-rating"
      data-sorted={sorted ? '' : undefined}
      title={title}
    >
      <i>{source}</i>
      {value}
    </span>
  )
}
