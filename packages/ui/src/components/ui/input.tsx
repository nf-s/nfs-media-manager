import * as React from 'react'
import { cn } from '../../lib/utils'

/** Text input: 28px by default, `controlSize="md"` (32px) in forms. */
export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement> & { controlSize?: 'sm' | 'md' }
>(({ className, type, controlSize = 'sm', ...props }, ref) => (
  <input
    type={type}
    className={cn('ds-input w-full', className)}
    data-size={controlSize === 'md' ? 'md' : undefined}
    ref={ref}
    {...props}
  />
))
Input.displayName = 'Input'
