import { and, count, eq, gte, inArray, lt, sql } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import { CloudDispatchJobIdsSchema } from '@repo/schemas/job'
import type { MediaProviderPlugin } from '@repo/media-plugin-sdk'
import { db } from '@/lib/db'
import { getScrapePlugin } from '@/plugins/registry'
import {
  providerRequestEvent,
  scrapeJob,
  scrapeJobItem,
  scrapeJobLog,
} from '@/schemas/db'
import { fixedRequestWindow, hourlyBudget } from '@/lib/request-policy'
import { getProviderBudgetStatus } from '@/services/provider-requests'
import type { CloudProviderDispatchPolicy } from '@/services/cloud-job-coordinator'

const PageSizeSchema = z.number().int().min(1).max(100)

export async function listCloudQueuedJobIds(
  provider: string,
  excludedIds: string[],
  limit: number,
  allowedJobIds?: string[] | null,
): Promise<string[]> {
  const selection = CloudDispatchJobIdsSchema.parse(allowedJobIds ?? null)
  const jobs = await db.query.scrapeJob.findMany({
    columns: { id: true },
    where: (table, operators) =>
      operators.and(
        operators.eq(table.provider, provider),
        operators.eq(table.status, 'queued'),
        selection === null ? undefined : operators.inArray(table.id, selection),
        excludedIds.length
          ? operators.notInArray(table.id, excludedIds)
          : undefined,
      ),
    orderBy: (table, operators) => [
      operators.asc(table.createdAt),
      operators.asc(table.id),
    ],
    limit: PageSizeSchema.parse(limit),
  })
  return jobs.map((job) => job.id)
}

// Bounded reconciliation closes the Postgres commit -> DO wake delivery gap.
// The caller must persist/advance afterProvider, wrapping only at end-of-page.
export async function listCloudJobProviders(
  limit = 32,
  afterProvider?: string,
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ provider: scrapeJob.provider })
    .from(scrapeJob)
    .where(
      and(
        eq(scrapeJob.status, 'queued'),
        afterProvider === undefined
          ? undefined
          : sql`${scrapeJob.provider} > ${afterProvider}`,
      ),
    )
    .orderBy(scrapeJob.provider)
    .limit(PageSizeSchema.parse(limit))
  return rows.map((row) => row.provider)
}

function isAccountLevel(plugin: MediaProviderPlugin): boolean {
  return plugin.manifest.mediaTypes.length === 0
}

/**
 * A new dispatcher starts paused so a backlog of media items waits for a live
 * test. An account-level provider has no backlog: its jobs are started by the
 * owner or by the schedule that follows a completed run.
 */
export async function cloudProviderStartsPaused(
  provider: string,
): Promise<boolean> {
  const plugin = await getScrapePlugin(provider)
  return !plugin || !isAccountLevel(plugin)
}

export async function getCloudProviderDispatchPolicy(
  provider: string,
): Promise<CloudProviderDispatchPolicy> {
  const plugin = await getScrapePlugin(provider)
  // An account-level provider runs task jobs only and has no item scraper.
  if (!plugin || !(plugin.scrapeMediaItem || isAccountLevel(plugin)))
    return { maxConcurrent: 1, blocked: true, wakeAt: null }
  const safety = await db.query.providerRequestState.findFirst({
    where: (table, operators) => operators.eq(table.provider, provider),
  })
  const maxConcurrent = plugin.manifest.rateLimit.concurrentRequests
    ? plugin.manifest.rateLimit.maxConcurrent
    : 1
  if (safety?.halted) return { maxConcurrent, blocked: true, wakeAt: null }
  const now = Date.now()
  const wakeAt = Math.max(
    safety?.cooldownUntil?.getTime() ?? 0,
    safety?.leaseUntil?.getTime() ?? 0,
    safety?.nextAllowedAt?.getTime() ?? 0,
  )
  if (wakeAt > now) return { maxConcurrent, blocked: true, wakeAt }
  const hourly = hourlyBudget(
    safety?.requests ?? [],
    now,
    plugin.manifest.rateLimit.maxRequestsPerHour,
  )
  if (hourly.retryAt !== null)
    return { maxConcurrent, blocked: true, wakeAt: hourly.retryAt }
  const fixed = plugin.manifest.rateLimit.fixedWindow
  if (fixed) {
    const window = fixedRequestWindow(fixed.durationMs, now)
    const usage = await db
      .select({
        requestClass: providerRequestEvent.requestClass,
        used: count(),
      })
      .from(providerRequestEvent)
      .where(
        and(
          eq(providerRequestEvent.provider, provider),
          gte(providerRequestEvent.requestedAt, new Date(window.from)),
          lt(providerRequestEvent.requestedAt, new Date(window.resetsAt)),
        ),
      )
      .groupBy(providerRequestEvent.requestClass)
    // A job can perform multiple request classes; defer before claiming it.
    if (
      usage.some(
        (row) =>
          row.used >=
          (row.requestClass === 'read' ? fixed.reads : fixed.writes),
      )
    )
      return { maxConcurrent, blocked: true, wakeAt: window.resetsAt }
  }
  const budget = await getProviderBudgetStatus(
    provider,
    plugin.manifest.rateLimit,
  )
  if (budget && budget.used >= budget.budget.limit)
    return { maxConcurrent, blocked: true, wakeAt: Date.parse(budget.resetsAt) }
  return { maxConcurrent, blocked: false, wakeAt: null }
}

export async function recoverCloudJobById(
  jobId: string,
  provider: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [job] = await tx
      .select()
      .from(scrapeJob)
      .where(and(eq(scrapeJob.id, jobId), eq(scrapeJob.provider, provider)))
      .for('update')
    if (job?.status !== 'running') return
    const items = await tx
      .select()
      .from(scrapeJobItem)
      .where(eq(scrapeJobItem.jobId, job.id))
    const completed =
      items.length > 0 && items.every((item) => item.status === 'succeeded')
    const finishedAt = new Date()
    const message = completed
      ? 'Worker recovered a job whose items had already succeeded.'
      : 'Cloud worker interrupted before the job finished. Review retained results and retry manually; no provider retry was scheduled.'
    if (!completed)
      await tx
        .update(scrapeJobItem)
        .set({
          status: 'failed',
          message,
          finishedAt,
          updatedAt: finishedAt,
        })
        .where(
          and(
            eq(scrapeJobItem.jobId, job.id),
            inArray(scrapeJobItem.status, ['queued', 'running']),
          ),
        )
    await tx
      .update(scrapeJob)
      .set({
        status: completed ? 'succeeded' : 'failed',
        errorMessage: completed ? null : message,
        finishedAt,
        updatedAt: finishedAt,
      })
      .where(eq(scrapeJob.id, job.id))
    await tx.insert(scrapeJobLog).values({
      id: nanoid(),
      jobId: job.id,
      level: completed ? 'info' : 'error',
      message,
      metadata: {
        reason: completed ? 'worker_recovered_completed' : 'worker_interrupted',
      },
    })
  })
}
