import { ReadButton } from '@/components/read-button'
import { Notice, Skeleton, State } from '@repo/ui/components/ds/feedback'
import { Status } from '@repo/ui/components/ds/status'

/** Loading, failed and stale states of a detail drawer or page. */
export function CreatorDetailState({
  pending,
  pendingLabel,
  retry,
  subject,
  stale,
}: {
  pending?: boolean
  pendingLabel?: string
  retry: () => Promise<unknown>
  subject: string
  stale?: boolean
}) {
  if (pending)
    return (
      <div
        className="dtl-loading"
        role="status"
        aria-label={`Loading ${subject}`}
      >
        <Skeleton width={112} height={112} />
        <div className="dtl-loading-lines">
          {pendingLabel ? (
            <Status state="running">{pendingLabel}</Status>
          ) : (
            <Skeleton width="30%" height={12} />
          )}
          <Skeleton width="60%" height={20} />
          <Skeleton width="45%" height={12} />
        </div>
      </div>
    )
  if (stale)
    return (
      <Notice
        tone="attention"
        action={
          <ReadButton size="xs" read={retry}>
            Retry
          </ReadButton>
        }
      >
        Could not refresh this {subject}.
      </Notice>
    )
  return (
    <State
      title={`Could not load this ${subject}`}
      error
      action={<ReadButton read={retry}>Retry</ReadButton>}
    />
  )
}
