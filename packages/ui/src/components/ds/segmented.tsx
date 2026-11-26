import type { ReactNode } from 'react'
import { ButtonFeedbackLabel, type ButtonFeedback } from '../ui/button'

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
  feedbackFor,
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
  feedbackFor?: (value: Value) => ButtonFeedback | undefined
}) {
  return (
    <div
      className={className ? `ds-seg ${className}` : 'ds-seg'}
      role="group"
      aria-label={label}
    >
      {options.map((option) => {
        const feedback = feedbackFor?.(option.value)
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={option.value === value}
            aria-label={
              feedback
                ? `${feedback.label} · ${option.label}`
                : option.icon
                  ? option.label
                  : undefined
            }
            aria-live={feedback ? 'polite' : undefined}
            data-feedback={feedback?.phase}
            title={option.icon ? option.label : undefined}
            data-icon={option.icon && !feedback ? '' : undefined}
            disabled={option.disabled}
            onClick={() => onChange(option.value)}
          >
            {feedback ? (
              <ButtonFeedbackLabel feedback={feedback} />
            ) : (
              (option.icon ?? option.label)
            )}
          </button>
        )
      })}
    </div>
  )
}
