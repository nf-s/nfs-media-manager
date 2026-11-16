import { Button } from '@repo/ui/components/ui/button'

export function CreatorDetailState({
  pending,
  retry,
  subject,
  stale,
}: {
  pending?: boolean
  retry: () => void
  subject: string
  stale?: boolean
}) {
  if (pending)
    return (
      <p className="browse-empty" role="status">
        Loading {subject}...
      </p>
    )
  if (stale)
    return (
      <p className="quiet mb-2" role="alert">
        Could not refresh this {subject}.{' '}
        <button type="button" className="underline" onClick={retry}>
          Retry
        </button>
      </p>
    )
  return (
    <p className="browse-empty" role="alert">
      Could not load this {subject}. <Button onClick={retry}>Retry</Button>
    </p>
  )
}
