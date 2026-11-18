import type { CSSProperties, ReactNode } from 'react'
import { Info, TriangleAlert } from 'lucide-react'
import { cn } from '../../lib/utils'

/**
 * A message with at most one action. `attention` for something the owner
 * should act on, `danger` for a failure.
 * `icon={false}` leaves the icon out, for a plain statement.
 */
export function Notice({
  tone,
  icon,
  action,
  className,
  children,
}: {
  tone?: 'attention' | 'danger'
  icon?: ReactNode
  action?: ReactNode
  className?: string
  children: ReactNode
}) {
  return (
    <div
      className={cn('ds-notice', className)}
      data-tone={tone}
      role={tone === 'danger' ? 'alert' : 'status'}
    >
      {icon ??
        (tone ? (
          <TriangleAlert className="ds-i" data-size="sm" aria-hidden />
        ) : (
          <Info className="ds-i" data-size="sm" aria-hidden />
        ))}
      <span>{children}</span>
      {action}
    </div>
  )
}

/**
 * Empty, no-match and error states. Wording: "No albums yet" with an Import
 * action, "No albums match" with Clear filters, "Could not load albums" with
 * Retry.
 */
export function State({
  title,
  children,
  action,
  size,
  error = false,
  className,
}: {
  title: string
  children?: ReactNode
  action?: ReactNode
  size?: 'sm'
  error?: boolean
  className?: string
}) {
  return (
    <div
      className={cn('ds-state', className)}
      data-size={size}
      role={error ? 'alert' : 'status'}
    >
      <strong>{title}</strong>
      {children != null && children !== false && <span>{children}</span>}
      {action}
    </div>
  )
}

/** A placeholder the size of the content it stands for. Never "Loading…". */
export function Skeleton({
  width,
  height,
  className,
  style,
}: {
  width?: number | string
  height?: number | string
  className?: string
  style?: CSSProperties
}) {
  return (
    <div
      className={cn('ds-skel', className)}
      style={{ width, height, ...style }}
      aria-hidden="true"
    />
  )
}
