import type { LastfmSyncStatus } from '@repo/schemas/lastfm'

/** Minimum time between step requests so a quickly returning step never spins. */
export const MIN_STEP_INTERVAL_MS = 2000

export function waitFor(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
    function done() {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
  })
}

/**
 * Calls `step` one request at a time while the sync reports `running`.
 * Stops when the state changes, the signal aborts, or a step fails (the error propagates).
 */
export async function driveLastfmSync({
  step,
  onStatus,
  signal,
  now = Date.now,
  wait = waitFor,
}: {
  step: (signal: AbortSignal) => Promise<LastfmSyncStatus>
  onStatus: (status: LastfmSyncStatus) => void
  signal: AbortSignal
  now?: () => number
  wait?: (ms: number, signal: AbortSignal) => Promise<void>
}) {
  while (!signal.aborted) {
    const started = now()
    const status = await step(signal)
    if (signal.aborted) return
    onStatus(status)
    if (status.state !== 'running') return
    const elapsed = now() - started
    if (elapsed < MIN_STEP_INTERVAL_MS)
      await wait(MIN_STEP_INTERVAL_MS - elapsed, signal)
  }
}

export const lastfmSyncStateLabels: Record<LastfmSyncStatus['state'], string> =
  {
    never: 'Not synced',
    running: 'Running',
    stopped: 'Stopped',
    failed: 'Failed',
    complete: 'Complete',
  }
