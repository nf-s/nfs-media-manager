import type { ComponentPropsWithoutRef } from 'react'
import { Filter } from 'lucide-react'

export function FilterIndicator() {
  return (
    <Filter
      size={11}
      className="mr-1 inline-block shrink-0 align-middle opacity-60"
      aria-hidden="true"
    />
  )
}

export function FilterButton({
  children,
  ...props
}: ComponentPropsWithoutRef<'button'>) {
  return (
    <button type="button" {...props}>
      {children}
    </button>
  )
}
