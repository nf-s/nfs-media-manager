'use client'

import { Check } from 'lucide-react'
import { Button, mutationFeedback } from '@repo/ui/components/ui/button'
import { unconfirmedWrite } from '@/utils/write-feedback'

/** The detail header's Watched (or Listened) toggle, with the save error beside it. */
export function WatchedToggle({
  watched,
  pending,
  error,
  failure,
  saved,
  nextWatched,
  onToggle,
  label = 'Watched',
}: {
  watched: boolean
  pending: boolean
  error: boolean
  failure: unknown
  saved: boolean
  nextWatched: boolean
  onToggle: () => void
  label?: string
}) {
  const unconfirmed = unconfirmedWrite(failure)
  const feedback =
    unconfirmed ??
    mutationFeedback(
      { isPending: pending, isError: error, isSuccess: saved },
      {
        pending: nextWatched
          ? `Marking ${label.toLowerCase()}…`
          : `Clearing ${label.toLowerCase()}…`,
        success: nextWatched ? label : `${label} cleared`,
        error: 'Could not save',
      },
    )
  return (
    <>
      <Button
        size="md"
        feedback={feedback}
        aria-pressed={watched}
        disabled={pending}
        onClick={onToggle}
      >
        {watched && (
          <Check className="ds-i" data-size="sm" aria-hidden="true" />
        )}
        {label}
      </Button>
      {unconfirmed && (
        <span role="alert" className="ds-muted">
          Check the current status before trying again.
        </span>
      )}
    </>
  )
}
