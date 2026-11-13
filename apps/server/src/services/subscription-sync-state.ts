import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { YOUTUBE_SYNC_TASK } from '@repo/schemas/youtube'
import {
  SPOTIFY_PODCAST_SYNC_TASK,
  SubscriptionSyncScheduleSchema,
  SubscriptionSyncStatusSchema,
  type SubscriptionAccountStatus,
  type SubscriptionSyncSchedule,
  type SubscriptionSyncStatus,
  type SubscriptionType,
} from '@repo/schemas/subscriptions'
import { db } from '@/lib/db'
import { scrapeJob, subscriptionSync } from '@/schemas/db'

/** The task job that syncs each provider's subscriptions; its job provider is the same key. */
export const subscriptionSyncTasks: Record<SubscriptionType, string> = {
  youtube: YOUTUBE_SYNC_TASK,
  spotify: SPOTIFY_PODCAST_SYNC_TASK,
}

const SCHEDULE_MINUTES: Record<SubscriptionSyncSchedule, number | null> = {
  off: null,
  '1h': 60,
  '3h': 3 * 60,
  '6h': 6 * 60,
  daily: 24 * 60,
  weekly: 7 * 24 * 60,
}

type SyncRow = typeof subscriptionSync.$inferSelect

/** The checkpoint row of one account and provider. */
export const subscriptionSyncRun = (
  userId: string,
  provider: SubscriptionType,
) =>
  and(
    eq(subscriptionSync.userId, userId),
    eq(subscriptionSync.provider, provider),
  )

async function latestSyncJob(provider: SubscriptionType) {
  const [job] = await db
    .select({
      id: scrapeJob.id,
      status: scrapeJob.status,
      errorMessage: scrapeJob.errorMessage,
    })
    .from(scrapeJob)
    .where(
      and(
        eq(scrapeJob.provider, provider),
        sql`${scrapeJob.options}->>'task' = ${subscriptionSyncTasks[provider]}`,
      ),
    )
    .orderBy(desc(scrapeJob.createdAt), desc(scrapeJob.id))
    .limit(1)
  return job ?? null
}

type SyncJob = Awaited<ReturnType<typeof latestSyncJob>>

// The checkpoint row records the run; the job table records who is working on it.
function syncState(
  row: SyncRow | undefined,
  job: SyncJob,
): SubscriptionSyncStatus['state'] {
  if (job?.status === 'queued' || job?.status === 'running') return 'running'
  if (!row || row.status === 'idle') return 'never'
  if (row.status === 'complete') return 'complete'
  if (row.status === 'paused') return 'paused'
  // An open run without a job was cancelled, or its worker was interrupted.
  return row.status === 'failed' || job?.status === 'failed'
    ? 'failed'
    : 'stopped'
}

const CountsSchema = z
  .array(z.object({ sources: z.coerce.number(), items: z.coerce.number() }))
  .length(1)

/**
 * The stored sync state of one provider: its checkpoint, latest job, schedule
 * and the subscribed sources and items of its type. No provider requests.
 */
export async function readSubscriptionSyncStatus(
  provider: SubscriptionType,
  userId: string,
  account: SubscriptionAccountStatus,
): Promise<SubscriptionSyncStatus> {
  const [row] = await db
    .select()
    .from(subscriptionSync)
    .where(subscriptionSyncRun(userId, provider))
  const job = await latestSyncJob(provider)
  const counts = CountsSchema.parse(
    (
      await db.execute(sql`
        select
          (select count(*) from subscription_source
            where type = ${provider} and subscribed) as sources,
          (select count(*) from subscription_item i
            join subscription_source s on s.id = i.source_id
            where s.type = ${provider} and s.subscribed) as items`)
    ).rows,
  )
  const state = syncState(row, job)
  const schedule = SubscriptionSyncScheduleSchema.catch('daily').parse(
    row?.schedule,
  )
  const minutes = SCHEDULE_MINUTES[schedule]
  const next =
    !account.connected || minutes === null
      ? null
      : state === 'complete' && row?.completedAt
        ? new Date(row.completedAt.getTime() + minutes * 60 * 1000)
        : state === 'paused'
          ? (row?.resumeAfter ?? null)
          : null
  const started = row && row.status !== 'idle'
  return SubscriptionSyncStatusSchema.parse({
    provider,
    account,
    state,
    job: job ? { id: job.id, status: job.status } : null,
    schedule,
    nextScheduledAt: next?.toISOString() ?? null,
    phase: started ? (row.phase === 'items' ? 'items' : 'sources') : null,
    sourcesDone: row?.sourcesDone ?? 0,
    sourcesTotal: row?.sourcesTotal ?? 0,
    newItems: row?.newItems ?? 0,
    storedSources: counts[0]?.sources ?? 0,
    storedItems: counts[0]?.items ?? 0,
    startedAt: started ? row.startedAt.toISOString() : null,
    lastCompletedAt: row?.completedAt?.toISOString() ?? null,
    resumeAfter:
      state === 'paused' ? (row?.resumeAfter?.toISOString() ?? null) : null,
    errorMessage:
      state === 'failed'
        ? (row?.errorMessage ?? job?.errorMessage ?? null)
        : null,
  })
}

/** Saves how often a provider's sync is queued; it can be saved before the first run. */
export async function saveSubscriptionSyncSchedule(
  provider: SubscriptionType,
  userId: string,
  schedule: SubscriptionSyncSchedule,
) {
  await db
    .insert(subscriptionSync)
    .values({
      userId,
      provider,
      status: 'idle',
      schedule,
      startedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [subscriptionSync.userId, subscriptionSync.provider],
      set: { schedule },
    })
}

/** Accounts whose schedule is due, or whose quota pause has passed. */
export async function dueSubscriptionSyncUsers(
  provider: SubscriptionType,
  now: number,
  readStatus: (userId: string) => Promise<SubscriptionSyncStatus>,
): Promise<string[]> {
  const rows = await db
    .select({ userId: subscriptionSync.userId })
    .from(subscriptionSync)
    .where(
      and(
        eq(subscriptionSync.provider, provider),
        inArray(subscriptionSync.status, ['complete', 'paused']),
      ),
    )
  const due: string[] = []
  for (const row of rows) {
    const status = await readStatus(row.userId)
    if (status.nextScheduledAt && Date.parse(status.nextScheduledAt) <= now)
      due.push(row.userId)
  }
  return due
}
