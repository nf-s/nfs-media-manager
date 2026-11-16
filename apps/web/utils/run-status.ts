import { statusLabels, type StatusState } from '@repo/ui/components/ds/status'

/** Imports, playlist imports and listing jobs share the job status enum. */
export type RunStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'

export const runStatusStates: Record<RunStatus, StatusState> = {
  queued: 'queued',
  running: 'running',
  succeeded: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
}

/** The standard label for a run status: Queued, Running, Done, Failed, Cancelled. */
export function runStatusLabel(status: RunStatus) {
  return statusLabels[runStatusStates[status]]
}

/** Last.fm and subscription sync states. */
export type SyncState =
  | 'never'
  | 'running'
  | 'paused'
  | 'stopped'
  | 'failed'
  | 'complete'

export const syncStatusStates: Record<SyncState, StatusState> = {
  never: 'never',
  running: 'running',
  paused: 'paused',
  stopped: 'cancelled',
  failed: 'failed',
  complete: 'done',
}

export function syncStatusLabel(state: SyncState) {
  return statusLabels[syncStatusStates[state]]
}
