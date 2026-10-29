import {
  CreateJobSchema,
  BulkRetryJobsSchema,
  BulkDismissJobsSchema,
  BulkCancelJobsSchema,
  JobScopeSchema,
  JobListQuerySchema,
  JobActivitySchema,
  getJobDismissal,
  isRetryableJobStatus,
  isUnfinishedJobItem,
  type CreateJobInput,
  type BulkRetryJobsInput,
  type BulkRetryJobsResult,
  type BulkDismissJobsInput,
  type BulkDismissJobsResult,
  type BulkCancelJobsInput,
  type BulkCancelJobsResult,
  type Job,
  type JobPage,
} from '@repo/schemas/job'
import type { JsonValue } from '@repo/schemas/common'
import { z } from 'zod'
import {
  PluginResultSchema,
  ProviderRequestError,
  isProviderItemNotFoundError,
  type MediaProviderPlugin,
} from '@repo/media-plugin-sdk'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import {
  jobErrorDetails,
  jobErrorReview,
  jobLogSecrets,
  redactJobText,
} from '@/lib/job-errors'
import { resolveProviderSecrets } from '@/lib/provider-secrets'
import { createJobDiagnostics } from '@/lib/job-diagnostics'
import { canIdentifyMedia } from '@/lib/provider-identification'
import { sanitizeAlbumProviderResult } from '@/lib/spotify-audio-features'
import { importMediaTypeExpression } from '@/lib/import-media-type'
import { getScrapePlugin } from '@/plugins/registry'
import {
  libraryImport,
  providerCurrentState,
  scrapeJob,
  scrapeJobItem,
  scrapeJobLog,
} from '@/schemas/db'
import { applyProviderResultInTransaction } from '@/services/provider-state'
import {
  createProviderRequest,
  getProviderSafety,
  recordProviderFailure,
  recordProviderSuccess,
} from '@/services/provider-requests'

let workerRunning = false

type JobTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

// Original IDs never run again: retries always create a new job. The row lock
// fences every worker write against cancellation, including provider persistence.
async function withRunningJob(
  jobId: string,
  write: (tx: JobTransaction) => Promise<void>,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [job] = await tx
      .select()
      .from(scrapeJob)
      .where(eq(scrapeJob.id, jobId))
      .for('update')
    if (job?.status !== 'running') return false
    await write(tx)
    return true
  })
}

async function logJob(
  jobId: string,
  level: 'info' | 'warn' | 'error',
  message: string,
  metadata: Record<string, JsonValue> = {},
  database: Pick<typeof db, 'insert'> = db,
): Promise<void> {
  await database.insert(scrapeJobLog).values({
    id: nanoid(),
    jobId,
    level,
    message,
    metadata,
  })
}

function mapJob(
  jobRecord: {
    id: string
    provider: string
    status: Job['status']
    createdAt: Date
    startedAt: Date | null
    finishedAt: Date | null
    errorMessage: string | null
    scope: unknown
    options: Job['options']
    confirmBroadRun: boolean
    items: Array<{
      id: string
      mediaItemId: string | null
      mediaItem: { title: string; mediaType: 'album' | 'film' } | null
      provider: string
      status: Job['status']
      attemptCount: number
      message: string | null
      createdAt: Date
      startedAt: Date | null
      finishedAt: Date | null
    }>
    logs: Array<{
      id: string
      level: string
      message: string
      metadata: Job['logs'][number]['metadata']
      createdAt: Date
    }>
  },
  plugin: MediaProviderPlugin | null,
): Job {
  const parsedScope = JobScopeSchema.parse(jobRecord.scope)

  return {
    id: jobRecord.id,
    provider: jobRecord.provider,
    status: jobRecord.status,
    createdAt: jobRecord.createdAt.toISOString(),
    startedAt: jobRecord.startedAt?.toISOString() ?? null,
    finishedAt: jobRecord.finishedAt?.toISOString() ?? null,
    errorMessage: jobRecord.errorMessage ?? null,
    scope: parsedScope,
    options: jobRecord.options,
    confirmBroadRun: jobRecord.confirmBroadRun,
    items: jobRecord.items.map((item) => ({
      id: item.id,
      mediaItemId: item.mediaItemId ?? null,
      mediaTitle: item.mediaItem?.title ?? null,
      mediaType: item.mediaItem?.mediaType ?? null,
      provider: item.provider,
      status: item.status,
      attemptCount: item.attemptCount,
      message: item.message ?? null,
      createdAt: item.createdAt.toISOString(),
      startedAt: item.startedAt?.toISOString() ?? null,
      finishedAt: item.finishedAt?.toISOString() ?? null,
    })),
    logs: jobRecord.logs.map((item) => {
      const review = jobErrorReview(
        item.level === 'error' ? item.metadata : null,
        plugin,
      )
      return {
        id: item.id,
        level:
          item.level === 'warn' || item.level === 'error' ? item.level : 'info',
        message: item.message,
        metadata: item.metadata ?? null,
        createdAt: item.createdAt.toISOString(),
        ...review,
        canMarkBenign: jobRecord.status === 'failed' && review.canMarkBenign,
      }
    }),
  }
}

async function getJobRecord(jobId: string): Promise<Job | null> {
  const jobRecord = await db.query.scrapeJob.findFirst({
    where: (table, operators) => operators.eq(table.id, jobId),
    with: {
      items: {
        with: { mediaItem: { columns: { title: true, mediaType: true } } },
        orderBy: (table, operators) => [operators.asc(table.createdAt)],
      },
      logs: {
        orderBy: (table, operators) => [operators.asc(table.createdAt)],
      },
    },
  })

  if (!jobRecord) {
    return null
  }

  return mapJob(jobRecord, await getScrapePlugin(jobRecord.provider))
}

async function nextQueuedJob(
  excludedProviders: string[],
  activeJobIds: string[] = [],
) {
  return db.query.scrapeJob.findFirst({
    where: (table, operators) =>
      operators.and(
        operators.eq(table.status, 'queued'),
        activeJobIds.length
          ? operators.notInArray(table.id, activeJobIds)
          : undefined,
        excludedProviders.length
          ? operators.notInArray(table.provider, excludedProviders)
          : undefined,
        sql`not exists (
        select 1 from provider_request_state safety where safety.provider = ${table.provider}
        and (safety.halted or safety.cooldown_until > now() or safety.lease_until > now())
      )`,
      ),
    orderBy: (table, operators) => [
      operators.asc(table.createdAt),
      operators.asc(table.id),
    ],
    with: {
      items: {
        orderBy: (table, operators) => [operators.asc(table.createdAt)],
      },
    },
  })
}

type ProviderExecution = { failures: number; stopped: boolean }

export async function processQueuedJobs(
  shouldDispatch: () => boolean = () => true,
): Promise<void> {
  if (workerRunning) return
  workerRunning = true
  // Each job owns one media item and one slot belonging to its provider.
  const active = new Map<
    string,
    {
      provider: string
      completion: Promise<void>
    }
  >()
  const providers = new Map<string, ProviderExecution>()
  const errors: unknown[] = []
  let completed = 0
  try {
    for (; shouldDispatch() || active.size > 0; ) {
      const completedBefore = completed
      const excluded = new Set<string>()
      while (errors.length === 0 && shouldDispatch()) {
        for (const [provider, execution] of providers)
          if (execution.stopped) excluded.add(provider)
        const nextJob = await nextQueuedJob([...excluded], [...active.keys()])
        if (!nextJob) break
        const plugin = await getScrapePlugin(nextJob.provider)
        const concurrent =
          plugin?.manifest.rateLimit.concurrentRequests === true
        if (!concurrent) {
          const safety = await db.query.providerRequestState.findFirst({
            where: (table, operators) =>
              operators.eq(table.provider, nextJob.provider),
          })
          if (
            safety?.nextAllowedAt &&
            safety.nextAllowedAt.getTime() > Date.now()
          ) {
            excluded.add(nextJob.provider)
            continue
          }
        }
        const limit = concurrent
          ? (plugin?.manifest.rateLimit.maxConcurrent ?? 1)
          : 1
        const siblings = [...active.values()].filter(
          (job) => job.provider === nextJob.provider,
        )
        if (siblings.length >= limit) {
          excluded.add(nextJob.provider)
          continue
        }
        const execution = providers.get(nextJob.provider) ?? {
          failures: 0,
          stopped: false,
        }
        if (!shouldDispatch()) break
        providers.set(nextJob.provider, execution)
        const completion = processJob(nextJob, plugin, execution)
          .catch((error: unknown) => {
            execution.stopped = true
            errors.push(error)
          })
          .finally(() => {
            active.delete(nextJob.id)
            completed += 1
          })
        active.set(nextJob.id, {
          provider: nextJob.provider,
          completion,
        })
      }
      if (active.size === 0) {
        if (completed === completedBefore) break
      } else {
        // Refill on completion immediately; also discover work queued while a
        // slow request is in flight without spawning a second dispatcher.
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          await Promise.race([
            ...[...active.values()].map((job) => job.completion),
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, 250)
            }),
          ])
        } finally {
          if (timer !== undefined) clearTimeout(timer)
        }
      }
    }
    if (errors.length) throw errors[0]
  } finally {
    await Promise.all([...active.values()].map((job) => job.completion))
    workerRunning = false
  }
}

async function processJob(
  nextJob: NonNullable<Awaited<ReturnType<typeof nextQueuedJob>>>,
  plugin: MediaProviderPlugin | null,
  execution: ProviderExecution,
): Promise<void> {
  const [claimed] = await db
    .update(scrapeJob)
    .set({
      status: 'running',
      startedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(scrapeJob.id, nextJob.id), eq(scrapeJob.status, 'queued')))
    .returning({ id: scrapeJob.id })
  if (!claimed) return

  const item = nextJob.items[0]
  if (nextJob.items.length !== 1 || !item) {
    const message = 'Legacy multi-item jobs must be split before they can run.'
    await withRunningJob(nextJob.id, async (tx) => {
      await tx
        .update(scrapeJob)
        .set({
          status: 'failed',
          errorMessage: message,
          finishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(scrapeJob.id, nextJob.id))
      await tx
        .update(scrapeJobItem)
        .set({
          status: 'cancelled',
          message,
          finishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(scrapeJobItem.jobId, nextJob.id),
            eq(scrapeJobItem.status, 'queued'),
          ),
        )
      await logJob(nextJob.id, 'error', message, {}, tx)
    })
    return
  }

  if (!plugin?.scrapeMediaItem) {
    await withRunningJob(nextJob.id, async (tx) => {
      await tx
        .update(scrapeJob)
        .set({
          status: 'failed',
          errorMessage: 'No executable plugin is loaded for this provider.',
          finishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(scrapeJob.id, nextJob.id))
    })
    return
  }

  await withRunningJob(nextJob.id, (tx) =>
    logJob(nextJob.id, 'info', `Started job for ${nextJob.provider}`, {}, tx),
  )
  let stopped = false
  const stoppedError = new Error(
    'Stopped to protect provider limits. No retry scheduled.',
  )
  const assertActive = async () => {
    const job = await db.query.scrapeJob.findFirst({
      where: (table, operators) => operators.eq(table.id, nextJob.id),
      columns: { status: true },
    })
    if (job?.status !== 'running') throw new Error('Job is no longer running')
    if (stopped || execution.stopped) throw stoppedError
  }

  const scrapeMediaItem = plugin.scrapeMediaItem.bind(plugin)
  const processItem = async (item: (typeof nextJob.items)[number]) => {
    if (item.status !== 'queued') return
    const mediaItemId = item.mediaItemId

    if (!mediaItemId) {
      return
    }

    let itemStarted = false
    const started = await withRunningJob(nextJob.id, async (tx) => {
      if (stopped || execution.stopped) return
      const [claimedItem] = await tx
        .update(scrapeJobItem)
        .set({
          status: 'running',
          attemptCount: item.attemptCount + 1,
          startedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(scrapeJobItem.id, item.id),
            eq(scrapeJobItem.status, 'queued'),
          ),
        )
        .returning({ id: scrapeJobItem.id })
      itemStarted = claimedItem !== undefined
    })
    if (!started) stopped = true
    if (!itemStarted) return

    const mediaRecord = await db.query.mediaItem.findFirst({
      where: (table, operators) => operators.eq(table.id, mediaItemId),
      with: { credits: { with: { artist: true } } },
    })

    if (!mediaRecord) {
      await withRunningJob(nextJob.id, async (tx) => {
        await tx
          .update(scrapeJobItem)
          .set({
            status: 'failed',
            message: 'Media item not found.',
            finishedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(scrapeJobItem.id, item.id))
        await logJob(
          nextJob.id,
          'error',
          `Missing media item ${item.mediaItemId}`,
          {},
          tx,
        )
      })
      return
    }

    const references = await db.query.providerReference.findMany({
      where: (table, operators) => operators.eq(table.mediaItemId, mediaItemId),
    })
    const overrides = await db.query.providerReferenceOverride.findMany({
      where: (table, operators) =>
        operators.and(
          operators.eq(table.mediaItemId, mediaItemId),
          operators.or(
            operators.eq(table.provider, plugin.manifest.id),
            operators.inArray(table.provider, ['imdb', 'tmdb']),
          ),
        ),
      orderBy: (table, operators) => [
        operators.asc(table.createdAt),
        operators.asc(table.id),
      ],
    })
    const effectiveIds = new Map(
      overrides.map((override) => [
        override.referenceType,
        override.externalId,
      ]),
    )

    let secrets: Record<string, string> = {}
    let diagnostics: ReturnType<typeof createJobDiagnostics> | undefined
    try {
      const providerSecrets = await db.query.providerSecret.findMany({
        where: (table, operators) =>
          operators.eq(table.provider, plugin.manifest.id),
      })

      secrets = resolveProviderSecrets(
        plugin.manifest.id,
        providerSecrets,
        plugin.manifest.secrets,
      )
      diagnostics = createJobDiagnostics(jobLogSecrets(secrets))

      await assertActive()
      const scraped = PluginResultSchema.parse(
        await scrapeMediaItem({
          mediaItemId: mediaRecord.id,
          mediaType: mediaRecord.mediaType,
          media: {
            title: mediaRecord.title,
            artists: mediaRecord.credits
              .filter((credit) => credit.role === 'artist')
              .sort((a, b) => a.billingOrder - b.billingOrder)
              .map((credit) => credit.artist.name),
            releaseDate: mediaRecord.releaseDate?.toISOString(),
          },
          existingReferences: [
            ...[...effectiveIds].map(([referenceType, externalId]) => ({
              referenceType,
              externalId,
              isPrimary: true,
              metadata: { sourceProvider: plugin.manifest.id },
            })),
            ...references
              .filter((reference) => !effectiveIds.has(reference.referenceType))
              .sort(
                (a, b) =>
                  Number(b.provider === plugin.manifest.id) -
                  Number(a.provider === plugin.manifest.id),
              )
              .map((reference) => ({
                referenceType: reference.referenceType,
                externalId: reference.externalId,
                isPrimary: reference.isPrimary,
                metadata: {
                  ...reference.metadata,
                  sourceProvider: reference.provider,
                },
              })),
          ],
          secrets,
          request: createProviderRequest(plugin, assertActive),
          recordDiagnostic: diagnostics.recordDiagnostic,
          log: async (level: 'info' | 'warn' | 'error', message: string) => {
            await withRunningJob(nextJob.id, (tx) =>
              logJob(
                nextJob.id,
                level,
                redactJobText(message, jobLogSecrets(secrets)),
                { mediaItemId },
                tx,
              ),
            )
          },
        }),
      )
      const result =
        mediaRecord.mediaType === 'album'
          ? sanitizeAlbumProviderResult(scraped.payload, scraped.normalized)
          : scraped

      const saved = await withRunningJob(nextJob.id, async (tx) => {
        await applyProviderResultInTransaction(
          {
            mediaItemId: mediaRecord.id,
            mediaType: mediaRecord.mediaType,
            provider: plugin.manifest.id,
            source: 'scrape-job',
            payload: result.payload,
            normalized: result.normalized,
            scrapeJobId: nextJob.id,
          },
          tx,
        )

        await tx
          .update(scrapeJobItem)
          .set({
            status: 'succeeded',
            message: 'Completed successfully.',
            payload: result.payload,
            finishedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(scrapeJobItem.id, item.id))

        await logJob(
          nextJob.id,
          'info',
          `Completed ${mediaRecord.title}`,
          {
            mediaItemId,
          },
          tx,
        )
        await recordProviderSuccess(plugin.manifest.id)
        if (!execution.stopped) execution.failures = 0
      })
      if (!saved) return
    } catch (error) {
      const notFound = isProviderItemNotFoundError(error)
      const stoppedBeforeRequest = error === stoppedError
      const handled = await withRunningJob(nextJob.id, async (tx) => {
        if (!notFound && !stoppedBeforeRequest) {
          // Account only for still-active jobs, then latch before persistence.
          // Late errors from cancelled jobs must not stop sibling dispatch.
          execution.failures += 1
          if (
            execution.failures >= 2 ||
            (error instanceof ProviderRequestError &&
              (error.code === 'rate-limit' ||
                error.code === 'cooldown' ||
                error.code === 'access-denied'))
          )
            stopped = execution.stopped = true
          await recordProviderFailure(plugin, error)
        }
        const details = jobErrorDetails(error, jobLogSecrets(secrets))
        const message = `${details.name}: ${details.message}`.slice(0, 1000)
        const evidence = diagnostics?.snapshot() ?? []

        await tx
          .update(scrapeJobItem)
          .set({
            status: stoppedBeforeRequest ? 'cancelled' : 'failed',
            message,
            finishedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(scrapeJobItem.id, item.id))

        await logJob(
          nextJob.id,
          stoppedBeforeRequest ? 'warn' : 'error',
          message,
          {
            mediaItemId,
            error: details,
            ...(evidence.length ? { diagnostics: evidence } : {}),
            ...(notFound ? { classification: 'not-found' } : {}),
          },
          tx,
        )
        if (notFound || stoppedBeforeRequest) return
        const safety = await getProviderSafety(plugin.manifest.id)
        if (
          execution.failures >= 2 ||
          safety.halted ||
          safety.consecutiveFailures >= 2
        ) {
          await cancelQueuedJobs(
            { provider: plugin.manifest.id },
            'Stopped after repeated provider errors or access denial. Review the error before retrying.',
          )
        }
        if (
          stopped ||
          execution.stopped ||
          safety.halted ||
          safety.cooldownUntil
        ) {
          stopped = execution.stopped = true
          await logJob(
            nextJob.id,
            'warn',
            'Provider dispatch paused after errors or cooldown. No automatic retry scheduled.',
            {},
            tx,
          )
        }
      })
      if (!handled) stopped = true
    }
  }

  if (!stopped && !execution.stopped) await processItem(item)

  await withRunningJob(nextJob.id, async (tx) => {
    if (execution.stopped)
      await tx
        .update(scrapeJobItem)
        .set({
          status: 'cancelled',
          message: stoppedError.message,
          finishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(scrapeJobItem.jobId, nextJob.id),
            eq(scrapeJobItem.status, 'queued'),
          ),
        )
    const remainingFailures = await tx.query.scrapeJobItem.findMany({
      where: (table, operators) =>
        operators.and(
          operators.eq(table.jobId, nextJob.id),
          operators.inArray(table.status, ['failed', 'cancelled']),
        ),
    })
    const failedCount = remainingFailures.filter(
      (item) => item.status === 'failed',
    ).length

    await tx
      .update(scrapeJob)
      .set({
        status:
          failedCount > 0
            ? 'failed'
            : remainingFailures.length > 0
              ? 'cancelled'
              : 'succeeded',
        finishedAt: new Date(),
        errorMessage: remainingFailures[0]?.message ?? null,
        updatedAt: new Date(),
      })
      .where(eq(scrapeJob.id, nextJob.id))
  })
}

export async function createJob(
  input: CreateJobInput,
  userId: string | null,
  scheduling: {
    deferUntilReady?: boolean
    retryOf?: string
    skipExistingRetry?: boolean
    confirmRunning?: boolean
  } = {},
): Promise<Job> {
  const parsedInput = CreateJobSchema.parse(input)
  const plugin = await getScrapePlugin(parsedInput.provider)

  if (!plugin?.scrapeMediaItem) {
    throw new ServerError({
      statusCode: 422,
      message: 'Provider cannot be scraped',
      description:
        'This provider is not backed by a loaded scraping plugin in the current environment.',
    })
  }

  let mediaItemIds = parsedInput.scope.mediaItemIds

  if (
    (plugin.manifest.requireExplicitSelection &&
      !parsedInput.scope.mediaItemIds.length) ||
    (plugin.manifest.maxItemsPerJob !== undefined &&
      mediaItemIds.length > plugin.manifest.maxItemsPerJob)
  ) {
    throw new ServerError({
      statusCode: 422,
      message:
        'This provider requires a smaller, explicitly selected set of media items',
    })
  }
  const safety = await getProviderSafety(plugin.manifest.id)
  if (
    safety.halted ||
    (safety.cooldownUntil &&
      (!scheduling.deferUntilReady || safety.consecutiveFailures >= 2))
  )
    throw new ServerError({
      statusCode: 429,
      message: safety.halted
        ? 'Provider requests are halted after access denial'
        : `Provider is cooling down until ${safety.cooldownUntil}`,
    })

  const jobId = nanoid()
  const selectedItems = await db.query.mediaItem.findMany({
    where: (table, operators) => operators.inArray(table.id, mediaItemIds),
    with: { providerReferences: true, credits: { with: { artist: true } } },
  })
  const identifierTypes = plugin.manifest.identifierTypes ?? []
  if (
    selectedItems.some(
      (item) =>
        !canIdentifyMedia(plugin.manifest, {
          ...item,
          artists: item.credits
            .filter((credit) => credit.role === 'artist')
            .map((credit) => credit.artist.name),
        }),
    )
  )
    throw new ServerError({
      statusCode: 422,
      message: `Needs ${identifierTypes.join(' or ')} ID. Add an identifier before scraping.`,
    })
  if (
    selectedItems.length !== new Set(mediaItemIds).size ||
    selectedItems.some(
      (item) =>
        !plugin.manifest.mediaTypes.includes(item.mediaType) ||
        (parsedInput.scope.mediaType !== null &&
          item.mediaType !== parsedInput.scope.mediaType),
    )
  ) {
    throw new ServerError({
      statusCode: 422,
      message: 'Selection contains missing or unsupported media items',
    })
  }

  const queuedJobId = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(614104)`)
    // Link retries under the same lock as queue deduplication, before workers can see them.
    if (scheduling.retryOf) {
      const [original] = await tx
        .select()
        .from(scrapeJob)
        .where(eq(scrapeJob.id, scheduling.retryOf))
        .for('update')
      if (!original)
        throw new ServerError({ statusCode: 404, message: 'Job not found' })
      if (typeof original.options.retryJobId === 'string') {
        const [previous] = await tx
          .select({ id: scrapeJob.id })
          .from(scrapeJob)
          .where(eq(scrapeJob.id, original.options.retryJobId))
        if (previous) {
          if (scheduling.skipExistingRetry)
            throw new ServerError({
              statusCode: 409,
              message: 'Job already retried',
            })
          return previous.id
        }
      }
      if (
        !isRetryableJobStatus(original.status) ||
        (original.status === 'running' && !scheduling.confirmRunning)
      )
        throw new ServerError({
          statusCode: 409,
          message: 'Job is not retryable',
        })
      // A worker may have committed since retry preflight. Re-check under its
      // persistence lock before cancelling and selecting the replacement work.
      const items = await tx
        .select()
        .from(scrapeJobItem)
        .where(eq(scrapeJobItem.jobId, original.id))
      const states = await tx
        .select()
        .from(providerCurrentState)
        .where(eq(providerCurrentState.provider, original.provider))
      mediaItemIds = mediaItemIds.filter((id) => {
        const item = items.find((item) => item.mediaItemId === id)
        const checked = states.find(
          (state) => state.mediaItemId === id,
        )?.lastScrapedAt
        return (
          item &&
          isUnfinishedJobItem(item.status, original.status) &&
          (!checked || checked < original.createdAt)
        )
      })
      if (!mediaItemIds.length)
        throw new ServerError({
          statusCode: 409,
          message: 'No unfinished work remains',
        })
      if (original.status === 'running')
        await cancelActiveJobInTransaction(tx, original.id, userId, 'running')
      await tx
        .update(scrapeJob)
        .set({
          options: sql`${scrapeJob.options} || ${JSON.stringify({ retryJobId: jobId })}::jsonb`,
        })
        .where(eq(scrapeJob.id, original.id))
      await tx.insert(scrapeJobLog).values({
        id: nanoid(),
        jobId: original.id,
        level: 'info',
        message: 'Unfinished items queued for retry.',
        metadata: { retryJobId: jobId },
      })
    }
    const active = await tx
      .select({ id: scrapeJobItem.id })
      .from(scrapeJobItem)
      .innerJoin(scrapeJob, eq(scrapeJob.id, scrapeJobItem.jobId))
      .where(
        and(
          eq(scrapeJobItem.provider, parsedInput.provider),
          inArray(scrapeJobItem.mediaItemId, mediaItemIds),
          inArray(scrapeJobItem.status, ['queued', 'running']),
          inArray(scrapeJob.status, ['queued', 'running']),
        ),
      )
      .limit(1)
    if (active.length)
      throw new ServerError({
        statusCode: 409,
        message:
          'This provider already has queued or running work for this selection',
      })
    await tx.insert(scrapeJob).values({
      id: jobId,
      provider: parsedInput.provider,
      status: 'queued',
      scope: {
        ...parsedInput.scope,
        mediaItemIds,
      },
      options: parsedInput.options,
      confirmBroadRun: parsedInput.confirmBroadRun,
      requestedByUserId: userId,
    })

    for (const mediaItemId of mediaItemIds) {
      await tx.insert(scrapeJobItem).values({
        id: nanoid(),
        jobId,
        mediaItemId,
        provider: parsedInput.provider,
        status: 'queued',
        attemptCount: 0,
        payload: {},
      })
    }
    return jobId
  })

  if (queuedJobId === jobId)
    await logJob(
      jobId,
      'info',
      `Queued ${mediaItemIds.length} item(s) for ${parsedInput.provider}`,
    )

  const job = await getJobRecord(queuedJobId)

  if (!job) {
    throw new ServerError({
      statusCode: 500,
      message: 'Failed to create job',
    })
  }

  return job
}

export async function createRescrapeJob(
  mediaItemId: string,
  providerId: string,
  userId: string | null,
): Promise<Job> {
  const item = await db.query.mediaItem.findFirst({
    where: (table, operators) => operators.eq(table.id, mediaItemId),
  })
  if (!item)
    throw new ServerError({ statusCode: 404, message: 'Media item not found' })
  return createJob(
    {
      provider: providerId,
      scope: {
        mediaItemIds: [mediaItemId],
        mediaType: item.mediaType,
        limit: 1,
      },
      options: {},
      confirmBroadRun: true,
    },
    userId,
  )
}

function jobsNeedingAttention() {
  return and(
    inArray(scrapeJob.status, ['failed', 'cancelled']),
    sql`${scrapeJob.options}->>'retryJobId' is null`,
    sql`coalesce(${scrapeJob.options}->>'benignReviewed', 'false') <> 'true'`,
    sql`${scrapeJob.options}->'dismissal'->>'dismissedAt' is null`,
    sql`coalesce(${scrapeJob.options}->'cancellation'->>'requestedByUser', 'false') <> 'true'`,
    // A later successful scrape resolves an attempt without rewriting its history.
    // Missing/deleted item identities stay visible rather than being guessed away.
    sql`not (
      exists (select 1 from scrape_job_item resolved_item where resolved_item.job_id = ${scrapeJob.id})
      and not exists (
        select 1 from scrape_job_item unresolved_item
        where unresolved_item.job_id = ${scrapeJob.id}
          and not exists (
            select 1 from provider_current_state successful_state
            where successful_state.media_item_id = unresolved_item.media_item_id
              and successful_state.provider = ${scrapeJob.provider}
              and successful_state.last_scraped_at >= coalesce(unresolved_item.finished_at, ${scrapeJob.finishedAt}, ${scrapeJob.createdAt})
          )
      )
    )`,
  )
}

export async function listJobs(
  input: z.input<typeof JobListQuerySchema> = {},
): Promise<JobPage> {
  const query = JobListQuerySchema.parse(input)
  const pattern = `%${(query.q ?? '').replace(/[\\%_]/g, '\\$&')}%`
  const where = and(
    query.status === 'active'
      ? inArray(scrapeJob.status, ['queued', 'running'])
      : query.status === 'attention'
        ? jobsNeedingAttention()
        : query.status
          ? eq(scrapeJob.status, query.status)
          : undefined,
    query.provider ? eq(scrapeJob.provider, query.provider) : undefined,
    query.mediaType ? jobsInMediaScope(query.mediaType) : undefined,
    query.mediaItemId
      ? sql`(exists (
          select 1 from scrape_job_item history_item
          where history_item.job_id = ${scrapeJob.id}
            and history_item.media_item_id = ${query.mediaItemId}
        ) or ${scrapeJob.scope}->'mediaItemIds' @> ${JSON.stringify([query.mediaItemId])}::jsonb)`
      : undefined,
    query.batchId
      ? sql`${scrapeJob.options}->>'batchId' = ${query.batchId}`
      : undefined,
    query.q
      ? sql`(${scrapeJob.provider} ilike ${pattern} or ${scrapeJob.id} ilike ${pattern} or exists (
      select 1 from scrape_job_item i join media_item m on m.id = i.media_item_id where i.job_id = ${scrapeJob.id} and m.title ilike ${pattern}
    ))`
      : undefined,
  )
  const [count] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(scrapeJob)
    .where(where)
  const jobs = await db.query.scrapeJob.findMany({
    where,
    limit: query.size,
    offset: (query.page - 1) * query.size,
    orderBy: (table, operators) => [
      operators.desc(table.createdAt),
      operators.desc(table.id),
    ],
    with: {
      items: {
        columns: { payload: false },
        with: { mediaItem: { columns: { title: true, mediaType: true } } },
        orderBy: (table, operators) => [operators.asc(table.createdAt)],
      },
      logs: {
        columns: { metadata: false },
        extras: (table) => ({
          // Response JSON is fetched on demand from the job data endpoint.
          metadata: sql<
            Job['logs'][number]['metadata']
          >`case when jsonb_typeof(${table.metadata}) = 'object' then ${table.metadata} - 'diagnostics' else ${table.metadata} end`.as(
            'metadata',
          ),
        }),
        orderBy: (table, operators) => [operators.asc(table.createdAt)],
      },
    },
  })

  return {
    items: await Promise.all(
      jobs.map(async (jobRecord) =>
        mapJob(jobRecord, await getScrapePlugin(jobRecord.provider)),
      ),
    ),
    totalCount: count?.count ?? 0,
    page: query.page,
    size: query.size,
    pageCount: Math.ceil((count?.count ?? 0) / query.size),
  }
}

export async function getJob(jobId: string): Promise<Job | null> {
  return getJobRecord(jobId)
}

export async function markJobErrorBenign(
  jobId: string,
  logId: string,
  userId: string | null,
): Promise<Job> {
  const job = await getJobRecord(jobId)
  if (!job) throw new ServerError({ statusCode: 404, message: 'Job not found' })
  const plugin = await getScrapePlugin(job.provider)
  await db.transaction(async (tx) => {
    const [lockedJob] = await tx
      .select()
      .from(scrapeJob)
      .where(eq(scrapeJob.id, jobId))
      .for('update')
    if (!lockedJob || lockedJob.status !== 'failed')
      throw new ServerError({
        statusCode: 409,
        message: 'Only errors in finished failed jobs can be reviewed',
      })
    const [log] = await tx
      .select()
      .from(scrapeJobLog)
      .where(and(eq(scrapeJobLog.id, logId), eq(scrapeJobLog.jobId, jobId)))
      .for('update')
    if (!log || log.level !== 'error')
      throw new ServerError({ statusCode: 404, message: 'Error log not found' })
    const review = jobErrorReview(log.metadata, plugin)
    if (review.benignReview) return
    if (!review.canMarkBenign)
      throw new ServerError({
        statusCode: 422,
        message:
          'This error is not a recognized lookup miss. Provider safety errors cannot be marked benign.',
      })
    const metadata =
      log.metadata &&
      typeof log.metadata === 'object' &&
      !Array.isArray(log.metadata)
        ? log.metadata
        : {}
    await tx
      .update(scrapeJobLog)
      .set({
        metadata: {
          ...metadata,
          benignReview: { reviewedAt: new Date().toISOString(), userId },
        },
      })
      .where(eq(scrapeJobLog.id, log.id))
    const logs = await tx
      .select()
      .from(scrapeJobLog)
      .where(
        and(eq(scrapeJobLog.jobId, jobId), eq(scrapeJobLog.level, 'error')),
      )
    const items = await tx
      .select()
      .from(scrapeJobItem)
      .where(eq(scrapeJobItem.jobId, jobId))
    if (
      logs.length > 0 &&
      logs.every(
        (entry) => jobErrorReview(entry.metadata, plugin).benignReview,
      ) &&
      items.every(
        (item) =>
          item.status === 'succeeded' ||
          (item.status === 'failed' &&
            logs.some((entry) => {
              const data = entry.metadata
              return (
                data &&
                typeof data === 'object' &&
                !Array.isArray(data) &&
                item.mediaItemId !== null &&
                data.mediaItemId === item.mediaItemId
              )
            })),
      )
    ) {
      await tx
        .update(scrapeJob)
        .set({
          options: { ...lockedJob.options, benignReviewed: true },
          updatedAt: new Date(),
        })
        .where(eq(scrapeJob.id, jobId))
    }
  })
  const reviewed = await getJobRecord(jobId)
  if (!reviewed)
    throw new ServerError({ statusCode: 404, message: 'Job not found' })
  return reviewed
}

export async function dismissJob(
  jobId: string,
  userId: string | null,
  skipExistingDismissal = false,
): Promise<Job> {
  await db.transaction(async (tx) => {
    const [job] = await tx
      .select()
      .from(scrapeJob)
      .where(eq(scrapeJob.id, jobId))
      .for('update')
    if (!job)
      throw new ServerError({ statusCode: 404, message: 'Job not found' })
    if (job.status !== 'failed' && job.status !== 'cancelled')
      throw new ServerError({
        statusCode: 409,
        message: 'Only failed or cancelled jobs can be dismissed',
      })
    if (getJobDismissal(job.options)) {
      if (skipExistingDismissal)
        throw new ServerError({
          statusCode: 409,
          message: 'Job already dismissed',
        })
      return
    }
    await tx
      .update(scrapeJob)
      .set({
        options: {
          ...job.options,
          dismissal: { dismissedAt: new Date().toISOString(), userId },
        },
        updatedAt: new Date(),
      })
      .where(eq(scrapeJob.id, jobId))
  })
  const job = await getJobRecord(jobId)
  if (!job) throw new ServerError({ statusCode: 404, message: 'Job not found' })
  return job
}

export async function getJobActivity() {
  const albums = jobsInMediaScope('album')
  const films = jobsInMediaScope('film')
  const importScope = importMediaTypeExpression(libraryImport.result)
  const [counts] = await db
    .select({
      queued: sql<number>`count(*) filter (where status = 'queued')::int`,
      running: sql<number>`count(*) filter (where status = 'running')::int`,
      completed: sql<number>`count(*) filter (where status = 'succeeded')::int`,
      failed: sql<number>`count(*) filter (where ${jobsNeedingAttention()})::int`,
      albumQueued: sql<number>`count(*) filter (where status = 'queued' and ${albums})::int`,
      albumRunning: sql<number>`count(*) filter (where status = 'running' and ${albums})::int`,
      albumFailed: sql<number>`count(*) filter (where ${jobsNeedingAttention()} and ${albums})::int`,
      filmQueued: sql<number>`count(*) filter (where status = 'queued' and ${films})::int`,
      filmRunning: sql<number>`count(*) filter (where status = 'running' and ${films})::int`,
      filmFailed: sql<number>`count(*) filter (where ${jobsNeedingAttention()} and ${films})::int`,
    })
    .from(scrapeJob)
  const [imports] = await db
    .select({
      count: sql<number>`count(*) filter (where status in ('queued', 'running'))::int`,
      completed: sql<number>`count(*) filter (where status in ('succeeded', 'failed'))::int`,
      albumCount: sql<number>`count(*) filter (where status in ('queued', 'running') and ${importScope} = 'album')::int`,
      filmCount: sql<number>`count(*) filter (where status in ('queued', 'running') and ${importScope} = 'film')::int`,
    })
    .from(libraryImport)
  return JobActivitySchema.parse({
    queued: counts?.queued ?? 0,
    running: counts?.running ?? 0,
    failed: counts?.failed ?? 0,
    imports: imports?.count ?? 0,
    completed: counts?.completed ?? 0,
    completedImports: imports?.completed ?? 0,
    libraries: [
      {
        mediaType: 'album',
        queued: counts?.albumQueued ?? 0,
        running: counts?.albumRunning ?? 0,
        failed: counts?.albumFailed ?? 0,
        imports: imports?.albumCount ?? 0,
      },
      {
        mediaType: 'film',
        queued: counts?.filmQueued ?? 0,
        running: counts?.filmRunning ?? 0,
        failed: counts?.filmFailed ?? 0,
        imports: imports?.filmCount ?? 0,
      },
    ],
  })
}

function jobsInMediaScope(mediaType: 'album' | 'film') {
  return sql`(${scrapeJob.scope}->>'mediaType' = ${mediaType} or exists (
    select 1 from scrape_job_item scoped_item join media_item scoped_media on scoped_media.id = scoped_item.media_item_id
    where scoped_item.job_id = ${scrapeJob.id} and scoped_media.media_type = ${mediaType}
  ))`
}

export async function cancelQueuedJobs(
  selection: { provider?: string; batchId?: string },
  reason = 'Cancelled by user. No further requests scheduled.',
) {
  const jobs = await db
    .update(scrapeJob)
    .set({ status: 'cancelled', errorMessage: reason, finishedAt: new Date() })
    .where(
      and(
        eq(scrapeJob.status, 'queued'),
        selection.provider
          ? eq(scrapeJob.provider, selection.provider)
          : undefined,
        selection.batchId
          ? sql`${scrapeJob.options}->>'batchId' = ${selection.batchId}`
          : undefined,
      ),
    )
    .returning({ id: scrapeJob.id })
  for (const job of jobs) {
    await db
      .update(scrapeJobItem)
      .set({ status: 'cancelled', message: reason, finishedAt: new Date() })
      .where(
        and(
          eq(scrapeJobItem.jobId, job.id),
          eq(scrapeJobItem.status, 'queued'),
        ),
      )
    await logJob(job.id, 'warn', reason)
  }
  return { cancelled: jobs.length }
}

async function cancelActiveJobInTransaction(
  tx: JobTransaction,
  jobId: string,
  userId: string | null,
  status: 'queued' | 'running',
): Promise<void> {
  const reason =
    status === 'queued'
      ? 'Cancelled by user before execution. No requests scheduled.'
      : 'Cancelled by user. In-flight results will be discarded.'
  const now = new Date()
  await tx
    .update(scrapeJob)
    .set({
      status: 'cancelled',
      errorMessage: reason,
      finishedAt: now,
      updatedAt: now,
      options: sql`${scrapeJob.options} || ${JSON.stringify({ cancellation: { requestedByUser: true, userId, cancelledAt: now.toISOString() } })}::jsonb`,
    })
    .where(eq(scrapeJob.id, jobId))
  await tx
    .update(scrapeJobItem)
    .set({
      status: 'cancelled',
      message: reason,
      finishedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(scrapeJobItem.jobId, jobId),
        inArray(scrapeJobItem.status, ['queued', 'running']),
      ),
    )
  await logJob(jobId, 'warn', reason, { userId }, tx)
}

export async function bulkCancelJobs(
  input: BulkCancelJobsInput,
  userId: string | null,
): Promise<BulkCancelJobsResult> {
  const { jobIds, confirmRunning } = BulkCancelJobsSchema.parse(input)
  const results: BulkCancelJobsResult['results'] = []
  for (const jobId of jobIds) {
    try {
      await db.transaction(async (tx) => {
        const [job] = await tx
          .select()
          .from(scrapeJob)
          .where(eq(scrapeJob.id, jobId))
          .for('update')
        if (!job || (job.status !== 'running' && job.status !== 'queued'))
          throw new ServerError({
            statusCode: 409,
            message: 'Job is no longer queued or running',
          })
        if (job.status === 'running' && !confirmRunning)
          throw new ServerError({
            statusCode: 409,
            message: 'Job is running. Confirm cancellation of in-flight work.',
          })
        await cancelActiveJobInTransaction(tx, jobId, userId, job.status)
      })
      results.push({ jobId, status: 'cancelled' })
    } catch (error) {
      results.push(bulkJobFailure(jobId, error))
    }
  }
  return {
    cancelled: results.filter((result) => result.status === 'cancelled').length,
    skipped: results.filter((result) => result.status === 'skipped').length,
    results,
  }
}

export async function retryJob(
  jobId: string,
  userId: string | null,
  confirmBroadRun: boolean,
  skipExistingRetry = false,
  confirmRunning = false,
): Promise<Job> {
  const original = await getJobRecord(jobId)
  if (!original)
    throw new ServerError({ statusCode: 404, message: 'Job not found' })
  if (typeof original.options.retryJobId === 'string') {
    const previous = await getJobRecord(original.options.retryJobId)
    if (previous) {
      if (skipExistingRetry)
        throw new ServerError({
          statusCode: 409,
          message: 'Job already retried',
        })
      return previous
    }
  }
  if (
    !isRetryableJobStatus(original.status) ||
    (original.status === 'running' && !confirmRunning)
  )
    throw new ServerError({
      statusCode: 409,
      message:
        original.status === 'running'
          ? 'Running jobs require explicit cancellation confirmation before retry'
          : 'Only unfinished failed or cancelled work can be retried',
    })
  const states = await db
    .select()
    .from(providerCurrentState)
    .where(eq(providerCurrentState.provider, original.provider))
  const mediaItemIds = original.items.flatMap((item) => {
    const checked = states.find(
      (state) => state.mediaItemId === item.mediaItemId,
    )?.lastScrapedAt
    return item.mediaItemId &&
      isUnfinishedJobItem(item.status, original.status) &&
      (!checked || checked < new Date(original.createdAt))
      ? [item.mediaItemId]
      : []
  })
  if (!mediaItemIds.length)
    throw new ServerError({
      statusCode: 409,
      message: 'These items have already been scraped successfully',
    })
  return createJob(
    {
      provider: original.provider,
      scope: { ...original.scope, mediaItemIds },
      options: {
        ...original.options,
        benignReviewed: false,
        dismissal: null,
        cancellation: null,
        retryJobId: null,
        retryOf: original.id,
      },
      confirmBroadRun,
    },
    userId,
    { retryOf: original.id, skipExistingRetry, confirmRunning },
  )
}

export async function bulkRetryJobs(
  input: BulkRetryJobsInput,
  userId: string | null,
): Promise<BulkRetryJobsResult> {
  const { jobIds, confirmBroadRun, confirmRunning } =
    BulkRetryJobsSchema.parse(input)
  const originals = await db.query.scrapeJob.findMany({
    where: (table, operators) => operators.inArray(table.id, jobIds),
    with: { items: true },
  })
  // Conservatively count unfinished items before any retry can write, not just jobs.
  const unfinishedCount = originals.reduce(
    (count, job) =>
      count +
      (isRetryableJobStatus(job.status) &&
      (job.status !== 'running' || confirmRunning) &&
      typeof job.options.retryJobId !== 'string'
        ? job.items.filter(
            (item) =>
              item.mediaItemId !== null &&
              isUnfinishedJobItem(item.status, job.status),
          ).length
        : 0),
    0,
  )
  if (unfinishedCount > 5 && !confirmBroadRun)
    throw new ServerError({
      statusCode: 422,
      message: 'Broad scraping must be confirmed',
      description:
        'Selections with more than five unfinished items require confirmBroadRun to be set to true.',
    })

  const results: BulkRetryJobsResult['results'] = []
  for (const jobId of jobIds) {
    const original = originals.find((job) => job.id === jobId)
    if (
      !original ||
      !isRetryableJobStatus(original.status) ||
      (original.status === 'running' && !confirmRunning) ||
      typeof original.options.retryJobId === 'string'
    ) {
      results.push({
        jobId,
        status: 'skipped',
        message:
          original?.status === 'running' && !confirmRunning
            ? 'Confirm cancellation of running work before retrying.'
            : 'Job is missing, already retried, or has no retryable work.',
      })
      continue
    }
    try {
      const retry = await retryJob(
        jobId,
        userId,
        confirmBroadRun,
        true,
        confirmRunning,
      )
      results.push({ jobId, status: 'queued', retryJobId: retry.id })
    } catch (error) {
      results.push(bulkJobFailure(jobId, error))
    }
  }
  return {
    queued: results.filter((result) => result.status === 'queued').length,
    skipped: results.filter((result) => result.status === 'skipped').length,
    results,
  }
}

function bulkJobFailure(
  jobId: string,
  error: unknown,
): { jobId: string; status: 'skipped' | 'failed'; message: string } {
  const statusCode =
    error instanceof ServerError ? error.response.statusCode : 500
  return {
    jobId,
    status: statusCode === 404 || statusCode === 409 ? 'skipped' : 'failed',
    message:
      statusCode === 404
        ? 'Job no longer exists.'
        : statusCode === 409
          ? 'Job was already handled or is no longer eligible for this action.'
          : statusCode === 429
            ? 'Provider is cooling down or halted. Review provider safety before retrying.'
            : statusCode === 422
              ? 'Provider or media selection is unavailable or invalid. Review the job before retrying.'
              : 'Unable to update this job. Refresh job history before trying again.',
  }
}

export async function bulkDismissJobs(
  input: BulkDismissJobsInput,
  userId: string | null,
): Promise<BulkDismissJobsResult> {
  const { jobIds } = BulkDismissJobsSchema.parse(input)
  const results: BulkDismissJobsResult['results'] = []
  for (const jobId of jobIds) {
    try {
      await dismissJob(jobId, userId, true)
      results.push({ jobId, status: 'dismissed' })
    } catch (error) {
      results.push(bulkJobFailure(jobId, error))
    }
  }
  return {
    dismissed: results.filter((result) => result.status === 'dismissed').length,
    skipped: results.filter((result) => result.status === 'skipped').length,
    results,
  }
}
