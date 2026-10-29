import { asc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { JsonValueSchema } from '@repo/schemas/common'
import type { JobData } from '@repo/schemas/job'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import {
  providerSnapshot,
  scrapeJob,
  scrapeJobItem,
  scrapeJobLog,
} from '@/schemas/db'

const DiagnosticMetadataSchema = z.object({
  diagnostics: z.array(JsonValueSchema).min(1),
})

export async function getJobData(jobId: string): Promise<JobData> {
  const job = await db.query.scrapeJob.findFirst({
    columns: { id: true },
    where: eq(scrapeJob.id, jobId),
  })
  if (!job) throw new ServerError({ message: 'Job not found', statusCode: 404 })

  const snapshots = await db
    .select({
      id: providerSnapshot.id,
      mediaItemId: providerSnapshot.mediaItemId,
      provider: providerSnapshot.provider,
      createdAt: providerSnapshot.createdAt,
      payload: providerSnapshot.payload,
    })
    .from(providerSnapshot)
    .where(eq(providerSnapshot.scrapeJobId, jobId))
    .orderBy(asc(providerSnapshot.createdAt), asc(providerSnapshot.id))
  const logs = await db
    .select({
      id: scrapeJobLog.id,
      createdAt: scrapeJobLog.createdAt,
      metadata: scrapeJobLog.metadata,
    })
    .from(scrapeJobLog)
    .where(eq(scrapeJobLog.jobId, jobId))
    .orderBy(asc(scrapeJobLog.createdAt), asc(scrapeJobLog.id))
  const items = await db
    .select({
      id: scrapeJobItem.id,
      mediaItemId: scrapeJobItem.mediaItemId,
      provider: scrapeJobItem.provider,
      payload: scrapeJobItem.payload,
      status: scrapeJobItem.status,
    })
    .from(scrapeJobItem)
    .where(eq(scrapeJobItem.jobId, jobId))
    .orderBy(asc(scrapeJobItem.createdAt), asc(scrapeJobItem.id))

  return {
    jobId,
    snapshots: snapshots.map((snapshot) => ({
      ...snapshot,
      createdAt: snapshot.createdAt.toISOString(),
    })),
    diagnostics: logs.flatMap((log) => {
      const parsed = DiagnosticMetadataSchema.safeParse(log.metadata)
      return parsed.success
        ? [
            {
              id: log.id,
              createdAt: log.createdAt.toISOString(),
              data: parsed.data.diagnostics,
            },
          ]
        : []
    }),
    // Legacy jobs may retain their response on the item without a snapshot.
    // Never substitute another attempt's current state or media history.
    itemPayloads: items.flatMap((item) =>
      item.status === 'succeeded' &&
      item.payload !== null &&
      !snapshots.some(
        (snapshot) =>
          snapshot.mediaItemId === item.mediaItemId &&
          snapshot.provider === item.provider,
      )
        ? [
            {
              id: item.id,
              mediaItemId: item.mediaItemId,
              provider: item.provider,
              payload: item.payload,
            },
          ]
        : [],
    ),
  }
}
