import type { ComponentPropsWithoutRef, ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'

/**
 * One provider's contribution to an item: match, identifier, age and state on
 * the row; what it supplies and its history inside. Clicks on `actions` do
 * not toggle the row.
 */
export function SourceRow({
  mark,
  name,
  match,
  identifier,
  when,
  state,
  actions,
  open,
  onToggle,
  summaryProps,
  children,
}: {
  mark: ReactNode
  name: ReactNode
  match: ReactNode
  identifier?: ReactNode
  when?: ReactNode
  state?: ReactNode
  actions?: ReactNode
  open?: boolean
  onToggle?: (open: boolean) => void
  summaryProps?: ComponentPropsWithoutRef<'summary'>
  children?: ReactNode
}) {
  return (
    <details
      className="ds-source"
      open={open}
      onToggle={(event) => onToggle?.(event.currentTarget.open)}
    >
      <summary {...summaryProps}>
        <ChevronRight className="ds-i" aria-hidden />
        {mark}
        <span className="ds-source-main">
          <span className="ds-source-line">
            <span className="ds-source-name">{name}</span>
            {match}
          </span>
          {identifier != null && identifier !== false && (
            <span className="ds-source-id">{identifier}</span>
          )}
        </span>
        <span className="ds-source-when">
          <span>{when}</span>
          {state}
        </span>
        <span
          className="ds-cell-actions"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          {actions}
        </span>
      </summary>
      {children != null && children !== false && (
        <div className="ds-source-body">{children}</div>
      )}
    </details>
  )
}

/** A labelled block inside an open source row. */
export function SourceBlock({
  title,
  children,
}: {
  title: string
  children: ReactNode
}) {
  return (
    <div>
      <h4>{title}</h4>
      {children}
    </div>
  )
}

export type TimelineItem = {
  key: string
  when: ReactNode
  status: ReactNode
  text: ReactNode
  link?: ReactNode
}

/**
 * Newest first: when, status, what happened, and a link to the job. `wrap` is
 * for items that end in a button: on a phone the text takes its own line.
 */
export function Timeline({
  items,
  wrap = false,
}: {
  items: readonly TimelineItem[]
  wrap?: boolean
}) {
  return (
    <ol className="ds-timeline" data-wrap={wrap ? '' : undefined}>
      {items.map((item) => (
        <li key={item.key}>
          <span className="ds-muted ds-num">{item.when}</span>
          {item.status}
          <span className="ds-truncate">{item.text}</span>
          {item.link ?? <span />}
        </li>
      ))}
    </ol>
  )
}
