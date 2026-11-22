import { randomUUID } from 'node:crypto'
import { and, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm'
import { z } from 'zod'
import {
  PROVIDER_REQUEST_SERIES_DAYS,
  ProviderLibraryCoverageSchema,
  ProviderRequestSeriesSchema,
  type ProviderActivity,
  type ProviderActivityRange,
  type ProviderJobSummary,
  type ProviderLibraryCoverage,
  type ProviderRequestSeries,
} from '@repo/schemas/provider'
import { JobErrorReviewSchema } from '@repo/schemas/job'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import { DAY_MS } from '@/lib/request-policy'
import { providerTaskCoverageSources } from '@/lib/provider-task-coverage'
import { listProviderCatalog } from '@/plugins/registry'
import {
  mediaItem,
  providerCurrentState,
  providerRequestState,
  providerRequestEvent,
  providerCooldownReset,
  scrapeJob,
  scrapeJobLog,
} from '@/schemas/db'
import { getProviderSafety } from './provider-requests'

async function requireProvider(provider: string) {
  const entry = (await listProviderCatalog()).find(
    (item) => item.id === provider,
  )
  if (!entry)
    throw new ServerError({ statusCode: 404, message: 'Provider not found' })
  return entry
}

const isoDate = (time: number) => new Date(time).toISOString().slice(0, 10)

/**
 * Request attempts per UTC day over the last 90 days, the longest range the
 * provider page's chart offers. Request events are never pruned, so the window
 * bounds the read; days with no requests are left out for the chart to zero.
 */
export async function getProviderRequestSeries(
  provider: string,
  now = new Date(),
): Promise<ProviderRequestSeries> {
  await requireProvider(provider)
  const today = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  )
  const from = today - (PROVIDER_REQUEST_SERIES_DAYS - 1) * DAY_MS
  const day = sql<string>`to_char(${providerRequestEvent.requestedAt}, 'YYYY-MM-DD')`
  const [rows, [state]] = await Promise.all([
    db
      .select({ date: day, count: sql<number>`count(*)::integer` })
      .from(providerRequestEvent)
      .where(
        and(
          eq(providerRequestEvent.provider, provider),
          gte(providerRequestEvent.requestedAt, new Date(from)),
          lt(providerRequestEvent.requestedAt, new Date(today + DAY_MS)),
        ),
      )
      .groupBy(day)
      .orderBy(day),
    db
      .select({ since: providerRequestState.historyStartedAt })
      .from(providerRequestState)
      .where(eq(providerRequestState.provider, provider)),
  ])
  return ProviderRequestSeriesSchema.parse({
    provider,
    recordedSince: state?.since.toISOString() ?? null,
    daysFrom: isoDate(from),
    daysTo: isoDate(today),
    total: rows.reduce((sum, row) => sum + row.count, 0),
    days: rows,
  })
}

const TaskCoverageRowSchema = z.record(z.string(), z.number().int())

/**
 * How many visible library items of each media type in the provider's
 * manifest it has data for; for a provider whose work runs as task jobs,
 * of each library its lookups cover. As in Metadata, only a successful scrape sets
 * `last_scraped_at`, so imports and overrides do not count.
 */
export async function getProviderLibraryCoverage(
  provider: string,
): Promise<ProviderLibraryCoverage> {
  const entry = await requireProvider(provider)
  const taskSources = providerTaskCoverageSources(provider)
  if (taskSources) {
    const rows = z.array(TaskCoverageRowSchema).parse(
      (
        await db.execute(sql`select ${sql.join(
          taskSources.map(
            (source, index) => sql`
              count(*) filter (where mi.media_type = ${source.mediaType})::integer
                as ${sql.raw(`total_${index}`)},
              count(*) filter (where mi.media_type = ${source.mediaType}
                and ${source.covered})::integer as ${sql.raw(`covered_${index}`)}`,
          ),
          sql`, `,
        )}
          from media_item mi
          where mi.media_type in (${sql.join(
            taskSources.map((source) => sql`${source.mediaType}`),
            sql`, `,
          )})
            and mi.metadata->>'legacyHidden' is distinct from 'true'`)
      ).rows,
    )
    const [row] = rows
    return ProviderLibraryCoverageSchema.parse({
      provider,
      mediaTypes: taskSources.map((source, index) => ({
        mediaType: source.mediaType,
        covered: row?.[`covered_${index}`] ?? 0,
        total: row?.[`total_${index}`] ?? 0,
        queueFrom: source.queueFrom,
      })),
    })
  }
  if (!entry.mediaTypes.length) return { provider, mediaTypes: [] }
  const rows = await db
    .select({
      mediaType: mediaItem.mediaType,
      total: sql<number>`count(*)::integer`,
      covered: sql<number>`count(${providerCurrentState.lastScrapedAt})::integer`,
    })
    .from(mediaItem)
    .leftJoin(
      providerCurrentState,
      and(
        eq(providerCurrentState.mediaItemId, mediaItem.id),
        eq(providerCurrentState.provider, provider),
      ),
    )
    .where(
      and(
        inArray(mediaItem.mediaType, entry.mediaTypes),
        sql`${mediaItem.metadata}->>'legacyHidden' is distinct from 'true'`,
      ),
    )
    .groupBy(mediaItem.mediaType)
  return ProviderLibraryCoverageSchema.parse({
    provider,
    mediaTypes: entry.mediaTypes.map((mediaType) => {
      const row = rows.find((item) => item.mediaType === mediaType)
      return {
        mediaType,
        covered: row?.covered ?? 0,
        total: row?.total ?? 0,
      }
    }),
  })
}

export async function getProviderJobSummary(
  provider: string,
): Promise<ProviderJobSummary> {
  await requireProvider(provider)
  const [counts] = await db
    .select({
      total: sql<number>`count(*)::integer`,
      queued: sql<number>`count(*) filter (where ${scrapeJob.status} = 'queued')::integer`,
      running: sql<number>`count(*) filter (where ${scrapeJob.status} = 'running')::integer`,
      succeeded: sql<number>`count(*) filter (where ${scrapeJob.status} = 'succeeded')::integer`,
      failed: sql<number>`count(*) filter (where ${scrapeJob.status} = 'failed')::integer`,
      cancelled: sql<number>`count(*) filter (where ${scrapeJob.status} = 'cancelled')::integer`,
    })
    .from(scrapeJob)
    .where(eq(scrapeJob.provider, provider))
  return {
    provider,
    total: counts?.total ?? 0,
    queued: counts?.queued ?? 0,
    running: counts?.running ?? 0,
    succeeded: counts?.succeeded ?? 0,
    failed: counts?.failed ?? 0,
    cancelled: counts?.cancelled ?? 0,
  }
}

const ReviewMetadataSchema = z.object({ benignReview: JobErrorReviewSchema })

export async function getProviderActivity(
  provider: string,
  range: ProviderActivityRange,
): Promise<ProviderActivity> {
  await requireProvider(provider)
  const duration =
    range === '1h' ? 3600000 : range === '24h' ? 86400000 : 7 * 86400000
  const bucketMs =
    range === '1h' ? 60000 : range === '24h' ? 3600000 : 6 * 3600000
  const to = Date.now()
  const from = to - duration
  const rows = await db
    .select({
      bucket: sql<number>`floor((extract(epoch from ${providerRequestEvent.requestedAt}) * 1000 - ${from}) / ${bucketMs})::integer`,
      count: sql<number>`count(*)::integer`,
    })
    .from(providerRequestEvent)
    .where(
      and(
        eq(providerRequestEvent.provider, provider),
        gte(providerRequestEvent.requestedAt, new Date(from)),
        lt(providerRequestEvent.requestedAt, new Date(to)),
      ),
    )
    .groupBy(sql`1`)
  const counts = new Map(rows.map((row) => [row.bucket, row.count]))
  const buckets = Array.from({ length: duration / bucketMs }, (_, index) => ({
    start: new Date(from + index * bucketMs).toISOString(),
    count: counts.get(index) ?? 0,
  }))
  const [state] = await db
    .select({ since: providerRequestState.historyStartedAt })
    .from(providerRequestState)
    .where(eq(providerRequestState.provider, provider))
  const reviews = await db
    .select({
      jobId: scrapeJob.id,
      message: scrapeJobLog.message,
      metadata: scrapeJobLog.metadata,
    })
    .from(scrapeJobLog)
    .innerJoin(scrapeJob, eq(scrapeJob.id, scrapeJobLog.jobId))
    .where(
      and(
        eq(scrapeJob.provider, provider),
        sql`${scrapeJobLog.metadata}->'benignReview' is not null`,
      ),
    )
    .orderBy(desc(sql`${scrapeJobLog.metadata}->'benignReview'->>'reviewedAt'`))
    .limit(20)
  const resets = await db
    .select()
    .from(providerCooldownReset)
    .where(eq(providerCooldownReset.provider, provider))
    .orderBy(desc(providerCooldownReset.clearedAt))
    .limit(5)
  return {
    provider,
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    bucketMs,
    recordedSince: state?.since.toISOString() ?? null,
    total: buckets.reduce((sum, bucket) => sum + bucket.count, 0),
    buckets,
    benignReviews: reviews.flatMap((row) => {
      const parsed = ReviewMetadataSchema.safeParse(row.metadata)
      return parsed.success
        ? [
            {
              jobId: row.jobId,
              message: row.message,
              reviewedAt: parsed.data.benignReview.reviewedAt,
            },
          ]
        : []
    }),
    cooldownResets: resets.map((row) => ({
      clearedAt: row.clearedAt.toISOString(),
      previousCooldownUntil: row.previousCooldownUntil.toISOString(),
    })),
  }
}

export async function clearProviderCooldown(
  provider: string,
  expectedCooldownUntil: string,
  userId: string | null,
) {
  await requireProvider(provider)
  await db.transaction(async (tx) => {
    const [state] = await tx
      .select()
      .from(providerRequestState)
      .where(eq(providerRequestState.provider, provider))
      .for('update')
    if (!state?.cooldownUntil || state.cooldownUntil.getTime() <= Date.now())
      throw new ServerError({
        statusCode: 409,
        message: 'No active cooldown. Refresh the provider status.',
      })
    if (
      state.cooldownUntil.toISOString() !== expectedCooldownUntil ||
      (state.leaseUntil && state.leaseUntil.getTime() > Date.now()) ||
      state.requestLeases.some((lease) => lease.expiresAt > Date.now())
    )
      throw new ServerError({
        statusCode: 409,
        message:
          'Provider state changed. Refresh before clearing the cooldown.',
      })
    await tx.insert(providerCooldownReset).values({
      id: randomUUID(),
      provider,
      previousCooldownUntil: state.cooldownUntil,
      userId,
    })
    await tx
      .update(providerRequestState)
      .set({ cooldownUntil: null, updatedAt: new Date() })
      .where(eq(providerRequestState.provider, provider))
  })
  return getProviderSafety(provider)
}
