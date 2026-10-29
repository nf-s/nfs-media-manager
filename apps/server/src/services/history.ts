import { eq, inArray } from 'drizzle-orm'
import type { MediaHistory } from '@repo/schemas/media'
import { db } from '@/lib/db'
import {
  mediaOverride,
  providerReferenceOverride,
  providerSnapshot,
  scrapeJob,
  scrapeJobItem,
} from '@/schemas/db'

type MediaHistoryEvent = MediaHistory['events'][number]

export async function getMediaHistory(
  mediaItemId: string,
): Promise<MediaHistory> {
  const [snapshots, overrides, referenceOverrides, jobItems] =
    await Promise.all([
      db
        .select()
        .from(providerSnapshot)
        .where(eq(providerSnapshot.mediaItemId, mediaItemId)),
      db
        .select()
        .from(mediaOverride)
        .where(eq(mediaOverride.mediaItemId, mediaItemId)),
      db
        .select()
        .from(providerReferenceOverride)
        .where(eq(providerReferenceOverride.mediaItemId, mediaItemId)),
      db
        .select()
        .from(scrapeJobItem)
        .where(eq(scrapeJobItem.mediaItemId, mediaItemId)),
    ])

  const jobIds = jobItems.map((item) => item.jobId)
  const jobs =
    jobIds.length > 0
      ? await db.select().from(scrapeJob).where(inArray(scrapeJob.id, jobIds))
      : []

  const snapshotEvents: MediaHistoryEvent[] = snapshots.map((snapshot) => ({
    id: snapshot.id,
    jobId: snapshot.scrapeJobId,
    type: 'snapshot',
    provider: snapshot.provider,
    title: `${snapshot.provider} snapshot`,
    description: snapshot.source,
    createdAt: snapshot.createdAt.toISOString(),
    data: snapshot.payload,
  }))

  const overrideEvents: MediaHistoryEvent[] = overrides.map((override) => ({
    id: override.id,
    type: 'override',
    provider: null,
    title: `Field override: ${override.field}`,
    description: override.note ?? null,
    createdAt: override.createdAt.toISOString(),
    data: override.value,
  }))

  const referenceOverrideEvents: MediaHistoryEvent[] = referenceOverrides.map(
    (override) => ({
      id: override.id,
      type: 'override',
      provider: override.provider,
      title: `Reference override: ${override.provider} ${override.referenceType}`,
      description: override.note ?? null,
      createdAt: override.createdAt.toISOString(),
      data: {
        externalId: override.externalId,
      },
    }),
  )

  const jobEvents: MediaHistoryEvent[] = jobItems.flatMap((item) => {
    const job = jobs.find((candidate) => candidate.id === item.jobId)

    return [
      {
        id: item.id,
        jobId: item.jobId,
        type: 'job',
        provider: item.provider,
        title: `${item.provider} job item`,
        description: item.message ?? job?.errorMessage ?? null,
        createdAt: item.createdAt.toISOString(),
        data: item.payload ?? null,
      },
    ]
  })

  return {
    mediaItemId,
    events: [
      ...snapshotEvents,
      ...overrideEvents,
      ...referenceOverrideEvents,
      ...jobEvents,
    ].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  }
}
