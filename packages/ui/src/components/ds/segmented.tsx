import type { ReactNode } from 'react'

/**
 * Switches how one panel is shown (view, range). Tabs switch panels.
 * An option with `icon` and no visible label needs `label` for its name.
 */
export function Segmented<Value extends string>({
  label,
  value,
  options,
  onChange,
  className,
}: {
  label: string
  value: Value
  options: readonly {
    value: Value
    label: string
    icon?: ReactNode
    disabled?: boolean
  }[]
  onChange: (value: Value) => void
  className?: string
}) {
  return (
    <div
      className={className ? `ds-seg ${className}` : 'ds-seg'}
      role="group"
      aria-label={label}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          aria-label={option.icon ? option.label : undefined}
          title={option.icon ? option.label : undefined}
          data-icon={option.icon ? '' : undefined}
          disabled={option.disabled}
          onClick={() => onChange(option.value)}
        >
          {option.icon ?? option.label}
        </button>
      ))}
    </div>
  )
}
