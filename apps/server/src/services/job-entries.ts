import { inArray, sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import {
  JobLibrarySchema,
  JobListQuerySchema,
  type JobBatchEntry,
  type JobEntry,
  type JobEntryPage,
} from '@repo/schemas/job'
import { ARTIST_ENRICHMENT_TASK } from '@repo/schemas/artist-profiles'
import {
  MIX_SYNC_TASKS,
  SUBSCRIPTION_SYNC_TASKS,
} from '@repo/schemas/subscriptions'
import { db } from '@/lib/db'
import { libraryImport, scrapeJob } from '@/schemas/db'
import { jobListWhere, jobSortField, loadListedJobs } from '@/services/jobs'
import {
  firstWaiting,
  loadProviderWaitStates,
  withJobWaiting,
} from '@/services/job-waiting'

const batchKey = sql`${scrapeJob.options}->>'batchId'`
const EntryRowSchema = z.object({
  kind: z.enum(['job', 'batch']),
  key: z.string(),
  matching: z.number().int().positive(),
})
const CountRowSchema = z.object({ count: z.number().int().nonnegative() })
const epochMs = (value: SQL) =>
  sql<number | null>`(extract(epoch from ${value}) * 1000)::float8`

// How a batch row sorts: the same field as its jobs, aggregated over the batch.
function batchSortValue(
  sortBy: z.infer<typeof JobListQuerySchema>['sortBy'],
  field: Awaited<ReturnType<typeof jobSortField>>,
) {
  const unfinished = sql`count(*) filter (where ${scrapeJob.status} in ('queued', 'running'))`
  if (sortBy === 'finishedAt')
    return sql`case when count(*) = 1 or ${unfinished} = 0 then max(${scrapeJob.finishedAt}) end`
  if (sortBy === 'status')
    return sql`case
      when count(*) filter (where ${scrapeJob.status} = 'running') > 0 then 'running'
      when count(*) filter (where ${scrapeJob.status} = 'queued') > 0 then 'queued'
      when count(*) filter (where ${scrapeJob.status} = 'failed') > 0 then 'failed'
      when count(*) filter (where ${scrapeJob.status} = 'cancelled') > 0 then 'cancelled'
      else 'succeeded' end`
  return sql`min(${field})`
}

async function loadBatches(ids: string[], now: number) {
  if (!ids.length) return new Map<string, JobBatchEntry>()
  const subscriptionTasks = sql.join(
    SUBSCRIPTION_SYNC_TASKS.map((task) => sql`${task}`),
    sql`, `,
  )
  const mixTasks = sql.join(
    MIX_SYNC_TASKS.map((task) => sql`${task}`),
    sql`, `,
  )
  const task = sql`coalesce(${scrapeJob.options}->>'task', '')`
  const scopeType = sql`${scrapeJob.scope}->>'mediaType'`
  const [rows, imports] = await Promise.all([
    db
      .select({
        batchId: sql<string>`${batchKey}`,
        total: sql<number>`count(*)::integer`,
        queued: sql<number>`count(*) filter (where ${scrapeJob.status} = 'queued')::integer`,
        running: sql<number>`count(*) filter (where ${scrapeJob.status} = 'running')::integer`,
        succeeded: sql<number>`count(*) filter (where ${scrapeJob.status} = 'succeeded')::integer`,
        failed: sql<number>`count(*) filter (where ${scrapeJob.status} = 'failed')::integer`,
        cancelled: sql<number>`count(*) filter (where ${scrapeJob.status} = 'cancelled')::integer`,
        providers: sql<
          string[]
        >`array_agg(distinct ${scrapeJob.provider} order by ${scrapeJob.provider})`,
        queuedProviders: sql<
          string[]
        >`coalesce(array_agg(distinct ${scrapeJob.provider}) filter (where ${scrapeJob.status} = 'queued'), '{}')`,
        mediaType: sql<string | null>`case
          when bool_and(${task} = ${ARTIST_ENRICHMENT_TASK}) then 'artist'
          when bool_and(${task} in (${subscriptionTasks})) then 'subscription'
          when bool_and(${task} in (${mixTasks})) then 'mix'
          when count(${scopeType}) = count(*) and count(distinct ${scopeType}) = 1 then min(${scopeType})
          end`,
        createdAt: epochMs(sql`min(${scrapeJob.createdAt})`),
        startedAt: epochMs(sql`min(${scrapeJob.startedAt})`),
        finishedAt: epochMs(
          sql`case when count(*) filter (where ${scrapeJob.status} in ('queued', 'running')) = 0 then max(${scrapeJob.finishedAt}) end`,
        ),
      })
      .from(scrapeJob)
      .where(inArray(batchKey, ids))
      .groupBy(batchKey),
    db
      .select({
        id: libraryImport.id,
        batchId: sql<string>`${libraryImport.result}->>'jobBatchId'`,
      })
      .from(libraryImport)
      .where(inArray(sql`${libraryImport.result}->>'jobBatchId'`, ids)),
  ])
  const states = await loadProviderWaitStates(
    rows.flatMap((row) => (row.running === 0 ? row.queuedProviders : [])),
    { now },
  )
  const importIds = new Map(imports.map((row) => [row.batchId, row.id]))
  const iso = (time: number | null) =>
    time === null ? null : new Date(time).toISOString()
  return new Map(
    rows.map((row): [string, JobBatchEntry] => {
      const mediaType = JobLibrarySchema.safeParse(row.mediaType)
      const importId = importIds.get(row.batchId) ?? null
      return [
        row.batchId,
        {
          kind: 'batch',
          batchId: row.batchId,
          provider:
            row.providers.length === 1 ? (row.providers[0] ?? null) : null,
          providers: row.providers,
          mediaType: mediaType.success ? mediaType.data : null,
          label: importId ? 'Library import' : null,
          importId,
          total: row.total,
          matching: 0,
          queued: row.queued,
          running: row.running,
          succeeded: row.succeeded,
          failed: row.failed,
          cancelled: row.cancelled,
          createdAt: iso(row.createdAt) ?? new Date(now).toISOString(),
          startedAt: iso(row.startedAt),
          finishedAt: iso(row.finishedAt),
          waiting:
            row.running === 0 && row.queued > 0
              ? firstWaiting(
                  row.queuedProviders.flatMap((provider) => {
                    const state = states.get(provider)
                    return state ? [state] : []
                  }),
                )
              : null,
        },
      ]
    }),
  )
}

/**
 * The jobs list with each batch of several jobs as one row. Filters select
 * jobs; a batch appears when any of its jobs match and describes the whole
 * batch. Filtering, sorting and pagination happen in SQL.
 */
export async function listJobEntries(
  input: z.input<typeof JobListQuerySchema> = {},
): Promise<JobEntryPage> {
  const query = JobListQuerySchema.parse(input)
  const now = Date.now()
  const where = jobListWhere(query)
  // Each matching batch ID occupies one entry, even if it has only one job.
  // Counting entries does not require sorting jobs or visiting nonmatches.
  const count = sql`select coalesce(sum(case when batch_id is null then total else 1 end), 0)::int as count
    from (select ${batchKey} as batch_id, count(*) as total
      from ${scrapeJob} where ${where ?? sql`true`} group by 1) matching_groups`
  const field = await jobSortField(query)
  const direction = query.direction === 'asc' ? sql`asc` : sql`desc`
  const offset = (query.page - 1) * query.size
  const matchingBatches = where
    ? sql`matching_batches as (
        select ${batchKey} as batch_id, count(*)::int as matching
        from ${scrapeJob} where ${batchKey} is not null and (${where}) group by 1
      ),`
    : sql``
  // A nonmatching member still contributes to its batch's size and sort order.
  // Single jobs without a batch need only compete up to the requested page.
  const entries = sql`with ${matchingBatches} batch as (
      select ${batchKey} as batch_id, min(${scrapeJob.id}) as only_job_id,
        count(*) as total, ${batchSortValue(query.sortBy, field)} as sort_value,
        ${where ? sql`max(matching_batches.matching)` : sql`count(*)::int`} as matching
      from ${scrapeJob} ${where ? sql`join matching_batches on matching_batches.batch_id = ${batchKey}` : sql``}
      where ${batchKey} is not null
      group by 1
    ), entries as (
      (select 'job' as kind, ${scrapeJob.id} as key, ${field} as sort_value, 1 as matching
        from ${scrapeJob} where ${batchKey} is null and (${where ?? sql`true`})
        order by sort_value ${direction} nulls last, key ${direction}
        limit ${offset + query.size})
      union all
      select case when total = 1 then 'job' else 'batch' end,
        case when total = 1 then only_job_id else batch_id end, sort_value, matching
      from batch
    )`
  const [countResult, pageResult] = await Promise.all([
    db.execute(count),
    db.execute(sql`${entries} select kind, key, matching from entries
      order by sort_value ${direction} nulls last, key ${direction}, kind ${direction}
      limit ${query.size} offset ${offset}`),
  ])
  const totalCount =
    z.array(CountRowSchema).parse(countResult.rows)[0]?.count ?? 0
  const page = z.array(EntryRowSchema).parse(pageResult.rows)
  const batchIds = page.flatMap((row) =>
    row.kind === 'batch' ? [row.key] : [],
  )
  const [jobs, batches] = await Promise.all([
    loadListedJobs(
      page.flatMap((row) => (row.kind === 'job' ? [row.key] : [])),
    ).then(withJobWaiting),
    loadBatches(batchIds, now),
  ])
  const jobsById = new Map(jobs.map((job) => [job.id, job]))
  return {
    items: page.flatMap((row): JobEntry[] => {
      if (row.kind === 'job') {
        const job = jobsById.get(row.key)
        return job ? [{ kind: 'job', job }] : []
      }
      const batch = batches.get(row.key)
      return batch ? [{ ...batch, matching: row.matching }] : []
    }),
    totalCount,
    page: query.page,
    size: query.size,
    pageCount: Math.ceil(totalCount / query.size),
  }
}
