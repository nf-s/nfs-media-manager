import { randomUUID } from 'node:crypto'
import { and, desc, eq, gte, lt, sql } from 'drizzle-orm'
import { z } from 'zod'
import type {
  ProviderActivity,
  ProviderActivityRange,
} from '@repo/schemas/provider'
import { JobErrorReviewSchema } from '@repo/schemas/job'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import { listProviderCatalog } from '@/plugins/registry'
import {
  providerRequestState,
  providerRequestEvent,
  providerCooldownReset,
  scrapeJob,
  scrapeJobLog,
} from '@/schemas/db'
import { getProviderSafety } from './provider-requests'

async function requireProvider(provider: string) {
  if (!(await listProviderCatalog()).some((item) => item.id === provider))
    throw new ServerError({ statusCode: 404, message: 'Provider not found' })
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
