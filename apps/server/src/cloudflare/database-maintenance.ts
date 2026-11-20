import { sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { writeRequestLog } from '@/lib/request-log'
import { refreshTrackFacetVocabularyForMaintenance } from '@/services/browse'

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

export async function runDatabaseMaintenance(scheduledTime: number) {
  // The existing five-minute maintenance cron also supplies one daily probe.
  const tick = new Date(scheduledTime)
  if (tick.getUTCHours() === 20 && tick.getUTCMinutes() === 0)
    await probeDatabase()
  const refreshStart = performance.now()
  let outcome: 'skipped' | 'published' | 'failed' = 'failed'
  try {
    outcome = (await refreshTrackFacetVocabularyForMaintenance())
      ? 'published'
      : 'skipped'
  } finally {
    writeRequestLog({
      event: 'database.facet-maintenance',
      outcome,
      durationMs: performance.now() - refreshStart,
    })
  }
}
