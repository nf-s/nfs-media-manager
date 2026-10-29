import { asc, eq, inArray, sql } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import { JsonValueSchema } from '@repo/schemas/common'
import type { db } from '@/lib/db'
import {
  mediaItem,
  providerSnapshot,
  scrapeJob,
  scrapeJobItem,
  scrapeJobLog,
} from '@/schemas/db'

type Database = typeof db
type Job = typeof scrapeJob.$inferSelect
type Item = typeof scrapeJobItem.$inferSelect
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]
const jsonObject = z.record(z.string(), JsonValueSchema)
const retryKeys: Array<'retryOf' | 'retryJobId'> = ['retryOf', 'retryJobId']

export type JobHistorySplitMapping = {
  originalJobId: string
  itemId: string
  mediaItemId: string
  mediaType: 'album' | 'film'
  jobId: string
  originalItemStatus: Item['status']
  status: 'succeeded' | 'failed' | 'cancelled'
}

async function inspectReferences(tx: Transaction, jobIds: string[]) {
  // Include DB-only foreign keys, notably legacy provider_cooldown_reset links.
  const result = await tx.execute(sql`
    select n.nspname as "schema", t.relname as "table", a.attname as "column"
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
    where c.contype = 'f' and c.confrelid = 'scrape_job'::regclass
    order by n.nspname, t.relname, a.attname
  `)
  const references = z
    .array(
      z.object({
        schema: z.string(),
        table: z.string(),
        column: z.string(),
      }),
    )
    .parse(result.rows)
  const counts = []
  for (const reference of references) {
    const count = jobIds.length
      ? await tx.execute(sql`
          select count(*)::integer as count
          from ${sql.identifier(reference.schema)}.${sql.identifier(reference.table)}
          where ${sql.identifier(reference.column)} in (${sql.join(
            jobIds.map((id) => sql`${id}`),
            sql`, `,
          )})
        `)
      : { rows: [{ count: 0 }] }
    const [row] = z
      .array(z.object({ count: z.number().int().nonnegative() }))
      .parse(count.rows)
    counts.push({ ...reference, affectedRows: row?.count ?? 0 })
  }
  return counts
}

/** Offline repair only: never imports the queue, providers or worker. */
export async function splitJobHistory(
  database: Database,
  options: {
    apply?: boolean
    writeReport?: (report: JobHistorySplitReport) => Promise<void>
  } = {},
) {
  return database.transaction(async (tx) => {
    if (!options.apply)
      await tx.execute(
        sql`set transaction isolation level repeatable read, read only`,
      )
    await tx.execute(sql`set local lock_timeout = '5s'`)
    await tx.execute(sql`select pg_advisory_xact_lock(614104)`)
    // The advisory lock coordinates enqueues; table locks also exclude workers,
    // dismissals and snapshot/log writers while the reviewed plan is applied.
    if (options.apply)
      await tx.execute(
        sql`lock table ${scrapeJob}, ${scrapeJobItem}, ${scrapeJobLog}, ${providerSnapshot}, ${mediaItem} in share row exclusive mode`,
      )

    const jobs = await tx.select().from(scrapeJob).orderBy(asc(scrapeJob.id))
    const items = await tx
      .select({ item: scrapeJobItem, mediaType: mediaItem.mediaType })
      .from(scrapeJobItem)
      .leftJoin(mediaItem, eq(mediaItem.id, scrapeJobItem.mediaItemId))
      .orderBy(asc(scrapeJobItem.createdAt), asc(scrapeJobItem.id))
    const byJob = new Map<string, typeof items>()
    for (const row of items) {
      const group = byJob.get(row.item.jobId) ?? []
      group.push(row)
      byJob.set(row.item.jobId, group)
    }
    const originals = jobs.filter((job) => (byJob.get(job.id)?.length ?? 0) > 1)
    const originalIds = originals.map((job) => job.id)
    const originalIdSet = new Set(originalIds)
    const jobsById = new Map(jobs.map((job) => [job.id, job]))
    const blockers: string[] = []
    const mapping: JobHistorySplitMapping[] = []
    for (const job of originals) {
      jsonObject.parse(job.options)
      jsonObject.parse(job.scope)
      if (job.status === 'queued' || job.status === 'running')
        blockers.push(
          `Active multi-item job ${job.id} (${job.status}); resolve separately.`,
        )
      const seen = new Set<string>()
      for (const [index, { item, mediaType }] of (
        byJob.get(job.id) ?? []
      ).entries()) {
        if (!item.mediaItemId || !mediaType) {
          blockers.push(
            `Item ${item.id} has no surviving media identity; resolve separately.`,
          )
          continue
        }
        if (seen.has(item.mediaItemId))
          blockers.push(
            `Job ${job.id} has duplicate media identity ${item.mediaItemId}; attribution is ambiguous.`,
          )
        seen.add(item.mediaItemId)
        mapping.push({
          originalJobId: job.id,
          itemId: item.id,
          mediaItemId: item.mediaItemId,
          mediaType,
          jobId: index === 0 ? job.id : nanoid(),
          originalItemStatus: item.status,
          status:
            item.status === 'queued' || item.status === 'running'
              ? 'cancelled'
              : item.status,
        })
      }
    }
    const mappedByJob = new Map<string, JobHistorySplitMapping[]>()
    for (const entry of mapping) {
      const group = mappedByJob.get(entry.originalJobId) ?? []
      group.push(entry)
      mappedByJob.set(entry.originalJobId, group)
    }
    function resolveRetry(targetId: string, mediaItemId: string, source: Job) {
      const target = jobsById.get(targetId)
      if (
        !target ||
        target.id === source.id ||
        target.provider !== source.provider
      )
        return null
      const targetItems = byJob.get(targetId) ?? []
      const matches = targetItems.filter(
        ({ item }) => item.mediaItemId === mediaItemId,
      )
      if (matches.length !== 1) return null
      if (!originalIdSet.has(targetId))
        return targetItems.length === 1 ? targetId : null
      return (
        mappedByJob
          .get(targetId)
          ?.find((entry) => entry.mediaItemId === mediaItemId)?.jobId ?? null
      )
    }
    // Single-item jobs are strictly immutable. Refuse rather than silently leave
    // an inbound retry pointing at a different item after retaining the old ID.
    for (const job of jobs) {
      if (originalIdSet.has(job.id)) continue
      for (const key of retryKeys) {
        const target = job.options[key]
        if (typeof target !== 'string' || !originalIdSet.has(target)) continue
        const members = byJob.get(job.id) ?? []
        const mediaId =
          members.length === 1 ? members[0]?.item.mediaItemId : null
        if (!mediaId || resolveRetry(target, mediaId, job) !== target)
          blockers.push(
            `Untouched job ${job.id}.${key} needs a per-item retry repair; resolve separately.`,
          )
      }
    }
    const unresolvedRetries: Array<{
      jobId: string
      key: string
      originalValue: unknown
    }> = []
    const plannedJobs: Array<{
      entry: JobHistorySplitMapping
      options: Job['options']
      errorMessage: string | null
    }> = []
    for (const entry of mapping) {
      const parent = jobsById.get(entry.originalJobId)
      const item = byJob
        .get(entry.originalJobId)
        ?.find((row) => row.item.id === entry.itemId)?.item
      if (!parent || !item) throw new Error('Incomplete split plan')
      const nextOptions = { ...parent.options }
      for (const key of retryKeys) {
        const originalValue = parent.options[key]
        if (originalValue === undefined || originalValue === null) continue
        const target =
          typeof originalValue === 'string'
            ? resolveRetry(originalValue, entry.mediaItemId, parent)
            : null
        if (target) nextOptions[key] = target
        else {
          delete nextOptions[key]
          unresolvedRetries.push({ jobId: entry.jobId, key, originalValue })
        }
      }
      nextOptions.batchId = parent.options.batchId ?? parent.id
      nextOptions.jobHistorySplit = {
        version: 1,
        originalJobId: parent.id,
        itemId: item.id,
        originalItemStatus: item.status,
        originalScope: parent.scope,
        originalStatus: parent.status,
        originalErrorMessage: parent.errorMessage,
        originalOptions: parent.options,
      }
      plannedJobs.push({
        entry,
        options: nextOptions,
        errorMessage: entry.status === 'succeeded' ? null : item.message,
      })
    }

    const logs = originalIds.length
      ? await tx
          .select()
          .from(scrapeJobLog)
          .where(inArray(scrapeJobLog.jobId, originalIds))
          .orderBy(asc(scrapeJobLog.id))
      : []
    const snapshots = originalIds.length
      ? await tx
          .select({
            id: providerSnapshot.id,
            jobId: providerSnapshot.scrapeJobId,
            mediaItemId: providerSnapshot.mediaItemId,
          })
          .from(providerSnapshot)
          .where(inArray(providerSnapshot.scrapeJobId, originalIds))
          .orderBy(asc(providerSnapshot.id))
      : []
    const logMoves: Array<{ id: string; jobId: string }> = []
    const logCopies: Array<{
      id: string
      sourceLogId: string
      jobId: string
      metadata: NonNullable<typeof scrapeJobLog.$inferSelect.metadata>
    }> = []
    const unattributedLogs: string[] = []
    for (const log of logs) {
      const metadata =
        log.metadata === null ? null : jsonObject.parse(log.metadata)
      const targets = mappedByJob.get(log.jobId) ?? []
      const mediaId = metadata?.mediaItemId
      const target =
        typeof mediaId === 'string'
          ? targets.find((entry) => entry.mediaItemId === mediaId)
          : undefined
      if (target) {
        if (target.jobId !== log.jobId)
          logMoves.push({ id: log.id, jobId: target.jobId })
      } else {
        if (mediaId !== undefined && mediaId !== null)
          unattributedLogs.push(log.id)
        for (const child of targets.filter(
          (entry) => entry.jobId !== log.jobId,
        )) {
          logCopies.push({
            id: nanoid(),
            sourceLogId: log.id,
            jobId: child.jobId,
            metadata: {
              ...metadata,
              jobHistorySplit: {
                version: 1,
                originalJobId: log.jobId,
                originalLogId: log.id,
                context: 'legacy-batch',
                explanation:
                  'Copied legacy batch context; not an item-specific event.',
                originalMetadata: metadata,
              },
            },
          })
        }
      }
    }
    const snapshotMoves: Array<{ id: string; jobId: string }> = []
    const unattributedSnapshots: string[] = []
    for (const snapshot of snapshots) {
      const target = snapshot.jobId
        ? mappedByJob
            .get(snapshot.jobId)
            ?.find((entry) => entry.mediaItemId === snapshot.mediaItemId)
        : undefined
      if (!target) unattributedSnapshots.push(snapshot.id)
      else if (target.jobId !== snapshot.jobId)
        snapshotMoves.push({ id: snapshot.id, jobId: target.jobId })
    }
    const report: JobHistorySplitReport = {
      mode: options.apply ? 'apply' : 'dry-run',
      applied: false,
      counts: {
        originalJobs: originals.length,
        items: mapping.length,
        newJobs: mapping.filter((entry) => entry.jobId !== entry.originalJobId)
          .length,
        cancelledStaleItems: mapping.filter(
          (entry) =>
            entry.originalItemStatus === 'queued' ||
            entry.originalItemStatus === 'running',
        ).length,
        movedLogs: logMoves.length,
        copiedSharedLogs: logCopies.length,
        movedSnapshots: snapshotMoves.length,
        clearedRetryLinks: unresolvedRetries.length,
      },
      blockers,
      mapping,
      unresolvedRetries,
      unattributedLogs,
      unattributedSnapshots,
      references: await inspectReferences(tx, originalIds),
      referencePolicy:
        'No job IDs deleted. Unattributed snapshots and other foreign keys, including cooldown resets, retain original job IDs.',
    }
    // Persist/fsync the complete mapping before the first mutation, inside locks.
    await options.writeReport?.(report)
    if (!options.apply) return report
    if (blockers.length)
      throw new Error(`Job history split refused: ${blockers.join(' ')}`)

    // Clone before updating originals. INSERT SELECT keeps timestamp precision,
    // including sub-millisecond values that JavaScript Date cannot represent.
    for (const { entry, options: jobOptions, errorMessage } of plannedJobs) {
      if (entry.jobId === entry.originalJobId) continue
      await tx.execute(sql`
        insert into ${scrapeJob} (id, provider, status, scope, options, confirm_broad_run,
          error_message, requested_by_user_id, started_at, finished_at, created_at, updated_at)
        select ${entry.jobId}, provider, ${entry.status},
          ${JSON.stringify({ mediaItemIds: [entry.mediaItemId], mediaType: entry.mediaType, limit: 1 })}::jsonb,
          ${JSON.stringify(jobOptions)}::jsonb, confirm_broad_run, ${errorMessage},
          requested_by_user_id, started_at, finished_at, created_at, updated_at
        from ${scrapeJob} where id = ${entry.originalJobId}
      `)
    }
    for (const { entry, options: jobOptions, errorMessage } of plannedJobs) {
      if (entry.jobId === entry.originalJobId)
        await tx
          .update(scrapeJob)
          .set({
            status: entry.status,
            scope: {
              mediaItemIds: [entry.mediaItemId],
              mediaType: entry.mediaType,
              limit: 1,
            },
            options: jobOptions,
            errorMessage,
            updatedAt: sql`${scrapeJob.updatedAt}`,
          })
          .where(eq(scrapeJob.id, entry.jobId))
      await tx
        .update(scrapeJobItem)
        .set({
          jobId: entry.jobId,
          status: entry.status,
          updatedAt: sql`${scrapeJobItem.updatedAt}`,
        })
        .where(eq(scrapeJobItem.id, entry.itemId))
    }
    for (const move of logMoves)
      await tx
        .update(scrapeJobLog)
        .set({ jobId: move.jobId })
        .where(eq(scrapeJobLog.id, move.id))
    for (const copy of logCopies)
      await tx.execute(sql`
        insert into ${scrapeJobLog} (id, job_id, level, message, metadata, created_at)
        select ${copy.id}, ${copy.jobId}, level, message, ${JSON.stringify(copy.metadata)}::jsonb, created_at
        from ${scrapeJobLog} where id = ${copy.sourceLogId}
      `)
    for (const move of snapshotMoves)
      await tx
        .update(providerSnapshot)
        .set({ scrapeJobId: move.jobId })
        .where(eq(providerSnapshot.id, move.id))
    return { ...report, applied: true }
  })
}

export type JobHistorySplitReport = {
  mode: 'apply' | 'dry-run'
  applied: boolean
  counts: {
    originalJobs: number
    items: number
    newJobs: number
    cancelledStaleItems: number
    movedLogs: number
    copiedSharedLogs: number
    movedSnapshots: number
    clearedRetryLinks: number
  }
  blockers: string[]
  mapping: JobHistorySplitMapping[]
  unresolvedRetries: Array<{
    jobId: string
    key: string
    originalValue: unknown
  }>
  unattributedLogs: string[]
  unattributedSnapshots: string[]
  references: Array<{
    schema: string
    table: string
    column: string
    affectedRows: number
  }>
  referencePolicy: string
}
