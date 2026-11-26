import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import {
  Check,
  CircleAlert,
  Clock,
  Hourglass,
  Layers,
  LoaderCircle,
  X,
} from 'lucide-react'
import { cn } from '../../lib/utils'

/**
 * The one button. `default` is the outlined button; use `primary` for the
 * single main action of a view, `ghost` inside toolbars and rows, `danger`
 * for destructive actions and `link` for an inline text action.
 * Sizes: `xs` 24px inside table rows, `sm` 28px (default), `md` 32px in forms
 * and detail headers. `icon` makes a square icon-only button and needs an
 * `aria-label`.
 */
export type ButtonVariant = 'default' | 'primary' | 'ghost' | 'danger' | 'link'
export type ButtonSize = 'xs' | 'sm' | 'md'

export type ButtonFeedback = {
  phase:
    | 'pending'
    | 'queued'
    | 'running'
    | 'waiting'
    | 'done'
    | 'failed'
    | 'cancelled'
    | 'partial'
    | 'unconfirmed'
  label: string
}

/** For a single request whose response confirms the named result. */
export function mutationFeedback(
  mutation: { isPending: boolean; isSuccess: boolean; isError: boolean },
  labels: { pending: string; success: string; error?: string },
): ButtonFeedback | undefined {
  if (mutation.isPending) return { phase: 'pending', label: labels.pending }
  if (mutation.isError)
    return { phase: 'failed', label: labels.error ?? 'Failed' }
  if (mutation.isSuccess) return { phase: 'done', label: labels.success }
  return undefined
}

const feedbackIcons = {
  pending: Clock,
  queued: Layers,
  running: LoaderCircle,
  waiting: Hourglass,
  done: Check,
  failed: CircleAlert,
  partial: CircleAlert,
  unconfirmed: CircleAlert,
  cancelled: X,
}

export function ButtonFeedbackLabel({
  feedback,
}: {
  feedback: ButtonFeedback
}) {
  const Icon = feedbackIcons[feedback.phase]
  return (
    <>
      <Icon className="ds-i" data-size="sm" aria-hidden="true" />
      <span>{feedback.label}</span>
    </>
  )
}

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  icon?: boolean
  asChild?: boolean
  feedback?: ButtonFeedback
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant = 'default',
      size = 'sm',
      icon = false,
      asChild = false,
      feedback,
      children,
      ...props
    },
    ref,
  ) => {
    const Comp = asChild ? Slot : 'button'
    return (
      <Comp
        className={cn('ds-btn', className)}
        data-variant={variant === 'default' ? undefined : variant}
        data-size={size === 'sm' ? undefined : size}
        data-icon={icon && !feedback ? '' : undefined}
        data-feedback={feedback?.phase}
        ref={ref}
        {...props}
        aria-label={
          feedback &&
          props['aria-label'] &&
          props['aria-label'] !== feedback.label
            ? `${feedback.label} · ${props['aria-label']}`
            : props['aria-label']
        }
        aria-live={props['aria-live'] ?? (feedback ? 'polite' : undefined)}
        aria-busy={
          props['aria-busy'] ??
          (feedback?.phase === 'pending' ||
            feedback?.phase === 'running' ||
            undefined)
        }
      >
        {feedback && !asChild ? (
          <ButtonFeedbackLabel feedback={feedback} />
        ) : (
          children
        )}
      </Comp>
    )
  },
)
Button.displayName = 'Button'

export { Button }
