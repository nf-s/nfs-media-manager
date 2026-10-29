import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../../lib/utils'

const badgeVariants = cva(
  'inline-flex items-center border px-2 py-0.5 text-[11px] font-medium uppercase tracking-[0.08em]',
  {
    variants: {
      variant: {
        default:
          'rounded-none border-transparent bg-[hsl(var(--secondary))] text-[hsl(var(--secondary-foreground))]',
        secondary:
          'rounded-full border-transparent bg-[hsl(var(--secondary))] text-[hsl(var(--foreground))]',
        outline:
          'rounded-none border-[hsl(var(--border))] bg-transparent text-[hsl(var(--foreground))]',
        accent:
          'rounded-none border-transparent bg-[hsl(var(--accent))] text-[hsl(var(--accent-foreground))]',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />
}
