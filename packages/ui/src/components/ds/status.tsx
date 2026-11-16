import type { ReactNode } from 'react'

/**
 * One vocabulary for every job, sync, connection and freshness state.
 * `waiting` always comes with its reason or time in the label.
 */
export type StatusState =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'paused'
  | 'attention'
  | 'never'

export const statusLabels: Record<StatusState, string> = {
  queued: 'Queued',
  running: 'Running',
  waiting: 'Waiting',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
  paused: 'Paused',
  attention: 'Needs attention',
  never: 'Never',
}

export function Status({
  state,
  children,
  title,
}: {
  state: StatusState
  children?: ReactNode
  title?: string
}) {
  return (
    <span className="ds-status" data-status={state} title={title}>
      {children ?? statusLabels[state]}
    </span>
  )
}
