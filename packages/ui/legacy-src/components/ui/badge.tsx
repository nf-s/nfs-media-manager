import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@repo/ui/lib/utils'

const badgeVariants = cva(
  'inline-flex items-center justify-center rounded-md border px-2 py-0.5 text-xs font-medium w-fit whitespace-nowrap shrink-0 [&>svg]:size-3 gap-1 [&>svg]:pointer-events-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive transition-[color,box-shadow] overflow-hidden',
  {
    variants: {
      variant: {
        default:
          'border-transparent bg-primary text-primary-foreground [a&]:hover:bg-primary/90',
        secondary:
          'border-transparent bg-secondary text-secondary-foreground [a&]:hover:bg-secondary/90',
        dataset:
          'border-transparent bg-dataset text-dataset-foreground [a&]:hover:bg-dataset/90',
        datasetRun:
          'border-transparent bg-datasetRun text-datasetRun-foreground [a&]:hover:bg-datasetRun/90',
        product:
          'border-transparent bg-product text-product-foreground [a&]:hover:bg-product/90',
        productRun:
          'border-transparent bg-productRun text-productRun-foreground [a&]:hover:bg-productRun/90',
        geometries:
          'border-transparent bg-geometry text-geometry-foreground [a&]:hover:bg-geometry/90',
        geometriesRun:
          'border-transparent bg-geometriesRun text-geometriesRun-foreground [a&]:hover:bg-geometriesRun/90',
        indicator:
          'border-transparent bg-indicator text-indicator-foreground [a&]:hover:bg-indicator/90',
        destructive:
          'border-transparent bg-destructive text-white [a&]:hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 dark:bg-destructive/60',
        outline:
          'text-foreground [a&]:hover:bg-accent [a&]:hover:text-accent-foreground',
        value:
          'border-transparent bg-muted text-foreground [a&]:hover:bg-accent [a&]:hover:text-accent-foreground',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
)

export type BadgeProps = React.ComponentProps<'span'> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }

function Badge({
  className,
  variant,
  asChild = false,
  ...props
}: React.ComponentProps<'span'> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : 'span'

  return (
    <Comp
      data-slot="badge"
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  )
}

export { Badge, badgeVariants }
