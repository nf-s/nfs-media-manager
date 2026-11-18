import { formatCount } from '../../lib/format'
import { cn } from '../../lib/utils'

export type HistogramBar = {
  /** The lowest value of the range the bar stands for: "0", "10+". */
  label: string
  /** The range and its count in words, read out and shown on hover. */
  title: string
  /** `selected`: wholly inside the chosen range. `partial`: partly inside. */
  state?: 'selected' | 'partial'
}

/**
 * How many items fall in each range, with the bars as the control that sets
 * the range. The count sits above each bar and the range below it. Heights
 * follow the square root of the count so a small bar is still visible. Omit
 * `counts` while they load.
 */
export function Histogram({
  label,
  bars,
  counts,
  onSelect,
  className,
}: {
  label: string
  bars: readonly HistogramBar[]
  counts?: readonly number[]
  onSelect: (index: number) => void
  className?: string
}) {
  const top = Math.max(1, ...(counts ?? []))
  return (
    <div className={cn('ds-hist', className)} role="group" aria-label={label}>
      {bars.map((bar, index) => {
        const count = counts?.[index]
        return (
          <button
            key={bar.label}
            type="button"
            className="ds-hist-bar"
            aria-pressed={bar.state === 'selected'}
            aria-label={bar.title}
            title={bar.title}
            data-partial={bar.state === 'partial' ? '' : undefined}
            onClick={() => onSelect(index)}
          >
            <span className="ds-hist-count">
              {count === undefined ? '' : formatCount(count)}
            </span>
            {count === undefined ? (
              <span className="ds-hist-track ds-skel" />
            ) : (
              <span className="ds-hist-track">
                <i
                  style={{
                    height: `${Math.round(Math.sqrt(count / top) * 100)}%`,
                  }}
                />
              </span>
            )}
            <span>{bar.label}</span>
          </button>
        )
      })}
    </div>
  )
}
