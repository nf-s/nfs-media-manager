import type { ReactNode } from 'react'
import { formatCount } from '../../lib/format'

type Tone = 'attention' | 'danger'

function percent(done: number, total: number) {
  return total > 0
    ? Math.max(0, Math.min(100, Math.round((done / total) * 100)))
    : 0
}

export function Meter({ value, tone }: { value: number; tone?: Tone }) {
  return (
    <div className="ds-meter" data-tone={tone}>
      <i style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  )
}

/** Progress through a known total. `compact` shows a percentage for table cells. */
export function Progress({
  done,
  total,
  compact = false,
  tone,
}: {
  done: number
  total: number
  compact?: boolean
  tone?: Tone
}) {
  const full = `${formatCount(done)} of ${formatCount(total)}`
  return (
    <div
      className="ds-progress"
      title={compact ? full : undefined}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={done}
      aria-valuetext={full}
    >
      <Meter value={percent(done, total)} tone={tone} />
      <span>
        {compact
          ? `${percent(done, total)}%`
          : `${formatCount(done)} / ${formatCount(total)}`}
      </span>
    </div>
  )
}

/** One provider's coverage of a set: label, meter, count and the gap's action. */
export function Coverage({
  label,
  have,
  total,
  tone,
  action,
}: {
  label: ReactNode
  have: number
  total: number
  tone?: Tone
  /** The button that closes the gap. Omit when coverage is complete. */
  action?: ReactNode
}) {
  return (
    <div className="ds-coverage">
      <span>{label}</span>
      <Meter value={percent(have, total)} tone={tone} />
      <span className="ds-muted ds-num">
        {formatCount(have)} of {formatCount(total)}
      </span>
      {action ?? <span className="ds-muted ds-coverage-done">Complete</span>}
    </div>
  )
}
