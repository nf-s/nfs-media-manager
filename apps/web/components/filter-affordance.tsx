import type { ComponentPropsWithoutRef } from 'react'
import { Filter } from 'lucide-react'

export function FilterIndicator() {
  return (
    <Filter className="ds-i browse-filter-mark" data-size="sm" aria-hidden />
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
