import { and, count, desc, eq, inArray } from 'drizzle-orm'
import type { z } from 'zod'
import type { PaginationQuerySchema } from '@repo/schemas/common'
import { AlbumMatchRejectionInputSchema } from '@repo/schemas/match-diagnostics'
import type {
  MediaHistory,
  MediaSources,
  SourceSnapshot,
  SourceSnapshotSummary,
} from '@repo/schemas/media'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import {
  mediaOverride,
  providerReferenceOverride,
  providerCurrentState,
  providerSnapshot,
  scrapeJob,
  scrapeJobItem,
} from '@/schemas/db'
import { albumMatchRejectionField } from './album-match-rejections'
import { albumMetacriticCorrectionField } from './album-metacritic-corrections'

type MediaHistoryEvent = MediaHistory['events'][number]

const snapshotSummaryColumns = {
  id: providerSnapshot.id,
  provider: providerSnapshot.provider,
  source: providerSnapshot.source,
  jobId: providerSnapshot.scrapeJobId,
  createdAt: providerSnapshot.createdAt,
}

function formatSnapshotSummary(
  row: Omit<SourceSnapshotSummary, 'createdAt'> & { createdAt: Date },
) {
  return { ...row, createdAt: row.createdAt.toISOString() }
}

function formatFieldOverride(
  override: typeof mediaOverride.$inferSelect,
): MediaHistoryEvent {
  if (override.field === albumMetacriticCorrectionField) {
    return {
      id: override.id,
      type: 'override',
      provider: 'metacritic',
      title: 'Metacritic album match corrected',
      description: null,
      createdAt: override.createdAt.toISOString(),
      data: override.value,
    }
  }
  if (override.field === 'albumListeningLinkRejection') {
    return {
      id: override.id,
      type: 'override',
      provider: 'lastfm-listening',
      title: 'Last.fm listening match rejected',
      description: override.note,
      createdAt: override.createdAt.toISOString(),
      data: override.value,
    }
  }
  if (override.field === albumMatchRejectionField) {
    const rejection = AlbumMatchRejectionInputSchema.safeParse(override.value)
    if (rejection.success)
      return {
        id: override.id,
        type: 'override',
        provider: rejection.data.provider,
        title: 'Album match rejected',
        description: rejection.data.identifier,
        createdAt: override.createdAt.toISOString(),
        data: rejection.data,
      }
  }
  return {
    id: override.id,
    type: 'override',
    provider: null,
    title: `Field override: ${override.field}`,
    description: override.note ?? null,
    createdAt: override.createdAt.toISOString(),
    data: override.value,
  }
}

function formatReferenceOverride(
  override: typeof providerReferenceOverride.$inferSelect,
): MediaHistoryEvent {
  return {
    id: override.id,
    type: 'override',
    provider: override.provider,
    title: `Reference override: ${override.provider} ${override.referenceType}`,
    description: override.note ?? null,
    createdAt: override.createdAt.toISOString(),
    data: { externalId: override.externalId },
  }
}

/** Read the source index without selecting any raw or normalized provider payloads. */
export async function getMediaSources(
  mediaItemId: string,
): Promise<MediaSources> {
  const [current, snapshots, jobs, overrides, referenceOverrides] =
    await Promise.all([
      db
        .select({
          provider: providerCurrentState.provider,
          snapshot: snapshotSummaryColumns,
        })
        .from(providerCurrentState)
        .leftJoin(
          providerSnapshot,
          eq(providerCurrentState.latestSnapshotId, providerSnapshot.id),
        )
        .where(eq(providerCurrentState.mediaItemId, mediaItemId)),
      db
        .selectDistinctOn([providerSnapshot.provider], snapshotSummaryColumns)
        .from(providerSnapshot)
        .where(eq(providerSnapshot.mediaItemId, mediaItemId))
        .orderBy(
          providerSnapshot.provider,
          desc(providerSnapshot.createdAt),
          desc(providerSnapshot.id),
        ),
      db
        .selectDistinct({ provider: scrapeJobItem.provider })
        .from(scrapeJobItem)
        .where(eq(scrapeJobItem.mediaItemId, mediaItemId)),
      db
        .select()
        .from(mediaOverride)
        .where(eq(mediaOverride.mediaItemId, mediaItemId)),
      db
        .select()
        .from(providerReferenceOverride)
        .where(eq(providerReferenceOverride.mediaItemId, mediaItemId)),
    ])
  const providers = new Map<string, SourceSnapshotSummary | null>()
  for (const { provider } of [...jobs, ...referenceOverrides])
    providers.set(provider, null)
  for (const snapshot of snapshots)
    providers.set(snapshot.provider, formatSnapshotSummary(snapshot))
  for (const { provider, snapshot } of current)
    if (snapshot || !providers.has(provider))
      providers.set(provider, snapshot ? formatSnapshotSummary(snapshot) : null)
  return {
    providers: [...providers].map(([id, latestSnapshot]) => ({
      id,
      latestSnapshot,
    })),
    changes: [
      ...overrides.map(formatFieldOverride),
      ...referenceOverrides.map(formatReferenceOverride),
    ].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  }
}

export async function listMediaSourceSnapshots(
  mediaItemId: string,
  provider: string,
  query: z.infer<typeof PaginationQuerySchema>,
) {
  const where = and(
    eq(providerSnapshot.mediaItemId, mediaItemId),
    eq(providerSnapshot.provider, provider),
  )
  const { page, size } = query
  const [rows, totals] = await Promise.all([
    db
      .select(snapshotSummaryColumns)
      .from(providerSnapshot)
      .where(where)
      .orderBy(desc(providerSnapshot.createdAt), desc(providerSnapshot.id))
      .limit(size)
      .offset((page - 1) * size),
    db.select({ count: count() }).from(providerSnapshot).where(where),
  ])
  const totalCount = totals[0]?.count ?? 0
  return {
    page,
    size,
    totalCount,
    pageCount: Math.ceil(totalCount / size),
    items: rows.map(formatSnapshotSummary),
  }
}

export async function getMediaSourceSnapshot(
  mediaItemId: string,
  provider: string,
  snapshotId: string,
): Promise<SourceSnapshot> {
  const [row] = await db
    .select({
      ...snapshotSummaryColumns,
      data: providerSnapshot.payload,
      normalizedData: providerSnapshot.normalizedData,
    })
    .from(providerSnapshot)
    .where(
      and(
        eq(providerSnapshot.mediaItemId, mediaItemId),
        eq(providerSnapshot.provider, provider),
        eq(providerSnapshot.id, snapshotId),
      ),
    )
  if (!row)
    throw new ServerError({ statusCode: 404, message: 'Snapshot not found.' })
  const { data, normalizedData, ...summary } = row
  return { ...formatSnapshotSummary(summary), data, normalizedData }
}

export async function getMediaHistory(
  mediaItemId: string,
): Promise<MediaHistory> {
  const [snapshots, overrides, referenceOverrides, jobItems] =
    await Promise.all([
      db
        .select({
          id: providerSnapshot.id,
          scrapeJobId: providerSnapshot.scrapeJobId,
          provider: providerSnapshot.provider,
          source: providerSnapshot.source,
          createdAt: providerSnapshot.createdAt,
          payload: providerSnapshot.payload,
        })
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
        .select({
          id: scrapeJobItem.id,
          jobId: scrapeJobItem.jobId,
          provider: scrapeJobItem.provider,
          message: scrapeJobItem.message,
          createdAt: scrapeJobItem.createdAt,
          payload: scrapeJobItem.payload,
        })
        .from(scrapeJobItem)
        .where(eq(scrapeJobItem.mediaItemId, mediaItemId)),
    ])

  const jobIds = [...new Set(jobItems.map((item) => item.jobId))]
  const jobs =
    jobIds.length > 0
      ? await db
          .select({ id: scrapeJob.id, errorMessage: scrapeJob.errorMessage })
          .from(scrapeJob)
          .where(inArray(scrapeJob.id, jobIds))
      : []
  const jobsById = new Map(jobs.map((job) => [job.id, job]))

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

  const jobEvents: MediaHistoryEvent[] = jobItems.flatMap((item) => {
    const job = jobsById.get(item.jobId)

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
      ...overrides.map(formatFieldOverride),
      ...referenceOverrides.map(formatReferenceOverride),
      ...jobEvents,
    ].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  }
}
