import {
  CreateJobSchema,
  BulkRetryJobsSchema,
  BulkDismissJobsSchema,
  BulkCancelJobsSchema,
  CancelJobBatchSchema,
  JobScopeSchema,
  JobListQuerySchema,
  JobActivitySchema,
  JobActivityStageSchema,
  getJobActivityStage,
  getJobDismissal,
  getJobProgressCount,
  getJobTask,
  isRetryableJobStatus,
  isUnfinishedJobItem,
  JobProgressSchema,
  type CreateJobInput,
  type BulkRetryJobsInput,
  type BulkRetryJobsResult,
  type BulkDismissJobsInput,
  type BulkDismissJobsResult,
  type BulkCancelJobsInput,
  type BulkCancelJobsResult,
  type CancelJobBatchInput,
  type Job,
  type JobPage,
  type JobProgress,
} from '@repo/schemas/job'
import type { JsonValue } from '@repo/schemas/common'
import { canIdentifyMedia } from '@repo/schemas/provider-identification'
import {
  ARTIST_ENRICHMENT_TASK,
  ArtistProviderIdSchema,
} from '@repo/schemas/artist-profiles'
import {
  LASTFM_SCROBBLE_SYNC_TASK,
  LASTFM_SPOTIFY_SEARCH_TASK,
} from '@repo/schemas/lastfm'
import {
  SPOTIFY_PLAYLIST_ADD_ALBUM_TASK,
  SPOTIFY_PLAYLIST_IMPORT_TASK,
  SPOTIFY_PLAYLIST_LISTING_TASK,
} from '@repo/schemas/tracks'
import { SPOTIFY_PLAYLIST_ADD_TRACK_TASK } from '@repo/schemas/track-playlist-additions'
import { SPOTIFY_ARTIST_ALBUMS_TASK } from '@repo/schemas/spotify-artist-albums'
import { SPOTIFY_TRACK_ALBUM_LOOKUP_TASK } from '@repo/schemas/spotify-album-reference'
import {
  SPOTIFY_TRACK_SEARCH_TASK,
  SpotifyTrackSearchFreshnessSchema,
  SpotifyTrackSearchParamsSchema,
} from '@repo/schemas/spotify-track-search'
import {
  SPOTIFY_SIMILAR_LOOKUP_TASK,
  TIDAL_SIMILAR_TASK,
  TIDAL_TRACK_MATCH_TASK,
  TidalSimilarKindSchema,
  TidalTrackMatchParamsSchema,
} from '@repo/schemas/tidal'
import {
  SONOVAULT_SIMILAR_LOOKUP_TASK,
  SONOVAULT_TRACK_LOOKUP_TASK,
  SonovaultTrackLookupParamsSchema,
} from '@repo/schemas/sonovault'
import {
  SONOVAULT_ALBUM_LOOKUP_TASK,
  SonovaultAlbumLookupParamsSchema,
} from '@repo/schemas/sonovault-album'
import { YOUTUBE_SYNC_TASK } from '@repo/schemas/youtube'
import {
  MIX_STATION_SYNC_TASKS,
  MIX_SYNC_TASKS,
  MixStationSchema,
  SPOTIFY_PODCAST_SYNC_TASK,
  SUBSCRIPTION_SYNC_TASKS,
} from '@repo/schemas/subscriptions'
import { z } from 'zod'
import {
  PluginResultSchema,
  ProviderItemNotFoundError,
  ProviderRequestError,
  isProviderItemAmbiguousError,
  isProviderItemNotFoundError,
  type MediaProviderPlugin,
  type PluginReference,
} from '@repo/media-plugin-sdk'
import { and, asc, desc, eq, inArray, or, sql } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { db } from '@/lib/db'
import {
  createAlbumMatchRejectionPredicate,
  effectiveReferenceOverrides,
} from '@/lib/album-match-identities'
import { ServerError } from '@/lib/error'
import {
  jobErrorDetails,
  jobErrorReview,
  jobLogSecrets,
  redactJobText,
} from '@/lib/job-errors'
import { resolveProviderSecrets } from '@/lib/provider-secrets'
import {
  createJobDiagnostics,
  providerResponseEvidence,
} from '@/lib/job-diagnostics'
import {
  createProviderResponseRecorder,
  providerResponseSecretValues,
  ProviderResponseStorageError,
} from '@/lib/provider-response-history'
import { scrapeMediaType } from '@/lib/scrape-media-type'
import { sanitizeAlbumProviderResult } from '@/lib/spotify-audio-features'
import { importMediaTypeExpression } from '@/lib/import-media-type'
import { createDatabaseReadCache } from '@/lib/database-read-cache'
import { writeRequestLog } from '@/lib/request-log'
import { jobActivityEnding } from '@/lib/job-stage-history'
import { env } from '@/env'
import { dispatchPriorityOrder } from '@/lib/job-dispatch-order'
import { getScrapePlugin, listLoadedScrapePlugins } from '@/plugins/registry'
import {
  artistProviderCurrentState,
  artistProviderSnapshot,
  libraryImport,
  providerCurrentState,
  scrapeJob,
  scrapeJobItem,
  scrapeJobLog,
} from '@/schemas/db'
import { applyProviderResultInTransaction } from '@/services/provider-state'
import { hasBlockedFilmReference } from '@/services/film-reference-state'
import { readAlbumMatchRejections } from '@/services/album-match-rejections'
import { getProviderReferenceHints } from '@/services/provider-reference-hints'
import { getAlbumReleaseHints } from '@/services/album-release-hints'
import {
  IN_REQUEST_SLOT_WAIT_MS,
  MAX_CONSECUTIVE_PROVIDER_FAILURES,
} from '@/lib/request-policy'
import {
  resumeJobProvider,
  wakeJobProvider,
} from '@/services/job-dispatch-context'
import type { CloudJobOutcome } from '@/services/cloud-job-contract'
import { withJobWaiting } from '@/services/job-waiting'
import { describeJob } from '@/services/job-summary'
import { withJobSubjects } from '@/services/job-subjects'
import {
  prepareLastfmSyncRun,
  runLastfmSyncJob,
  type LastfmSyncJobContext,
  type LastfmSyncJobResult,
} from '@/services/lastfm-scrobbles'
import {
  prepareYoutubeSyncRun,
  runYoutubeSyncJob,
} from '@/services/youtube-sync'
import {
  createProviderRequest,
  getProviderSafety,
  recordProviderFailure,
  recordProviderSuccess,
} from '@/services/provider-requests'
import { saveProviderResponseCapture } from './provider-response-history'
import {
  prepareLastfmSpotifySearch,
  runLastfmSpotifySearch,
} from '@/services/lastfm-spotify-search'
import {
  prepareSpotifyPlaylistImport,
  runSpotifyPlaylistImport,
} from '@/services/spotify-playlists'
import {
  prepareSpotifyPlaylistListing,
  runSpotifyPlaylistListing,
} from '@/services/spotify-playlist-listing'
import {
  prepareSpotifyArtistAlbums,
  runSpotifyArtistAlbums,
} from '@/services/spotify-artist-albums'
import {
  prepareSpotifyTrackAlbumLookup,
  runSpotifyTrackAlbumLookup,
} from '@/services/spotify-album-reference'
import {
  prepareSpotifyPlaylistAddition,
  runSpotifyPlaylistAddition,
} from '@/services/spotify-playlist-additions'
import {
  prepareSpotifyPodcastSyncRun,
  runSpotifyPodcastSyncJob,
} from '@/services/spotify-podcast-sync'
import {
  prepareMixStationSyncRun,
  runMixStationSyncJob,
} from '@/services/mix-station-sync'
import {
  prepareSpotifyTrackPlaylistAddition,
  runSpotifyTrackPlaylistAddition,
} from '@/services/spotify-track-playlist-additions'
import {
  prepareSpotifyTrackSearch,
  runSpotifyTrackSearch,
  validateQueuedSpotifyTrackSearch,
} from '@/services/spotify-track-search'
import {
  prepareTidalTrackMatch,
  runTidalTrackMatch,
} from '@/services/tidal-track-match'
import { prepareTidalSimilar, runTidalSimilar } from '@/services/tidal-similar'
import {
  prepareSonovaultTrackLookup,
  runSonovaultTrackLookup,
} from '@/services/sonovault-track-lookup'
import { runSonovaultTrackNameLookup } from '@/services/sonovault-track-candidates'
import {
  prepareSonovaultSimilarLookup,
  runSonovaultSimilarLookup,
} from '@/services/sonovault-similar-lookup'
import {
  prepareSonovaultAlbumLookup,
  runSonovaultAlbumLookup,
} from '@/services/sonovault-album-lookup'
import {
  prepareSpotifySimilarLookup,
  runSpotifySimilarLookup,
} from '@/services/spotify-similar-lookup'
import {
  collectAlbumArtistProfiles,
  prepareArtistEnrichment,
  runArtistEnrichment,
} from '@/services/artist-enrichment'
import {
  loadArtistProviderTarget,
  saveArtistProviderResult,
} from '@/services/artist-profiles'

let workerRunning = false

type JobTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

// Original IDs never run again: retries always create a new job. The row lock
// fences every worker write against cancellation, including provider persistence.
export async function withRunningJob(
  jobId: string,
  write: (
    tx: JobTransaction,
    job: typeof scrapeJob.$inferSelect,
  ) => Promise<void>,
  lock: 'update' | 'no key update' = 'update',
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [job] = await tx
      .select()
      .from(scrapeJob)
      .where(eq(scrapeJob.id, jobId))
      .for(lock)
    if (job?.status !== 'running') return false
    await write(tx, job)
    return true
  })
}

export async function logJob(
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

export type JobActivityProgress = {
  done?: number
  total?: number
  unit?: string
}

function jobActivityWriter(jobId: string) {
  // The current count is saved as work advances. Persist milestone log rows
  // at most twice per minute per stage, except when the full count is reached.
  let lastMilestoneAt = 0
  let activeStage: string | undefined
  const activity = async (stage: string, progress?: JobActivityProgress) => {
    let stageEvent: Parameters<typeof writeRequestLog>[0] | undefined
    await withRunningJob(
      jobId,
      async (tx, job) => {
        const now = new Date()
        const current = getJobActivityStage(job.options)
        const stageChanged =
          current?.stage !== stage || current.unit !== progress?.unit
        if (stageChanged)
          stageEvent = {
            event: 'job.activity',
            outcome: 'stage',
            stage,
            ...(current
              ? {
                  previousStage: current.stage,
                  previousDurationMs: Math.max(
                    0,
                    now.getTime() - Date.parse(current.startedAt),
                  ),
                }
              : {}),
          }
        const next = JobActivityStageSchema.parse({
          stage,
          ...progress,
          startedAt: stageChanged ? now.toISOString() : current.startedAt,
        })
        if (
          !stageChanged &&
          current.done === next.done &&
          current.total === next.total
        )
          return
        const value = JSON.stringify({ activity: next })
        await tx
          .update(scrapeJob)
          .set({
            options: sql`${scrapeJob.options} || ${value}::jsonb`,
            updatedAt: now,
          })
          .where(eq(scrapeJob.id, jobId))
        const done = next.done !== undefined && next.done === next.total
        if (stageChanged || done || now.getTime() - lastMilestoneAt >= 30_000) {
          await logJob(
            jobId,
            'info',
            stage,
            {
              activity: next,
              ...(stageChanged ? jobActivityEnding(job.options, now) : {}),
            },
            tx,
          )
          lastMilestoneAt = now.getTime()
        }
      },
      // Catalog evidence may hold a foreign-key share lock on the same job
      // while an import runs. This still serializes writes and cancellation.
      'no key update',
    )
    if (stageEvent) {
      activeStage = stage
      writeRequestLog(stageEvent)
    }
  }
  return { activity, activeStage: () => activeStage }
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
      mediaItem: { title: string; mediaType: string } | null
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
    progress: getJobProgressCount(jobRecord.options),
    items: jobRecord.items.map((item) => ({
      id: item.id,
      mediaItemId: item.mediaItemId ?? null,
      mediaTitle: item.mediaItem?.title ?? null,
      mediaType: item.mediaItem
        ? scrapeMediaType(item.mediaItem.mediaType)
        : null,
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
      dispatchPriorityOrder(table.options),
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

type ProviderExecution = {
  failures: number
  stopped: boolean
  /** Set for a job run in the request: how long a request waits for a slot. */
  maxSlotWaitMs?: number
  /** When a job run in the request stopped at a cooldown or a busy slot. */
  rateLimitedUntil?: number
}

/** Notes a cooldown or busy slot that stopped a job run in the request. */
function noteRateLimit(execution: ProviderExecution, error: unknown) {
  if (execution.maxSlotWaitMs === undefined) return
  let current: unknown = error
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    if (
      current instanceof ProviderRequestError &&
      (current.code === 'cooldown' || current.code === 'rate-limit')
    ) {
      execution.rateLimitedUntil = current.retryAt ?? Date.now()
      return
    }
    current = current.cause
  }
}

function rateLimitedInRequest(displayName: string, until: number) {
  const seconds = Math.max(1, Math.ceil((until - Date.now()) / 1000))
  return new ServerError({
    statusCode: 429,
    message: `${displayName} is rate limited. Try again in ${seconds} ${seconds === 1 ? 'second' : 'seconds'}.`,
  })
}

/** The 429 that refuses new work while the provider is halted or cooling down. */
function providerSafetyRefusal(
  plugin: MediaProviderPlugin | null,
  safety: Awaited<ReturnType<typeof getProviderSafety>>,
) {
  if (!safety.halted && safety.cooldownUntil && plugin?.manifest.runsInRequest)
    return rateLimitedInRequest(
      plugin.manifest.displayName,
      Date.parse(safety.cooldownUntil),
    )
  return new ServerError({
    statusCode: 429,
    message: safety.halted
      ? 'Provider requests are halted after access denial'
      : `Provider is cooling down until ${safety.cooldownUntil}`,
  })
}

export interface QueuedJobExecution {
  canContinue(): Promise<boolean>
  recordOutcome(outcome: CloudJobOutcome): Promise<void>
}

class JobExecutionControlError extends Error {}

// The Queue/DO owns the provider slot; the conditional Postgres transition is
// still the sole authority to execute an original job ID at most once.
export async function processQueuedJobById(
  jobId: string,
  provider: string,
  control: QueuedJobExecution,
): Promise<void> {
  const job = await db.query.scrapeJob.findFirst({
    where: (table, operators) =>
      operators.and(
        operators.eq(table.id, jobId),
        operators.eq(table.provider, provider),
        operators.eq(table.status, 'queued'),
      ),
    with: { items: true },
  })
  if (!job || !(await control.canContinue())) return
  await processJob(
    job,
    await getScrapePlugin(provider),
    {
      failures: 0,
      stopped: false,
    },
    control,
  )
}

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
        if (plugin?.manifest.localWorkerRequired) {
          excluded.add(nextJob.provider)
          continue
        }
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
  control?: QueuedJobExecution,
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
  await runClaimedJob(nextJob, plugin, execution, control)
}

/** Runs a job this process has set running. */
async function runClaimedJob(
  nextJob: NonNullable<Awaited<ReturnType<typeof nextQueuedJob>>>,
  plugin: MediaProviderPlugin | null,
  execution: ProviderExecution,
  control?: QueuedJobExecution,
): Promise<void> {
  const task = getJobTask(nextJob.options)
  if (task !== null) {
    await processTaskJob(nextJob, task, plugin, execution, control)
    return
  }

  const item = nextJob.items[0]
  if (
    nextJob.items.length !== 1 ||
    !item ||
    item.provider !== nextJob.provider
  ) {
    const message =
      'Jobs must contain exactly one item for the same provider. Legacy jobs must be split before they can run.'
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
    writeRequestLog({
      event: 'job.activity',
      outcome: 'failed',
      stage: 'Validating metadata job',
    })
    return
  }

  if (!plugin?.scrapeMediaItem) {
    const message = 'No executable plugin is loaded for this provider.'
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
      await logJob(nextJob.id, 'error', message, {}, tx)
    })
    writeRequestLog({
      event: 'job.activity',
      outcome: 'failed',
      stage: 'Loading metadata provider',
    })
    return
  }

  await withRunningJob(nextJob.id, (tx) =>
    logJob(nextJob.id, 'info', `Started job for ${nextJob.provider}`, {}, tx),
  )
  const { activity, activeStage } = jobActivityWriter(nextJob.id)
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
    if (control) {
      let active: boolean
      try {
        active = await control.canContinue()
      } catch (cause) {
        throw new JobExecutionControlError('Cloud job ownership check failed', {
          cause,
        })
      }
      if (!active) {
        stopped = execution.stopped = true
        throw stoppedError
      }
    }
  }

  const scrapeMediaItem = plugin.scrapeMediaItem.bind(plugin)
  const processItem = async (item: (typeof nextJob.items)[number]) => {
    if (item.status !== 'queued') return
    const mediaItemId = item.mediaItemId

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

    await activity('Preparing metadata lookup')
    const storedRecord = mediaItemId
      ? await db.query.mediaItem.findFirst({
          where: (table, operators) => operators.eq(table.id, mediaItemId),
          with: { credits: { with: { artist: true } } },
        })
      : null
    // A library track is never queued for scraping; treat one as missing.
    const storedType = storedRecord
      ? scrapeMediaType(storedRecord.mediaType)
      : null
    const mediaRecord =
      storedRecord && storedType
        ? { ...storedRecord, mediaType: storedType }
        : null

    if (!mediaRecord || !mediaItemId) {
      await withRunningJob(nextJob.id, async (tx, job) => {
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
          'Media item not found.',
          jobActivityEnding(job.options, new Date()),
          tx,
        )
      })
      writeRequestLog({
        event: 'job.activity',
        outcome: 'failed',
        stage: 'Preparing metadata lookup',
      })
      return
    }

    const storedReferences = await db.query.providerReference.findMany({
      where: (table, operators) => operators.eq(table.mediaItemId, mediaItemId),
    })
    const storedOverrides = await db.query.providerReferenceOverride.findMany({
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
    let secrets: Record<string, string> = {}
    let diagnostics: ReturnType<typeof createJobDiagnostics> | undefined
    let storageError:
      | (() => ProviderResponseStorageError | undefined)
      | undefined
    let succeeded = false
    try {
      const rejections =
        mediaRecord.mediaType === 'album'
          ? await readAlbumMatchRejections(db, mediaItemId)
          : []
      const isRejectedMatch = createAlbumMatchRejectionPredicate(
        plugin.manifest.id,
        rejections,
      )
      const { active, latestCount, keepStoredReference } =
        effectiveReferenceOverrides(storedOverrides, isRejectedMatch)
      const blockedFilmReference = (
        reference: Pick<PluginReference, 'referenceType' | 'externalId'>,
      ) =>
        mediaRecord.mediaType === 'film' &&
        hasBlockedFilmReference(storedReferences, reference)
      const overrides = active.filter(
        (reference) => !blockedFilmReference(reference),
      )
      const references = storedReferences.filter(
        (reference) =>
          keepStoredReference(reference) &&
          !isRejectedMatch(reference) &&
          !blockedFilmReference(reference),
      )
      const effectiveIds = new Map(
        overrides.map(({ referenceType, externalId }) => [
          referenceType,
          externalId,
        ]),
      )
      const providerSecrets = await db.query.providerSecret.findMany({
        where: (table, operators) =>
          operators.eq(table.provider, plugin.manifest.id),
      })

      secrets = resolveProviderSecrets(
        plugin.manifest.id,
        providerSecrets,
        plugin.manifest.secrets,
      )
      diagnostics = createJobDiagnostics(jobLogSecrets(secrets), {
        protectProviderResponses:
          plugin.sanitizeResponseCapture !== undefined ||
          plugin.sanitizeNativeJsonResponseCapture !== undefined,
      })

      const referenceHints = await getProviderReferenceHints({
        provider: plugin.manifest.id,
        mediaType: mediaRecord.mediaType,
        mediaItemId,
        existingReferences: [...references, ...overrides],
      })
      const capture = createProviderResponseRecorder(
        (capture, artistId) =>
          saveProviderResponseCapture({
            jobId: nextJob.id,
            jobItemId: item.id,
            provider: plugin.manifest.id,
            attempt: item.attemptCount + 1,
            artistId,
            capture,
          }),
        providerResponseSecretValues(secrets),
        plugin.sanitizeResponseCapture,
        plugin.sanitizeNativeJsonResponseCapture,
      )
      storageError = capture.storageError
      const requestFor = (artistId?: string) =>
        createProviderRequest(plugin, assertActive, {
          ...(execution.maxSlotWaitMs === undefined
            ? {}
            : { maxSlotWaitMs: execution.maxSlotWaitMs }),
          beginResponseCapture: capture(
            artistId ? 'artist' : 'media',
            artistId,
          ),
          onRetry: async ({ error, attempt, retryAt }) => {
            const credentials = jobLogSecrets(secrets)
            const details = jobErrorDetails(error, credentials)
            const evidence = providerResponseEvidence(error, credentials)
            const message =
              `Retrying request (attempt ${attempt}) after ${details.name}: ${details.message}`.slice(
                0,
                1000,
              )
            await withRunningJob(nextJob.id, (tx) =>
              logJob(
                nextJob.id,
                'warn',
                message,
                {
                  mediaItemId,
                  error: details,
                  attempt,
                  retryAt: new Date(retryAt).toISOString(),
                  ...(evidence.length ? { diagnostics: evidence } : {}),
                },
                tx,
              ),
            )
          },
        })
      const request = requestFor()
      const artists = mediaRecord.credits
        .filter((credit) => credit.role === 'artist')
        .sort((a, b) => a.billingOrder - b.billingOrder)
        .map(({ artist: { id, name } }) => ({ id, name }))
      const availableHints = referenceHints.filter(
        (reference) => !isRejectedMatch(reference),
      )
      const artistNames = artists.map(({ name }) => name)
      if (
        (references.length < storedReferences.length ||
          overrides.length < latestCount ||
          availableHints.length < referenceHints.length) &&
        !canIdentifyMedia(plugin.manifest, {
          ...mediaRecord,
          artists: artistNames,
          providerReferences: [
            ...references,
            ...overrides,
            ...availableHints.map((hint) => ({
              ...hint,
              provider: plugin.manifest.id,
            })),
          ],
        })
      )
        throw new ProviderItemNotFoundError(
          mediaRecord.mediaType === 'film'
            ? 'The film reference was rejected or is unverified.'
            : 'The album match was previously rejected.',
        )
      const releaseHints =
        mediaRecord.mediaType === 'album' && plugin.manifest.albumReleaseHints
          ? await getAlbumReleaseHints(
              mediaItemId,
              rejections,
              plugin.manifest.id === 'discogs' ||
                plugin.manifest.id === 'lastfm',
            )
          : undefined
      if (
        mediaRecord.mediaType === 'album' &&
        plugin.manifest.bootstrapAlbumArtists
      )
        await activity('Checking artist profiles')
      const artistProfiles =
        mediaRecord.mediaType === 'album' &&
        plugin.manifest.bootstrapAlbumArtists
          ? await collectAlbumArtistProfiles(
              plugin,
              artists,
              {
                secrets,
                requestFor,
                recordDiagnostic: diagnostics.recordDiagnostic,
              },
              assertActive,
              async (artistId, result) => {
                capture.assertStored()
                await withRunningJob(nextJob.id, (tx) =>
                  saveArtistProviderResult(
                    artistId,
                    plugin.manifest.id,
                    { ...result, scrapeJobId: nextJob.id },
                    tx,
                    { onlyIfMissing: true },
                  ),
                )
              },
            )
          : undefined
      await assertActive()
      await activity('Fetching provider metadata')
      const scraped = PluginResultSchema.parse(
        await scrapeMediaItem({
          mediaItemId: mediaRecord.id,
          mediaType: mediaRecord.mediaType,
          options: nextJob.options,
          media: {
            title: mediaRecord.title,
            artists: artistNames,
            releaseDate: mediaRecord.releaseDate?.toISOString(),
            ...(releaseHints?.length ? { releaseHints } : {}),
          },
          existingReferences: [
            ...[...effectiveIds].map(([referenceType, externalId]) => ({
              referenceType,
              externalId,
              isPrimary: true,
              metadata: {
                sourceProvider: plugin.manifest.id,
                manualOverride: true,
              },
            })),
            ...references
              .filter((reference) => !effectiveIds.has(reference.referenceType))
              .sort(
                (a, b) =>
                  Number(b.provider === plugin.manifest.id) -
                  Number(a.provider === plugin.manifest.id),
              )
              .map((reference) => {
                const metadata = { ...reference.metadata }
                // Only reviewed override rows may grant manual-match authority.
                delete metadata['manualOverride']
                return {
                  referenceType: reference.referenceType,
                  externalId: reference.externalId,
                  isPrimary: reference.isPrimary,
                  metadata: {
                    ...metadata,
                    sourceProvider: reference.provider,
                  },
                }
              }),
            ...availableHints,
          ],
          ...(rejections.length ? { isRejectedMatch } : {}),
          secrets,
          request,
          ...(artistProfiles === undefined ? {} : { artistProfiles }),
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
      capture.assertStored()
      const result =
        mediaRecord.mediaType === 'album'
          ? sanitizeAlbumProviderResult(scraped.payload, scraped.normalized)
          : scraped

      await activity('Saving provider metadata')
      const saved = await withRunningJob(nextJob.id, async (tx, job) => {
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
          'Saved provider metadata.',
          {
            mediaItemId,
            ...jobActivityEnding(job.options, new Date()),
          },
          tx,
        )
        await recordProviderSuccess(plugin.manifest.id)
        if (!execution.stopped) execution.failures = 0
      })
      if (!saved) return
      succeeded = true
    } catch (caught) {
      if (caught instanceof JobExecutionControlError) throw caught
      const error = storageError?.() ?? caught
      const evidenceStorageFailed =
        error instanceof ProviderResponseStorageError
      const classification = isProviderItemNotFoundError(error)
        ? 'not-found'
        : isProviderItemAmbiguousError(error)
          ? 'ambiguous'
          : null
      const stoppedBeforeRequest = error === stoppedError
      noteRateLimit(execution, error)
      const handled = await withRunningJob(nextJob.id, async (tx, job) => {
        if (
          !classification &&
          !stoppedBeforeRequest &&
          !evidenceStorageFailed
        ) {
          // Account only for still-active jobs, then latch before persistence.
          // Late errors from cancelled jobs must not stop sibling dispatch.
          execution.failures += 1
          if (
            execution.failures >= MAX_CONSECUTIVE_PROVIDER_FAILURES ||
            (error instanceof ProviderRequestError &&
              (error.code === 'rate-limit' ||
                error.code === 'cooldown' ||
                error.code === 'access-denied'))
          )
            stopped = execution.stopped = true
          await recordProviderFailure(plugin, error)
        }
        const credentials = jobLogSecrets(secrets)
        const details = jobErrorDetails(error, credentials)
        const message = `${details.name}: ${details.message}`.slice(0, 1000)
        const evidence = [
          ...(diagnostics?.snapshot() ?? []),
          ...providerResponseEvidence(error, credentials),
        ]

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
            ...jobActivityEnding(job.options, new Date()),
            ...(evidence.length ? { diagnostics: evidence } : {}),
            ...(classification ? { classification } : {}),
          },
          tx,
        )
        if (classification || stoppedBeforeRequest || evidenceStorageFailed)
          return
        const safety = await getProviderSafety(plugin.manifest.id)
        if (
          execution.failures >= MAX_CONSECUTIVE_PROVIDER_FAILURES ||
          safety.halted ||
          safety.consecutiveFailures >= MAX_CONSECUTIVE_PROVIDER_FAILURES
        ) {
          // Controlled dispatch may select only a canary, not the backlog.
          // Latch persisted failures too so its outcome stops the coordinator.
          if (control) stopped = execution.stopped = true
          else
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
      if (handled && !stoppedBeforeRequest)
        writeRequestLog({
          event: 'job.activity',
          outcome: 'failed',
          stage: activeStage() ?? 'Fetching provider metadata',
        })
      if (!handled) stopped = true
      else if (!classification && !stoppedBeforeRequest)
        await control?.recordOutcome(execution.stopped ? 'stopped' : 'failure')
    }
    if (succeeded) await control?.recordOutcome('success')
  }

  if (!stopped && !execution.stopped) await processItem(item)

  await withRunningJob(nextJob.id, async (tx, job) => {
    if (execution.stopped) {
      const stoppedItems = await tx
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
        .returning({ id: scrapeJobItem.id })
      if (stoppedItems.length)
        await logJob(
          nextJob.id,
          'warn',
          stoppedError.message,
          jobActivityEnding(job.options, new Date()),
          tx,
        )
    }
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

// Task work has a provider and a task name instead of a media item.
// It still runs through the provider's dispatcher, cooldowns and cancellation.
export type TaskJobResult = LastfmSyncJobResult & {
  failureClassification?: 'not-found' | 'ambiguous'
  metadata?: Record<string, JsonValue>
  options?: Record<string, JsonValue>
  /** The scope a continuation job needs to resume its own checkpoint. */
  nextOptions?: Record<string, JsonValue>
  /** A completed check with no upstream calls must preserve provider failure tracking. */
  noProviderRequests?: boolean
  persist?(tx: JobTransaction): Promise<void>
}

export interface TaskJobContext extends LastfmSyncJobContext {
  jobId: string
  requestedByUserId: string | null
  /**
   * Set when the job runs in the request: the task passes it to
   * `createProviderRequest` so a busy provider refuses instead of waiting.
   */
  maxSlotWaitMs?: number
  /** Records how far the job has read, in `options.progress`. */
  progress(progress: JobProgress): Promise<void>
  activity(stage: string, progress?: JobActivityProgress): Promise<void>
}

type TaskJobDefinition = {
  provider: string | ((options: Record<string, JsonValue>) => string | null)
  runsInRequest?: boolean
  prepare(
    userId: string | null,
    options: Record<string, JsonValue>,
  ): Promise<Record<string, JsonValue>>
  run(
    context: TaskJobContext,
    options: Record<string, JsonValue>,
  ): Promise<TaskJobResult>
}

/**
 * Tasks that run before a provider's other queued jobs (`dispatchPriority`,
 * highest first): a Sonovault similar-track lookup has someone waiting on a
 * screen, and bulk track lookups come before the album jobs that read them.
 */
const taskDispatchPriority = new Map<string, number>([
  [SONOVAULT_SIMILAR_LOOKUP_TASK, 2],
  [SONOVAULT_TRACK_LOOKUP_TASK, 1],
])

const taskJobs = new Map<string, TaskJobDefinition>([
  [
    ARTIST_ENRICHMENT_TASK,
    {
      provider: (options) => {
        const provider = ArtistProviderIdSchema.safeParse(options.provider)
        return provider.success ? provider.data : null
      },
      prepare: prepareArtistEnrichment,
      run: runArtistEnrichment,
    },
  ],
  [
    LASTFM_SCROBBLE_SYNC_TASK,
    {
      provider: 'lastfm',
      prepare: async (userId) => {
        await prepareLastfmSyncRun(userId)
        return {}
      },
      run: (context) => runLastfmSyncJob(context),
    },
  ],
  [
    LASTFM_SPOTIFY_SEARCH_TASK,
    {
      provider: 'spotify',
      prepare: prepareLastfmSpotifySearch,
      run: runLastfmSpotifySearch,
    },
  ],
  [
    SPOTIFY_TRACK_SEARCH_TASK,
    {
      provider: 'spotify',
      prepare: prepareSpotifyTrackSearch,
      run: runSpotifyTrackSearch,
    },
  ],
  [
    SPOTIFY_TRACK_ALBUM_LOOKUP_TASK,
    {
      provider: 'spotify',
      runsInRequest: true,
      prepare: prepareSpotifyTrackAlbumLookup,
      run: runSpotifyTrackAlbumLookup,
    },
  ],
  [
    TIDAL_TRACK_MATCH_TASK,
    {
      provider: 'tidal',
      prepare: prepareTidalTrackMatch,
      run: runTidalTrackMatch,
    },
  ],
  [
    SONOVAULT_TRACK_LOOKUP_TASK,
    {
      provider: 'sonovault',
      prepare: prepareSonovaultTrackLookup,
      // Tracks with neither ID are looked up by artist and title (stage 4).
      run: (context, input) =>
        input.inputType === 'track_name'
          ? runSonovaultTrackNameLookup(context, input)
          : runSonovaultTrackLookup(context, input),
    },
  ],
  [
    SONOVAULT_SIMILAR_LOOKUP_TASK,
    {
      provider: 'sonovault',
      prepare: prepareSonovaultSimilarLookup,
      run: runSonovaultSimilarLookup,
    },
  ],
  [
    SONOVAULT_ALBUM_LOOKUP_TASK,
    {
      provider: 'sonovault',
      prepare: prepareSonovaultAlbumLookup,
      run: runSonovaultAlbumLookup,
    },
  ],
  [
    TIDAL_SIMILAR_TASK,
    {
      provider: 'tidal',
      prepare: prepareTidalSimilar,
      run: runTidalSimilar,
    },
  ],
  [
    SPOTIFY_SIMILAR_LOOKUP_TASK,
    {
      provider: 'spotify',
      prepare: prepareSpotifySimilarLookup,
      run: runSpotifySimilarLookup,
    },
  ],
  [
    SPOTIFY_PLAYLIST_IMPORT_TASK,
    {
      provider: 'spotify',
      prepare: prepareSpotifyPlaylistImport,
      run: runSpotifyPlaylistImport,
    },
  ],
  [
    SPOTIFY_PLAYLIST_LISTING_TASK,
    {
      provider: 'spotify',
      prepare: prepareSpotifyPlaylistListing,
      run: runSpotifyPlaylistListing,
    },
  ],
  [
    SPOTIFY_ARTIST_ALBUMS_TASK,
    {
      provider: 'spotify',
      prepare: prepareSpotifyArtistAlbums,
      run: runSpotifyArtistAlbums,
    },
  ],
  [
    SPOTIFY_PLAYLIST_ADD_TRACK_TASK,
    {
      provider: 'spotify',
      prepare: prepareSpotifyTrackPlaylistAddition,
      run: runSpotifyTrackPlaylistAddition,
    },
  ],
  [
    SPOTIFY_PLAYLIST_ADD_ALBUM_TASK,
    {
      provider: 'spotify',
      prepare: prepareSpotifyPlaylistAddition,
      run: runSpotifyPlaylistAddition,
    },
  ],
  [
    YOUTUBE_SYNC_TASK,
    {
      provider: 'youtube',
      prepare: async (userId) => {
        await prepareYoutubeSyncRun(userId)
        return {}
      },
      run: (context) => runYoutubeSyncJob(context),
    },
  ],
  [
    SPOTIFY_PODCAST_SYNC_TASK,
    {
      provider: 'spotify',
      prepare: async (userId) => {
        await prepareSpotifyPodcastSyncRun(userId)
        return {}
      },
      run: (context) => runSpotifyPodcastSyncJob(context),
    },
  ],
  ...MixStationSchema.options.map((station): [string, TaskJobDefinition] => [
    MIX_STATION_SYNC_TASKS[station],
    {
      provider: station,
      prepare: async (userId) => {
        await prepareMixStationSyncRun(station, userId)
        return {}
      },
      run: (context) => runMixStationSyncJob(station, context),
    },
  ]),
])

function taskProvider(
  definition: TaskJobDefinition,
  options: Record<string, JsonValue>,
) {
  return typeof definition.provider === 'string'
    ? definition.provider
    : definition.provider(options)
}

/**
 * Queues a task job within the caller's transaction, with the options its
 * prepare step returned. It runs on the provider's next dispatch.
 */
export async function insertPreparedTaskJob(
  tx: JobTransaction,
  task: string,
  userId: string | null,
  prepared: Record<string, JsonValue>,
) {
  const definition = taskJobs.get(task)
  const provider = definition && taskProvider(definition, prepared)
  if (!provider) throw new Error('Unknown job task')
  return insertTaskJob(
    tx,
    provider,
    { task, ...prepared },
    userId,
    `Queued for ${provider}`,
  )
}

const SimilarScopeSchema = z.object({
  kind: TidalSimilarKindSchema,
  itemId: z.string().min(1),
})

async function insertTaskJob(
  tx: JobTransaction,
  provider: string,
  options: Record<string, JsonValue>,
  userId: string | null,
  message: string,
  inRequest = false,
): Promise<string> {
  const jobId = nanoid()
  // Artist, subscription and mix tasks have no album or film media item scope.
  const nonMediaTask =
    options.task === ARTIST_ENRICHMENT_TASK ||
    options.task === SPOTIFY_ARTIST_ALBUMS_TASK ||
    SUBSCRIPTION_SYNC_TASKS.some((task) => task === options.task) ||
    MIX_SYNC_TASKS.some((task) => task === options.task)
  const trackSearch =
    options.task === SPOTIFY_TRACK_SEARCH_TASK ||
    options.task === SPOTIFY_TRACK_ALBUM_LOOKUP_TASK
      ? SpotifyTrackSearchParamsSchema.parse(options)
      : options.task === TIDAL_TRACK_MATCH_TASK
        ? TidalTrackMatchParamsSchema.parse(options)
        : null
  const similar =
    options.task === TIDAL_SIMILAR_TASK ||
    options.task === SPOTIFY_SIMILAR_LOOKUP_TASK ||
    options.task === SONOVAULT_SIMILAR_LOOKUP_TASK
      ? SimilarScopeSchema.parse(options)
      : null
  const albumLookup =
    options.task === SONOVAULT_ALBUM_LOOKUP_TASK
      ? SonovaultAlbumLookupParamsSchema.parse(options)
      : null
  const scopeItem = similar
    ? { id: similar.itemId, mediaType: similar.kind }
    : trackSearch
      ? { id: trackSearch.trackId, mediaType: 'track' }
      : albumLookup
        ? { id: albumLookup.albumId, mediaType: 'album' }
        : null
  // A Sonovault lookup is one bulk request for up to 100 tracks.
  const lookupTracks =
    options.task === SONOVAULT_TRACK_LOOKUP_TASK
      ? SonovaultTrackLookupParamsSchema.parse({
          trackIds: options.trackIds,
          inputType: options.inputType,
        }).trackIds
      : null
  await tx.insert(scrapeJob).values({
    id: jobId,
    provider,
    // A job run in the request is never queued, so no dispatcher can take it.
    status: inRequest ? 'running' : 'queued',
    startedAt: inRequest ? new Date() : null,
    scope: {
      mediaItemIds: lookupTracks ?? (scopeItem ? [scopeItem.id] : []),
      mediaType: lookupTracks
        ? 'track'
        : scopeItem
          ? scopeItem.mediaType
          : nonMediaTask
            ? null
            : 'album',
      limit: 1,
    },
    options,
    confirmBroadRun: false,
    requestedByUserId: userId,
  })
  await logJob(jobId, 'info', message, {}, tx)
  return jobId
}

async function linkCreatedJobRetry(
  tx: JobTransaction,
  original: typeof scrapeJob.$inferSelect,
  retryJobId: string,
  userId: string | null,
  message: string,
): Promise<void> {
  const options: Record<string, JsonValue> = { retryJobId }
  if (original.status === 'failed' && !getJobDismissal(original.options))
    options.dismissal = { dismissedAt: new Date().toISOString(), userId }

  await tx
    .update(scrapeJob)
    .set({
      options: sql`${scrapeJob.options} || ${JSON.stringify(options)}::jsonb`,
    })
    .where(eq(scrapeJob.id, original.id))
  await logJob(original.id, 'info', message, { retryJobId }, tx)
}

/**
 * Queues a task job, or returns the one already queued or running. With
 * `retryOf`, a newly queued replacement links to the original and dismisses it if failed.
 * Unless `scheduled`, the request is the owner's and restarts a dispatcher
 * that stopped after errors; a cooldown or access halt still refuses it.
 */
export async function createTaskJob(
  task: string,
  userId: string | null,
  scheduling: {
    retryOf?: string
    skipExistingRetry?: boolean
    confirmRunning?: boolean
    scheduled?: boolean
    taskOptions?: Record<string, JsonValue>
    skipActive?: boolean
  } = {},
): Promise<Job> {
  const definition = taskJobs.get(task)
  if (!definition)
    throw new ServerError({ statusCode: 422, message: 'Unknown job task' })
  const input = { ...scheduling.taskOptions }
  delete input.activity
  delete input.providerReplaySteps
  const provider = taskProvider(definition, input)
  if (!provider)
    throw new ServerError({ statusCode: 422, message: 'Invalid task provider' })
  const plugin = await getScrapePlugin(provider)
  const inRequest =
    definition.runsInRequest === true || plugin?.manifest.runsInRequest === true
  const safety = await getProviderSafety(provider)
  if (safety.halted || safety.cooldownUntil)
    throw providerSafetyRefusal(plugin, safety)
  const prepared = await definition.prepare(userId, input)
  const trackSearch =
    task === SPOTIFY_TRACK_SEARCH_TASK
      ? SpotifyTrackSearchParamsSchema.parse(prepared)
      : null
  const artistId =
    task === ARTIST_ENRICHMENT_TASK && typeof prepared.artistId === 'string'
      ? prepared.artistId
      : null
  const batchId = scheduling.taskOptions?.batchId
  const dispatchPriority = taskDispatchPriority.get(task)
  const taskOptions = {
    ...prepared,
    ...(typeof batchId === 'string' ? { batchId } : {}),
    ...(dispatchPriority ? { dispatchPriority } : {}),
  }

  let created = false
  const jobId = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(614104)`)
    let original: typeof scrapeJob.$inferSelect | undefined
    if (scheduling.retryOf) {
      const [job] = await tx
        .select()
        .from(scrapeJob)
        .where(eq(scrapeJob.id, scheduling.retryOf))
        .for('update')
      if (
        !job ||
        job.provider !== provider ||
        getJobTask(job.options) !== task ||
        (artistId !== null && job.options.artistId !== artistId)
      )
        throw new ServerError({ statusCode: 404, message: 'Job not found' })
      original = job
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
      if (original.status === 'running')
        await cancelActiveJobsInTransaction(
          tx,
          [original.id],
          userId,
          'running',
        )
    }
    // The indexed artist ID is also stored on jobs without a group key.
    const activeTarget =
      artistId === null
        ? and(
            sql`${scrapeJob.options}->>'task' = ${task}`,
            typeof prepared.groupKey === 'string'
              ? sql`${scrapeJob.options}->>'groupKey' = ${prepared.groupKey}`
              : undefined,
          )
        : sql`${scrapeJob.options}->>'task' = ${sql.raw(`'${ARTIST_ENRICHMENT_TASK}'`)}
            and ${scrapeJob.options}->>'artistId' = ${artistId}`
    const [active] = await tx
      .select({
        id: scrapeJob.id,
        status: scrapeJob.status,
        options: scrapeJob.options,
      })
      .from(scrapeJob)
      .where(
        and(
          eq(scrapeJob.provider, provider),
          inArray(scrapeJob.status, ['queued', 'running']),
          activeTarget,
        ),
      )
      .limit(1)
    // A job queued before the provider ran in the request runs now instead.
    if (inRequest && active?.status === 'queued' && !scheduling.retryOf)
      return active.id
    // A search that finished before the active read has already updated freshness.
    if (trackSearch)
      await validateQueuedSpotifyTrackSearch(tx, {
        trackId: trackSearch.trackId,
        userId,
        batchId: typeof batchId === 'string' ? batchId : undefined,
        retryOf: original?.id,
        freshness: original
          ? undefined
          : SpotifyTrackSearchFreshnessSchema.optional().parse(input.freshness),
      })
    // If a sibling finished before the active-job read, its profile is visible
    // here. If it is still active, the branch below won't enqueue a second job.
    if (original && artistId !== null) {
      const [newerProfile] = await tx
        .select({ id: artistProviderSnapshot.id })
        .from(artistProviderCurrentState)
        .innerJoin(
          artistProviderSnapshot,
          eq(
            artistProviderSnapshot.id,
            artistProviderCurrentState.latestSnapshotId,
          ),
        )
        .where(
          and(
            eq(artistProviderCurrentState.artistId, artistId),
            eq(artistProviderCurrentState.provider, provider),
            sql`${artistProviderSnapshot.createdAt} > (
            select ${scrapeJob.createdAt} from ${scrapeJob} where ${scrapeJob.id} = ${original.id}
          )`,
          ),
        )
      if (newerProfile)
        throw new ServerError({
          statusCode: 409,
          message: 'A newer artist profile has already been saved.',
        })
    }
    if (active) {
      if (
        task === ARTIST_ENRICHMENT_TASK &&
        ((prepared.verifySnapshotId ?? null) !==
          (active.options.verifySnapshotId ?? null) ||
          (typeof prepared.providerArtistId === 'string' &&
            prepared.providerArtistId !== active.options.providerArtistId))
      )
        throw new ServerError({
          statusCode: 409,
          message:
            'An artist enrichment job for this provider is already queued or running.',
        })
      if (scheduling.skipActive)
        throw new ServerError({
          statusCode: 409,
          message: 'Search is already queued or running.',
        })
      if (scheduling.retryOf && typeof prepared.groupKey === 'string') {
        await tx
          .update(scrapeJob)
          .set({
            options: sql`${scrapeJob.options} || ${JSON.stringify({ retryJobId: active.id })}::jsonb`,
          })
          .where(eq(scrapeJob.id, scheduling.retryOf))
        await logJob(
          scheduling.retryOf,
          'info',
          'The same job is already active.',
          { retryJobId: active.id },
          tx,
        )
      }
      return active.id
    }
    if (artistId !== null && typeof prepared.verifySnapshotId === 'string') {
      const target = await loadArtistProviderTarget(artistId, provider, tx)
      if (target?.snapshotId !== prepared.verifySnapshotId)
        throw new ServerError({
          statusCode: 409,
          message: 'The artist snapshot is no longer current.',
        })
    }
    const id = await insertTaskJob(
      tx,
      provider,
      { task, ...taskOptions, ...(original ? { retryOf: original.id } : {}) },
      userId,
      inRequest
        ? `Running for ${provider} in the request`
        : `Queued for ${provider}`,
      inRequest,
    )
    if (original)
      await linkCreatedJobRetry(
        tx,
        original,
        id,
        userId,
        'Queued again as a new job.',
      )
    created = true
    return id
  })
  if (inRequest && plugin) return runJobInRequest(jobId, plugin, created)
  if (!scheduling.scheduled) await resumeJobProvider(provider)
  else if (created) await wakeJobProvider(provider)
  const job = await getJobRecord(jobId)
  if (!job)
    throw new ServerError({ statusCode: 500, message: 'Failed to create job' })
  return job
}

/**
 * Runs a job of a provider that runs in the request (`runsInRequest`) now,
 * through the request gate, and returns it finished. A new job was inserted
 * running; a job queued earlier is claimed first. A job running elsewhere is
 * returned as it is. Refused with a 429 when a cooldown or busy slot stopped
 * it; the finished job keeps the failure and any responses.
 */
async function runJobInRequest(
  jobId: string,
  plugin: MediaProviderPlugin,
  created: boolean,
): Promise<Job> {
  const job = await db.query.scrapeJob.findFirst({
    where: (table, operators) => operators.eq(table.id, jobId),
    with: { items: true },
  })
  if (!job)
    throw new ServerError({ statusCode: 500, message: 'Failed to create job' })
  const execution: ProviderExecution = {
    failures: 0,
    stopped: false,
    maxSlotWaitMs: IN_REQUEST_SLOT_WAIT_MS,
  }
  if (job.status === 'queued') await processJob(job, plugin, execution)
  else if (created && job.status === 'running')
    await runClaimedJob(job, plugin, execution)
  if (execution.rateLimitedUntil !== undefined)
    throw rateLimitedInRequest(
      plugin.manifest.displayName,
      execution.rateLimitedUntil,
    )
  const finished = await getJobRecord(jobId)
  if (!finished)
    throw new ServerError({ statusCode: 500, message: 'Failed to create job' })
  return finished
}

async function processTaskJob(
  nextJob: NonNullable<Awaited<ReturnType<typeof nextQueuedJob>>>,
  task: string,
  plugin: MediaProviderPlugin | null,
  execution: ProviderExecution,
  control?: QueuedJobExecution,
): Promise<void> {
  const { activity, activeStage } = jobActivityWriter(nextJob.id)
  const finish = async (
    status: 'succeeded' | 'failed' | 'cancelled',
    level: 'info' | 'warn' | 'error',
    message: string,
    metadata: Record<string, JsonValue> = {},
    write?: (tx: JobTransaction) => Promise<void>,
    measurePersistence = false,
  ) => {
    const saved = await withRunningJob(nextJob.id, async (tx, job) => {
      const finishedAt = new Date()
      await tx
        .update(scrapeJob)
        .set({
          status,
          errorMessage: status === 'succeeded' ? null : message,
          finishedAt,
          updatedAt: finishedAt,
        })
        .where(eq(scrapeJob.id, nextJob.id))
      const logId = nanoid()
      await tx.insert(scrapeJobLog).values({
        id: logId,
        jobId: nextJob.id,
        level,
        message,
        metadata: {
          ...metadata,
          ...jobActivityEnding(job.options, finishedAt),
        },
      })
      await write?.(tx)
      if (measurePersistence) {
        // Result handlers can read the succeeded job and its diagnostics in
        // this transaction. Publish the final timing with those same results.
        const savedAt = new Date()
        await tx
          .update(scrapeJob)
          .set({ finishedAt: savedAt, updatedAt: savedAt })
          .where(eq(scrapeJob.id, nextJob.id))
        await tx
          .update(scrapeJobLog)
          .set({
            metadata: {
              ...metadata,
              ...jobActivityEnding(job.options, savedAt),
            },
          })
          .where(eq(scrapeJobLog.id, logId))
      }
    })
    if (saved && status === 'failed')
      writeRequestLog({
        event: 'job.activity',
        outcome: 'failed',
        stage: activeStage() ?? 'Loading job handler',
      })
    return saved
  }

  const definition = taskJobs.get(task)
  if (
    !definition ||
    !plugin ||
    taskProvider(definition, nextJob.options) !== nextJob.provider ||
    (task === ARTIST_ENRICHMENT_TASK && nextJob.items.length !== 0)
  ) {
    await finish('failed', 'error', 'No handler is loaded for this job task.')
    return
  }
  await withRunningJob(nextJob.id, (tx) =>
    logJob(nextJob.id, 'info', `Started job for ${nextJob.provider}`, {}, tx),
  )
  const stoppedMessage =
    'Stopped to protect provider limits. No retry scheduled.'
  const assertActive = async () => {
    const job = await db.query.scrapeJob.findFirst({
      where: (table, operators) => operators.eq(table.id, nextJob.id),
      columns: { status: true },
    })
    if (job?.status !== 'running') throw new Error('Job is no longer running')
    if (execution.stopped) throw new Error(stoppedMessage)
    if (!control) return
    let active: boolean
    try {
      active = await control.canContinue()
    } catch (cause) {
      throw new JobExecutionControlError('Cloud job ownership check failed', {
        cause,
      })
    }
    if (!active) {
      execution.stopped = true
      throw new Error(stoppedMessage)
    }
  }

  let handlerThrew = false
  const result = await definition
    .run(
      {
        jobId: nextJob.id,
        requestedByUserId: nextJob.requestedByUserId,
        ...(execution.maxSlotWaitMs === undefined
          ? {}
          : { maxSlotWaitMs: execution.maxSlotWaitMs }),
        assertActive,
        activity,
        isActive: async () => {
          try {
            await assertActive()
            return true
          } catch (error) {
            if (error instanceof JobExecutionControlError) throw error
            return false
          }
        },
        log: async (level, message) => {
          await withRunningJob(nextJob.id, (tx) =>
            logJob(nextJob.id, level, message, {}, tx),
          )
        },
        progress: async (progress) => {
          const value = JSON.stringify({
            progress: JobProgressSchema.parse(progress),
          })
          await withRunningJob(nextJob.id, async (tx) => {
            await tx
              .update(scrapeJob)
              .set({
                options: sql`${scrapeJob.options} || ${value}::jsonb`,
                updatedAt: new Date(),
              })
              .where(eq(scrapeJob.id, nextJob.id))
          })
        },
      },
      nextJob.options,
    )
    .catch((error: unknown): TaskJobResult => {
      if (error instanceof JobExecutionControlError) throw error
      handlerThrew = true
      return { outcome: 'failed', error }
    })

  if (result.outcome === 'stopped') {
    // A user cancellation has already closed the job; this covers a dispatcher stop.
    await finish('cancelled', 'warn', stoppedMessage)
    return
  }
  const fail = async (
    error: unknown,
    metadata: Record<string, JsonValue> = {},
    classification?: TaskJobResult['failureClassification'],
    localFailure = false,
  ) => {
    noteRateLimit(execution, error)
    const providerSecrets = await db.query.providerSecret.findMany({
      where: (table, operators) =>
        operators.eq(table.provider, plugin.manifest.id),
    })
    const credentials = jobLogSecrets(
      resolveProviderSecrets(
        plugin.manifest.id,
        providerSecrets,
        plugin.manifest.secrets,
      ),
    )
    const details = jobErrorDetails(error, credentials)
    const shouldCountFailure =
      !localFailure &&
      !classification &&
      !(error instanceof ProviderResponseStorageError)
    const evidence = providerResponseEvidence(error, credentials)
    const diagnostics = Array.isArray(metadata.diagnostics)
      ? [...metadata.diagnostics, ...evidence]
      : evidence
    const handled = await finish(
      'failed',
      'error',
      `${details.name}: ${details.message}`.slice(0, 1000),
      {
        ...metadata,
        error: details,
        ...(diagnostics.length ? { diagnostics } : {}),
        ...(classification ? { classification } : {}),
      },
      async (tx) => {
        if (!shouldCountFailure) return
        execution.failures += 1
        const safety = await getProviderSafety(plugin.manifest.id)
        if (
          execution.failures >= MAX_CONSECUTIVE_PROVIDER_FAILURES ||
          safety.halted ||
          safety.cooldownUntil ||
          safety.consecutiveFailures >= MAX_CONSECUTIVE_PROVIDER_FAILURES
        ) {
          execution.stopped = true
          await logJob(
            nextJob.id,
            'warn',
            'Provider dispatch paused after errors or cooldown. No automatic retry scheduled.',
            {},
            tx,
          )
        }
      },
    )
    if (handled && shouldCountFailure)
      await control?.recordOutcome(execution.stopped ? 'stopped' : 'failure')
  }
  if (result.outcome === 'failed') {
    await fail(
      result.error,
      result.metadata,
      result.failureClassification,
      handlerThrew,
    )
    return
  }

  let continued = false
  if (result.persist) await activity('Saving job results')
  const saved = await finish(
    'succeeded',
    'info',
    result.message,
    result.metadata ?? {},
    async (tx) => {
      if (result.options)
        await tx
          .update(scrapeJob)
          .set({
            options: sql`${scrapeJob.options} || ${JSON.stringify(result.options)}::jsonb`,
          })
          .where(eq(scrapeJob.id, nextJob.id))
      await result.persist?.(tx)
      if (result.outcome !== 'continue') return
      const nextJobId = await insertTaskJob(
        tx,
        nextJob.provider,
        { ...result.nextOptions, task, continues: nextJob.id },
        nextJob.requestedByUserId,
        `Continues job ${nextJob.id}`,
      )
      await logJob(
        nextJob.id,
        'info',
        'Queued the next job to continue.',
        { nextJobId },
        tx,
      )
      continued = true
    },
    result.persist !== undefined,
  ).catch(async (error: unknown) => {
    if (!result.persist) throw error
    await fail(
      new Error('Could not save the job result.', { cause: error }),
      {},
      undefined,
      true,
    )
    return false
  })
  if (!saved) return
  if (!result.noProviderRequests) {
    if (!execution.stopped) execution.failures = 0
    await control?.recordOutcome('success')
  }
  if (continued) await wakeJobProvider(nextJob.provider)
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
  const options = { ...parsedInput.options }
  delete options.activity
  if (
    parsedInput.options.task === ARTIST_ENRICHMENT_TASK ||
    parsedInput.options.task === SPOTIFY_ARTIST_ALBUMS_TASK
  )
    throw new ServerError({
      statusCode: 422,
      message: 'Queue the artist task from its artist endpoint.',
    })
  const plugin = await getScrapePlugin(parsedInput.provider)

  if (!plugin?.scrapeMediaItem) {
    throw new ServerError({
      statusCode: 422,
      message: 'Provider cannot be scraped',
      description:
        'This provider is not backed by a loaded scraping plugin in the current environment.',
    })
  }
  if (plugin.manifest.localWorkerRequired && env.RUNTIME_KIND !== 'cloudflare')
    throw new ServerError({
      statusCode: 422,
      message: 'Provider requires a paired local worker on the hosted runtime',
    })

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
  const inRequest = plugin.manifest.runsInRequest === true
  const safety = await getProviderSafety(plugin.manifest.id)
  if (
    safety.halted ||
    (safety.cooldownUntil &&
      (inRequest ||
        !scheduling.deferUntilReady ||
        safety.consecutiveFailures >= MAX_CONSECUTIVE_PROVIDER_FAILURES))
  )
    throw providerSafetyRefusal(plugin, safety)

  const jobId = nanoid()
  const selectedItems = (
    await db.query.mediaItem.findMany({
      where: (table, operators) => operators.inArray(table.id, mediaItemIds),
      with: { providerReferences: true, credits: { with: { artist: true } } },
    })
  ).flatMap((item) => {
    // Library tracks are not scraped; one fails the selection check below.
    const mediaType = scrapeMediaType(item.mediaType)
    return mediaType ? [{ ...item, mediaType }] : []
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
        .select({
          mediaItemId: providerCurrentState.mediaItemId,
          lastScrapedAt: providerCurrentState.lastScrapedAt,
        })
        .from(providerCurrentState)
        .where(
          and(
            eq(providerCurrentState.provider, original.provider),
            inArray(providerCurrentState.mediaItemId, mediaItemIds),
          ),
        )
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
        await cancelActiveJobsInTransaction(
          tx,
          [original.id],
          userId,
          'running',
        )
      await linkCreatedJobRetry(
        tx,
        original,
        jobId,
        userId,
        'Unfinished items queued for retry.',
      )
    }
    const active = await tx
      .select({
        jobId: scrapeJob.id,
        status: scrapeJob.status,
      })
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
    // A job queued before the provider ran in the request runs now instead.
    const [queued] = active
    if (inRequest && !scheduling.retryOf && queued?.status === 'queued')
      return queued.jobId
    if (active.length)
      throw new ServerError({
        statusCode: 409,
        message:
          'This provider already has queued or running work for this selection',
      })
    await tx.insert(scrapeJob).values({
      id: jobId,
      provider: parsedInput.provider,
      // A job run in the request is never queued, so no dispatcher can take it.
      status: inRequest ? 'running' : 'queued',
      startedAt: inRequest ? new Date() : null,
      scope: {
        ...parsedInput.scope,
        mediaItemIds,
      },
      options,
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
    await logJob(
      jobId,
      'info',
      inRequest
        ? `Running ${mediaItemIds.length} item(s) for ${parsedInput.provider} in the request`
        : `Queued ${mediaItemIds.length} item(s) for ${parsedInput.provider}`,
      {},
      tx,
    )
    return jobId
  })

  if (inRequest)
    return runJobInRequest(queuedJobId, plugin, queuedJobId === jobId)

  await wakeJobProvider(parsedInput.provider)

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
        mediaType: scrapeMediaType(item.mediaType),
        limit: 1,
      },
      options: {},
      confirmBroadRun: true,
    },
    userId,
  )
}

export function jobsNeedingAttention() {
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

type JobListQuery = z.infer<typeof JobListQuerySchema>

/** The jobs list filters as one condition on `scrape_job`. */
export function jobListWhere(query: JobListQuery) {
  const pattern = `%${(query.q ?? '').replace(/[\\%_]/g, '\\$&')}%`
  const statuses = query.statuses.length
    ? query.statuses
    : query.status
      ? [query.status]
      : []
  const providers = query.providers.length
    ? query.providers
    : query.provider
      ? [query.provider]
      : []
  return and(
    statuses.length
      ? or(
          ...statuses.map((status) =>
            status === 'active'
              ? inArray(scrapeJob.status, ['queued', 'running'])
              : status === 'attention'
                ? jobsNeedingAttention()
                : eq(scrapeJob.status, status),
          ),
        )
      : undefined,
    providers.length ? inArray(scrapeJob.provider, providers) : undefined,
    query.mediaType ? jobsInMediaScope(query.mediaType) : undefined,
    query.mediaItemId
      ? sql`(exists (
          select 1 from scrape_job_item history_item
          where history_item.job_id = ${scrapeJob.id}
            and history_item.media_item_id = ${query.mediaItemId}
        ) or ${scrapeJob.scope}->'mediaItemIds' @> ${JSON.stringify([query.mediaItemId])}::jsonb)`
      : undefined,
    query.artistId
      ? sql`(${scrapeJob.options}->>'task' = ${ARTIST_ENRICHMENT_TASK}
        and ${scrapeJob.options}->>'artistId' = ${query.artistId})`
      : undefined,
    query.batchId
      ? sql`${scrapeJob.options}->>'batchId' = ${query.batchId}`
      : undefined,
    query.q
      ? sql`(${scrapeJob.provider} ilike ${pattern} or ${scrapeJob.id} ilike ${pattern}
        or ${scrapeJob.options}->>'artistName' ilike ${pattern}
        or ${scrapeJob.options}->>'albumName' ilike ${pattern}
        or ${scrapeJob.options}->>'trackTitle' ilike ${pattern}
        or exists (
      select 1 from scrape_job_item i join media_item m on m.id = i.media_item_id where i.job_id = ${scrapeJob.id} and m.title ilike ${pattern}
    ))`
      : undefined,
  )
}

/** The value a `scrape_job` row sorts by for the list's sort key. */
export async function jobSortField(query: JobListQuery) {
  const table = scrapeJob
  const providerNames =
    query.sortBy === 'provider' && !query.mediaItemId
      ? await listLoadedScrapePlugins()
      : []
  const title = sql`case ${table.options}->>'task'
    when ${ARTIST_ENRICHMENT_TASK} then concat('Artist enrichment · ', ${table.options}->>'artistName')
    when ${SPOTIFY_ARTIST_ALBUMS_TASK} then concat_ws(' · ', 'Spotify artist albums', ${table.options}->>'artistName')
    when ${LASTFM_SCROBBLE_SYNC_TASK} then 'Scrobble sync'
    when ${YOUTUBE_SYNC_TASK} then 'YouTube subscription sync'
    when ${SPOTIFY_PODCAST_SYNC_TASK} then 'Spotify podcast sync'
    when ${MIX_STATION_SYNC_TASKS.rinse} then 'Rinse FM mix sync'
    when ${MIX_STATION_SYNC_TASKS.nts} then 'NTS mix sync'
    when ${MIX_STATION_SYNC_TASKS.lotradio} then 'The Lot Radio mix sync'
    when ${SPOTIFY_PLAYLIST_LISTING_TASK} then 'Spotify playlist list'
    when ${SPOTIFY_PLAYLIST_IMPORT_TASK} then
      case when ${table.options}->>'source' = 'spotify-liked' then 'Spotify Liked Songs import'
      else concat('Spotify playlist import', case when nullif(btrim(${table.options}->>'name'), '') is not null then concat(' · ', ${table.options}->>'name') else '' end) end
    when ${SPOTIFY_PLAYLIST_ADD_TRACK_TASK} then concat('Add track to Spotify playlist',
      case when nullif(btrim(${table.options}->>'trackTitle'), '') is not null and nullif(btrim(${table.options}->>'playlistName'), '') is not null
        then concat(' · ', ${table.options}->>'trackTitle', ' to ', ${table.options}->>'playlistName') else '' end)
    when ${SPOTIFY_PLAYLIST_ADD_ALBUM_TASK} then concat('Add album to Spotify playlist',
      case when nullif(btrim(${table.options}->>'albumTitle'), '') is not null and nullif(btrim(${table.options}->>'playlistName'), '') is not null
        then concat(' · ', ${table.options}->>'albumTitle', ' to ', ${table.options}->>'playlistName') else '' end)
    when ${LASTFM_SPOTIFY_SEARCH_TASK} then concat('Spotify album search',
      case when nullif(btrim(concat_ws('', ${table.options}->>'artistName', ${table.options}->>'albumName')), '') is not null
        then concat(' · ', concat_ws(' — ', nullif(btrim(${table.options}->>'artistName'), ''), nullif(btrim(${table.options}->>'albumName'), ''))) else '' end)
    when ${SPOTIFY_TRACK_SEARCH_TASK} then concat_ws(' · ', 'Spotify track search', nullif(btrim(${table.options}->>'trackTitle'), ''))
    when ${SPOTIFY_TRACK_ALBUM_LOOKUP_TASK} then 'Spotify track release lookup'
    when ${TIDAL_TRACK_MATCH_TASK} then concat_ws(' · ', 'TIDAL track match', nullif(btrim(${table.options}->>'trackTitle'), ''))
    when ${SONOVAULT_TRACK_LOOKUP_TASK} then concat_ws(' · ',
      case when ${table.options}->>'refresh' = 'true' then 'Sonovault track refresh' else 'Sonovault track lookup' end,
      jsonb_array_length(${table.options}->'trackIds'), nullif(btrim(${table.options}->>'trackTitle'), ''))
    when ${SONOVAULT_ALBUM_LOOKUP_TASK} then concat_ws(' · ', 'Sonovault album lookup', nullif(btrim(${table.options}->>'albumTitle'), ''))
    when ${TIDAL_SIMILAR_TASK} then concat_ws(' · ', concat('TIDAL similar ', coalesce(${table.options}->>'kind', 'track'), 's'), nullif(btrim(${table.options}->>'itemTitle'), ''))
    when ${SPOTIFY_SIMILAR_LOOKUP_TASK} then 'Spotify search · similar'
    when ${SONOVAULT_SIMILAR_LOOKUP_TASK} then 'Sonovault lookup · similar'
    else (select m.title from scrape_job_item i join media_item m on m.id = i.media_item_id
      where i.job_id = ${table.id} order by i.created_at, i.id limit 1) end`
  const result = query.mediaItemId
    ? sql`coalesce((select i.message from scrape_job_item i where i.job_id = ${table.id} and i.media_item_id = ${query.mediaItemId} order by i.created_at, i.id limit 1), ${table.errorMessage})`
    : sql`coalesce(${table.errorMessage}, (select string_agg(nullif(i.message, ''), ' · ' order by i.created_at, i.id) from scrape_job_item i where i.job_id = ${table.id}))`
  const fields = {
    provider: sql`lower(case ${table.provider}
      when 'google-custom-search' then 'Google Custom Search (legacy)'
      ${sql.join(
        providerNames.map(
          (plugin) =>
            sql`when ${plugin.manifest.id} then ${plugin.manifest.displayName}`,
        ),
        sql` `,
      )}
      else ${table.provider} end)`,
    title: sql`lower(${title})`,
    status: sql`${table.status}::text`,
    createdAt: table.createdAt,
    startedAt: table.startedAt,
    finishedAt: table.finishedAt,
    result: sql`lower(${result})`,
  }
  return fields[query.sortBy]
}

/** Loads jobs with their items and logs in the order of `ids`. */
export async function loadListedJobs(ids: string[]): Promise<Job[]> {
  if (!ids.length) return []
  const jobs = await db.query.scrapeJob.findMany({
    where: inArray(scrapeJob.id, ids),
    with: {
      items: {
        columns: { payload: false },
        with: { mediaItem: { columns: { title: true, mediaType: true } } },
        orderBy: (table, operators) => [
          operators.asc(table.createdAt),
          operators.asc(table.id),
        ],
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
  const order = new Map(ids.map((id, index) => [id, index]))
  const mapped = await Promise.all(
    jobs.map(async (jobRecord) =>
      mapJob(jobRecord, await getScrapePlugin(jobRecord.provider)),
    ),
  )
  return withJobSubjects(
    mapped.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)),
  )
}

export async function listJobs(
  input: z.input<typeof JobListQuerySchema> = {},
): Promise<JobPage> {
  const query = JobListQuerySchema.parse(input)
  const where = jobListWhere(query)
  const [count] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(scrapeJob)
    .where(where)
  const sortField = await jobSortField(query)
  const order = query.direction === 'asc' ? asc : desc
  const page = await db
    .select({ id: scrapeJob.id })
    .from(scrapeJob)
    .where(where)
    .orderBy(sql`${order(sortField)} nulls last`, order(scrapeJob.id))
    .limit(query.size)
    .offset((query.page - 1) * query.size)

  return {
    items: await withJobWaiting(
      await loadListedJobs(page.map((row) => row.id)),
    ),
    totalCount: count?.count ?? 0,
    page: query.page,
    size: query.size,
    pageCount: Math.ceil((count?.count ?? 0) / query.size),
  }
}

export async function getJob(jobId: string): Promise<Job | null> {
  const job = await getJobRecord(jobId)
  if (!job) return null
  const [named = job] = await withJobSubjects([job])
  return describeJob(named)
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

const jobActivityCache = createDatabaseReadCache<
  z.infer<typeof JobActivitySchema>
>({
  maxEntries: 1,
  maxValueBytes: 4096,
})

export async function getJobActivity() {
  return jobActivityCache('job-activity', readJobActivity)
}

async function readJobActivity() {
  const albums = jobsInMediaScope('album')
  const films = jobsInMediaScope('film')
  const tracks = jobsInMediaScope('track')
  const artists = jobsInMediaScope('artist')
  const subscriptions = jobsInMediaScope('subscription')
  const mixes = jobsInMediaScope('mix')
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
      trackQueued: sql<number>`count(*) filter (where status = 'queued' and ${tracks})::int`,
      trackRunning: sql<number>`count(*) filter (where status = 'running' and ${tracks})::int`,
      trackFailed: sql<number>`count(*) filter (where ${jobsNeedingAttention()} and ${tracks})::int`,
      artistQueued: sql<number>`count(*) filter (where status = 'queued' and ${artists})::int`,
      artistRunning: sql<number>`count(*) filter (where status = 'running' and ${artists})::int`,
      artistFailed: sql<number>`count(*) filter (where ${jobsNeedingAttention()} and ${artists})::int`,
      subscriptionQueued: sql<number>`count(*) filter (where status = 'queued' and ${subscriptions})::int`,
      subscriptionRunning: sql<number>`count(*) filter (where status = 'running' and ${subscriptions})::int`,
      subscriptionFailed: sql<number>`count(*) filter (where ${jobsNeedingAttention()} and ${subscriptions})::int`,
      mixQueued: sql<number>`count(*) filter (where status = 'queued' and ${mixes})::int`,
      mixRunning: sql<number>`count(*) filter (where status = 'running' and ${mixes})::int`,
      mixFailed: sql<number>`count(*) filter (where ${jobsNeedingAttention()} and ${mixes})::int`,
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
      {
        mediaType: 'artist',
        queued: counts?.artistQueued ?? 0,
        running: counts?.artistRunning ?? 0,
        failed: counts?.artistFailed ?? 0,
        imports: 0,
      },
      {
        mediaType: 'track',
        queued: counts?.trackQueued ?? 0,
        running: counts?.trackRunning ?? 0,
        failed: counts?.trackFailed ?? 0,
        imports: 0,
      },
      {
        mediaType: 'subscription',
        queued: counts?.subscriptionQueued ?? 0,
        running: counts?.subscriptionRunning ?? 0,
        failed: counts?.subscriptionFailed ?? 0,
        imports: 0,
      },
      {
        mediaType: 'mix',
        queued: counts?.mixQueued ?? 0,
        running: counts?.mixRunning ?? 0,
        failed: counts?.mixFailed ?? 0,
        imports: 0,
      },
    ],
  })
}

/**
 * Artist tasks, subscription syncs and mix syncs have their own
 * libraries. Legacy jobs were stored with the album scope, so the task decides.
 */
function jobsInMediaScope(
  mediaType: NonNullable<z.infer<typeof JobListQuerySchema>['mediaType']>,
) {
  const subscriptionSync = sql`coalesce(${scrapeJob.options}->>'task', '') in (${sql.join(
    SUBSCRIPTION_SYNC_TASKS.map((task) => sql`${task}`),
    sql`, `,
  )})`
  if (mediaType === 'subscription') return subscriptionSync
  const mixSync = sql`coalesce(${scrapeJob.options}->>'task', '') in (${sql.join(
    MIX_SYNC_TASKS.map((task) => sql`${task}`),
    sql`, `,
  )})`
  if (mediaType === 'mix') return mixSync
  const artistTasks = sql`coalesce(${scrapeJob.options}->>'task', '') in (${ARTIST_ENRICHMENT_TASK}, ${SPOTIFY_ARTIST_ALBUMS_TASK})`
  if (mediaType === 'artist') return artistTasks
  if (mediaType === 'track')
    return sql`(${scrapeJob.options}->>'task' in (${SPOTIFY_TRACK_SEARCH_TASK}, ${SPOTIFY_TRACK_ALBUM_LOOKUP_TASK}, ${TIDAL_TRACK_MATCH_TASK}, ${SONOVAULT_TRACK_LOOKUP_TASK})
      or (${scrapeJob.options}->>'task' in (${TIDAL_SIMILAR_TASK}, ${SPOTIFY_SIMILAR_LOOKUP_TASK})
        and ${scrapeJob.scope}->>'mediaType' = 'track'))`
  return sql`((${scrapeJob.scope}->>'mediaType' = ${mediaType} or exists (
    select 1 from scrape_job_item scoped_item join media_item scoped_media on scoped_media.id = scoped_item.media_item_id
    where scoped_item.job_id = ${scrapeJob.id} and scoped_media.media_type = ${mediaType}
  )) and not ${subscriptionSync} and not ${mixSync} and not ${artistTasks})`
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

/** Cancels locked jobs that share one status, keeping their finished items. */
async function cancelActiveJobsInTransaction(
  tx: JobTransaction,
  jobIds: string[],
  userId: string | null,
  status: 'queued' | 'running',
): Promise<void> {
  if (!jobIds.length) return
  const reason =
    status === 'queued'
      ? 'Cancelled by user before execution. No requests scheduled.'
      : 'Cancelled by user. In-flight results will be discarded.'
  const now = new Date()
  const cancelled = await tx
    .update(scrapeJob)
    .set({
      status: 'cancelled',
      errorMessage: reason,
      finishedAt: now,
      updatedAt: now,
      options: sql`${scrapeJob.options} || ${JSON.stringify({ cancellation: { requestedByUser: true, userId, cancelledAt: now.toISOString() } })}::jsonb`,
    })
    .where(inArray(scrapeJob.id, jobIds))
    .returning({ id: scrapeJob.id, options: scrapeJob.options })
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
        inArray(scrapeJobItem.jobId, jobIds),
        inArray(scrapeJobItem.status, ['queued', 'running']),
      ),
    )
  await tx.insert(scrapeJobLog).values(
    cancelled.map((job) => ({
      id: nanoid(),
      jobId: job.id,
      level: 'warn',
      message: reason,
      metadata: { userId, ...jobActivityEnding(job.options, now) },
    })),
  )
}

function cancellationSummary(
  results: BulkCancelJobsResult['results'],
): BulkCancelJobsResult {
  return {
    cancelled: results.filter((result) => result.status === 'cancelled').length,
    skipped: results.filter((result) => result.status === 'skipped').length,
    results,
  }
}

const BATCH_CANCEL_CHUNK = 500

/**
 * Cancels a batch's unfinished jobs. Queued jobs are cancelled together;
 * running jobs follow the bulk path and need `confirmRunning`. Finished jobs
 * and their results are kept.
 */
export async function cancelJobBatch(
  batchId: string,
  input: CancelJobBatchInput,
  userId: string | null,
): Promise<BulkCancelJobsResult> {
  const { confirmRunning } = CancelJobBatchSchema.parse(input)
  const inBatch = sql`${scrapeJob.options}->>'batchId' = ${batchId}`
  const results: BulkCancelJobsResult['results'] = []
  for (;;) {
    const ids = await db.transaction(async (tx) => {
      const rows = await tx
        .select({ id: scrapeJob.id })
        .from(scrapeJob)
        .where(and(inBatch, eq(scrapeJob.status, 'queued')))
        .orderBy(asc(scrapeJob.id))
        .limit(BATCH_CANCEL_CHUNK)
        .for('update')
      const jobIds = rows.map((row) => row.id)
      await cancelActiveJobsInTransaction(tx, jobIds, userId, 'queued')
      return jobIds
    })
    results.push(
      ...ids.map((jobId): BulkCancelJobsResult['results'][number] => ({
        jobId,
        status: 'cancelled',
      })),
    )
    if (ids.length < BATCH_CANCEL_CHUNK) break
  }
  const running = await db
    .select({ id: scrapeJob.id })
    .from(scrapeJob)
    .where(and(inBatch, eq(scrapeJob.status, 'running')))
    .orderBy(asc(scrapeJob.id))
  results.push(
    ...(await cancelEachJob(
      running.map((row) => row.id),
      confirmRunning,
      userId,
    )),
  )
  return cancellationSummary(results)
}

async function cancelEachJob(
  jobIds: string[],
  confirmRunning: boolean,
  userId: string | null,
): Promise<BulkCancelJobsResult['results']> {
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
        await cancelActiveJobsInTransaction(tx, [jobId], userId, job.status)
      })
      results.push({ jobId, status: 'cancelled' })
    } catch (error) {
      results.push(bulkJobFailure(jobId, error))
    }
  }
  return results
}

export async function bulkCancelJobs(
  input: BulkCancelJobsInput,
  userId: string | null,
): Promise<BulkCancelJobsResult> {
  const { jobIds, confirmRunning } = BulkCancelJobsSchema.parse(input)
  return cancellationSummary(
    await cancelEachJob(jobIds, confirmRunning, userId),
  )
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
  const task = getJobTask(original.options)
  if (task !== null)
    return createTaskJob(task, userId, {
      retryOf: original.id,
      skipExistingRetry,
      confirmRunning,
      taskOptions: original.options,
    })
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
    .select({
      mediaItemId: providerCurrentState.mediaItemId,
      lastScrapedAt: providerCurrentState.lastScrapedAt,
    })
    .from(providerCurrentState)
    .where(
      and(
        eq(providerCurrentState.provider, original.provider),
        inArray(
          providerCurrentState.mediaItemId,
          original.items.flatMap((item) =>
            item.mediaItemId ? [item.mediaItemId] : [],
          ),
        ),
      ),
    )
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
  const { mediaType, ...scope } = original.scope
  if (mediaType === 'track')
    throw new ServerError({
      statusCode: 409,
      message: 'Track searches must be retried as tasks.',
    })
  return createJob(
    {
      provider: original.provider,
      scope: { ...scope, mediaType, mediaItemIds },
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
        ? getJobTask(job.options) !== null
          ? 1
          : job.items.filter(
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
