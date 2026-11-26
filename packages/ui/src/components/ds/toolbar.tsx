import type {
  ButtonHTMLAttributes,
  ComponentProps,
  ReactNode,
  SelectHTMLAttributes,
} from 'react'
import { formatCount } from '../../lib/format'
import { cn } from '../../lib/utils'
import { Button, type ButtonFeedback } from '../ui/button'
import { Count } from './pill'

/**
 * Toolbar above a list. Browse order: search, sort, direction, view, filters,
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

/**
 * A toolbar button that switches the list below it to another view of the
 * same rows and back (`aria-pressed`): an icon, the label, then `count`, how
 * many the view holds.
 */
export function ToolbarToggle({
  pressed,
  onPressedChange,
  icon,
  iconButton,
  count,
  children,
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick' | 'aria-pressed'> & {
  pressed: boolean
  onPressedChange: (pressed: boolean) => void
  icon: ReactNode
  iconButton?: boolean
  feedback?: ButtonFeedback
  count?: number
}) {
  return (
    <Button
      type="button"
      aria-pressed={pressed}
      icon={iconButton}
      onClick={() => onPressedChange(!pressed)}
      {...props}
    >
      {icon}
      {children}
      {count !== undefined && <Count>{formatCount(count)}</Count>}
    </Button>
  )
}

/**
 * The line under the toolbar of a list inside a detail: the active filters
 * and Clear all, then the count (`ToolbarCount`) and the link to the same
 * result in Browse.
 */
export function FilterLine({ children }: { children: ReactNode }) {
  return <div className="ds-filterline">{children}</div>
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
