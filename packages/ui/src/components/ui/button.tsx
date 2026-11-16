import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
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

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  icon?: boolean
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant = 'default',
      size = 'sm',
      icon = false,
      asChild = false,
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
        data-icon={icon ? '' : undefined}
        ref={ref}
        {...props}
      />
    )
  },
)
Button.displayName = 'Button'

export { Button }
