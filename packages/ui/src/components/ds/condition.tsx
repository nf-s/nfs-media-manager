import type { HTMLAttributes } from 'react'
import { cn } from '../../lib/utils'

/**
 * One rule of a filter in an outlined card. Its lines read as a sentence:
 * the first says how much, the second says when, then Remove.
 */
export function Condition({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('ds-cond', className)} {...props} />
}

/** A line of words and controls, inside a condition or on its own. */
export function ConditionLine({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('ds-cond-line', className)} {...props} />
}
