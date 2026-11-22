import type { ReactNode } from 'react'

/**
 * The levels after a change: unticking Auto ticks `defaults`, and unticking
 * the last level returns to Auto. `undefined` is Auto.
 */
export function nextTagLocation<Level extends string>(
  order: readonly Level[],
  current: readonly Level[] | undefined,
  change: { auto: boolean } | { level: Level; on: boolean },
  defaults: readonly Level[],
): Level[] | undefined {
  if ('auto' in change) return change.auto ? undefined : [...defaults]
  const ticked = order.filter((level) =>
    level === change.level ? change.on : (current ?? []).includes(level),
  )
  return ticked.length ? ticked : undefined
}

/**
 * Where a list's Tags filters read tags: Auto, or any combination of the
 * levels. The levels are disabled while Auto is ticked. `hint` says what the
 * current choice matches.
 */
export function TagLocation<Level extends string>({
  label = 'Tag location',
  levels,
  value,
  defaults,
  hint,
  onChange,
}: {
  label?: string
  levels: readonly { value: Level; label: string }[]
  /** The ticked levels; `undefined` is Auto. */
  value: readonly Level[] | undefined
  /** Ticked when Auto is unticked. */
  defaults: readonly Level[]
  hint?: ReactNode
  onChange: (value: Level[] | undefined) => void
}) {
  const auto = value === undefined
  const order = levels.map((level) => level.value)
  return (
    <div className="ds-levels" role="group" aria-label={label}>
      <label className="ds-checkrow">
        <input
          type="checkbox"
          className="ds-check"
          checked={auto}
          onChange={(event) =>
            onChange(
              nextTagLocation(
                order,
                value,
                { auto: event.currentTarget.checked },
                defaults,
              ),
            )
          }
        />
        Auto: most detailed
      </label>
      <div className="ds-levels" data-indent="">
        {levels.map((level) => (
          <label className="ds-checkrow" key={level.value}>
            <input
              type="checkbox"
              className="ds-check"
              checked={!auto && value.includes(level.value)}
              disabled={auto}
              onChange={(event) =>
                onChange(
                  nextTagLocation(
                    order,
                    value,
                    { level: level.value, on: event.currentTarget.checked },
                    defaults,
                  ),
                )
              }
            />
            {level.label}
          </label>
        ))}
      </div>
      {hint && <span className="ds-muted">{hint}</span>}
    </div>
  )
}
