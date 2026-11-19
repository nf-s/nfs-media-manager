'use client'

import { Check } from 'lucide-react'
import { Button } from '@repo/ui/components/ui/button'

/** The detail header's Watched (or Listened) toggle, with the save error beside it. */
export function WatchedToggle({
  watched,
  pending,
  error,
  onToggle,
  label = 'Watched',
}: {
  watched: boolean
  pending: boolean
  error: boolean
  onToggle: () => void
  label?: string
}) {
  return (
    <>
      <Button
        size="md"
        aria-pressed={watched}
        disabled={pending}
        onClick={onToggle}
      >
        {watched && (
          <Check className="ds-i" data-size="sm" aria-hidden="true" />
        )}
        {label}
      </Button>
      {error && (
        <span role="alert" className="ds-muted">
          Could not save.
        </span>
      )}
    </>
  )
}
