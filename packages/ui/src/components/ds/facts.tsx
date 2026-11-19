import type { ReactNode } from 'react'
import { cn } from '../../lib/utils'
import { Sparkline } from './trend-chart'

type Item = { label: string; value: ReactNode }

/** A grid of labelled facts: label above, value below. At most six per group. */
export function Facts({ items }: { items: readonly Item[] }) {
  return (
    <dl className="ds-facts">
      {items.map((item) => (
        <div key={item.label}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  )
}

/** A two-column list of every field: label left, value right. */
export function KeyValues({ items }: { items: readonly Item[] }) {
  return (
    <dl className="ds-kv">
      {items.map((item) => (
        <div key={item.label} className="contents">
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  )
}

/** Counts per period, oldest first, and what they show in words. */
export type StatTrend = { values: readonly number[]; label: string }

export type StatItem = {
  label: string
  value: ReactNode
  tone?: 'attention' | 'danger'
  /** A sparkline beside the value. */
  trend?: StatTrend
  /** The figure in full, shown on hover. */
  title?: string
  /** The page the figure comes from. The whole stat opens it in a new tab. */
  href?: string
}

/**
 * Headline figures. Four at most; one may carry a sparkline. A figure taken
 * from another site may link to its page there and looks like the others.
 */
export function Stats({ items }: { items: readonly StatItem[] }) {
  return (
    <div className="ds-stats">
      {items.map((item) => {
        const content = (
          <>
            <span className="ds-stat-value">
              {item.value}
              {item.trend && (
                <Sparkline
                  values={item.trend.values}
                  label={item.trend.label}
                />
              )}
            </span>
            <span className="ds-stat-label">{item.label}</span>
          </>
        )
        return item.href ? (
          <a
            key={item.label}
            className="ds-stat"
            data-tone={item.tone}
            href={item.href}
            target="_blank"
            rel="noopener noreferrer"
            title={item.title}
            aria-label={`${item.title ?? `${item.label}.`} Opens in a new tab.`}
          >
            {content}
          </a>
        ) : (
          <div
            key={item.label}
            className="ds-stat"
            data-tone={item.tone}
            title={item.title}
          >
            {content}
          </div>
        )
      })}
    </div>
  )
}

/** A titled block in an overview. `aside` sits at the end of the heading. */
export function Section({
  title,
  note,
  aside,
  flush = false,
  className,
  children,
}: {
  title?: string
  note?: ReactNode
  aside?: ReactNode
  flush?: boolean
  className?: string
  children: ReactNode
}) {
  return (
    <section
      className={cn('ds-section', className)}
      data-flush={flush ? '' : undefined}
    >
      {title && (
        <div className="ds-section-head">
          <h3>{title}</h3>
          {note != null && note !== false && (
            <span className="ds-muted">{note}</span>
          )}
          {aside != null && aside !== false && (
            <span className="ds-section-aside">{aside}</span>
          )}
        </div>
      )}
      {children}
    </section>
  )
}
