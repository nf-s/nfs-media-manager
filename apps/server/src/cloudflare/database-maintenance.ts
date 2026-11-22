import { sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { writeRequestLog } from '@/lib/request-log'
import {
  refreshRecordingBrowseOrderForMaintenance,
  refreshTrackFacetVocabularyForMaintenance,
} from '@/services/browse'
import type { RecordingOrderMaintenanceSource } from '@/services/recording-groups'
import { refreshTrackDuplicatesForMaintenance } from '@/services/track-duplicates'

/** One bounded round trip on a fresh invocation pool, even when the library is idle. */
async function probeDatabase() {
  const start = performance.now()
  let available = false
  try {
    await db.execute(sql`select 1`)
    available = true
  } finally {
    writeRequestLog({
      event: 'database.probe',
      outcome: available ? 'ok' : 'failed',
      durationMs: performance.now() - start,
    })
  }
}

async function refreshCache(
  event:
    | { event: 'database.facet-maintenance' }
    | { event: 'database.duplicate-maintenance' }
    | {
        event: 'database.recording-order-maintenance'
        source: RecordingOrderMaintenanceSource
      },
  refresh: () => Promise<boolean>,
) {
  const refreshStart = performance.now()
  let outcome: 'skipped' | 'published' | 'failed' = 'failed'
  try {
    outcome = (await refresh()) ? 'published' : 'skipped'
  } finally {
    writeRequestLog({
      ...event,
      outcome,
      durationMs: performance.now() - refreshStart,
    })
  }
}

export function runRecordingOrderMaintenance(
  source: RecordingOrderMaintenanceSource,
) {
  return refreshCache(
    { event: 'database.recording-order-maintenance', source },
    () => refreshRecordingBrowseOrderForMaintenance(source),
  )
}

export async function runDatabaseMaintenance(scheduledTime: number) {
  // The existing five-minute maintenance cron also supplies one daily probe.
  const tick = new Date(scheduledTime)
  if (tick.getUTCHours() === 20 && tick.getUTCMinutes() === 0)
    await probeDatabase()
  const rebuilds = [
    () =>
      refreshCache(
        { event: 'database.facet-maintenance' },
        refreshTrackFacetVocabularyForMaintenance,
      ),
    () => runRecordingOrderMaintenance('scheduled'),
    () =>
      refreshCache(
        { event: 'database.duplicate-maintenance' },
        refreshTrackDuplicatesForMaintenance,
      ),
  ]
  let firstFailure: { reason: unknown } | undefined
  // Keep expensive rebuilds from competing within the same cron invocation.
  for (const rebuild of rebuilds)
    try {
      await rebuild()
    } catch (reason) {
      firstFailure ??= { reason }
    }
  if (firstFailure) throw firstFailure.reason
}
