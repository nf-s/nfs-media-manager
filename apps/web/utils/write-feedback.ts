import type { ButtonFeedback } from '@repo/ui/components/ui/button'

/** A lost write response leaves the stored outcome unknown. */
export function unconfirmedWrite(error: unknown): ButtonFeedback | undefined {
  if (
    error instanceof TypeError ||
    (error instanceof DOMException && error.name === 'AbortError')
  )
    return { phase: 'unconfirmed', label: 'Result unconfirmed' }
  return undefined
}
