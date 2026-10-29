import React, { type ComponentPropsWithoutRef } from 'react'
import { ArrowUpRight } from 'lucide-react'

export default function ExternalLink({
  children,
  ...props
}: Omit<ComponentPropsWithoutRef<'a'>, 'target' | 'rel'>) {
  return (
    <a {...props} target="_blank" rel="noopener noreferrer">
      {children}
      <ArrowUpRight
        size={12}
        className="ml-0.5 inline-block shrink-0 align-text-top"
        aria-hidden="true"
      />
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  )
}
