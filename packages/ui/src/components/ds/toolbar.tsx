import type { ComponentProps, ReactNode, SelectHTMLAttributes } from 'react'
import { cn } from '../../lib/utils'

/**
 * Toolbar above a list. Browse order: search, sort, direction, filters, view,
 * count. Table-only order: search, count, then Columns at the far end
 * (`ToolbarEnd`).
 */
export function Toolbar({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('ds-toolbar', className)} {...props} />
}

export function ToolbarCount({ children }: { children: ReactNode }) {
  return (
    <span className="ds-toolbar-count" role="status">
      {children}
    </span>
  )
}

export function ToolbarEnd({ children }: { children: ReactNode }) {
  return <span className="ds-toolbar-end ds-actions">{children}</span>
}

/** Title row of an admin page: title, optional note, actions at the end. */
export function PageHead({
  title,
  note,
  actions,
}: {
  title: string
  note?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="ds-pagehead">
      <h1>{title}</h1>
      {note != null && note !== false && <p>{note}</p>}
      {actions != null && actions !== false && (
        <span className="ds-toolbar-end ds-actions">{actions}</span>
      )}
    </div>
  )
}

export function Select({
  className,
  controlSize,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & { controlSize?: 'md' }) {
  return (
    <select
      className={cn('ds-select', className)}
      data-size={controlSize}
      {...props}
    />
  )
}
