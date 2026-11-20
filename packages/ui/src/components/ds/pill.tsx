import { Children, type HTMLAttributes, type ReactNode } from 'react'
import { Slot } from '@radix-ui/react-slot'
import { Globe2, X } from 'lucide-react'
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

export function PillLabel({
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn('ds-pill-label', className)} {...props} />
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

/**
 * A provider's logo in the muted ink, drawn from the shape of its logo file
 * (`src`), or a globe for a provider without one. `hidden` keeps it out of the
 * accessibility tree where a link or text beside it already names the
 * provider.
 */
export function ProviderMark({
  name,
  src,
  size,
  hidden = false,
}: {
  name: string
  src?: string
  size?: 'sm'
  hidden?: boolean
}) {
  const label = hidden
    ? { 'aria-hidden': true }
    : { role: 'img', 'aria-label': name, title: name }
  if (!src)
    return (
      <span className="ds-logo" data-none="" data-size={size} {...label}>
        <Globe2 className="ds-i" data-size="sm" aria-hidden />
      </span>
    )
  const shape: Record<string, string> = { '--ds-logo': `url("${src}")` }
  return (
    <span
      className="ds-logo"
      data-size={size}
      style={{ ...shape }}
      {...label}
    />
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
