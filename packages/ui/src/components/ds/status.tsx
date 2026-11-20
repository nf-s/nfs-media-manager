import type { ComponentPropsWithoutRef } from 'react'

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
  ...props
}: Omit<ComponentPropsWithoutRef<'span'>, 'className'> & {
  state: StatusState
}) {
  return (
    <span className="ds-status" data-status={state} {...props}>
      {children ?? statusLabels[state]}
    </span>
  )
}
