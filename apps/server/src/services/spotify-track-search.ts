import { and, desc, eq, inArray, or, sql } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import { EnrichmentResultSchema, JobScopeSchema } from '@repo/schemas/job'
import {
  SPOTIFY_TRACK_SEARCH_LIMIT,
  SPOTIFY_TRACK_SEARCH_TASK,
  SpotifyTrackSearchCandidateSchema,
  SpotifyTrackSearchInputSchema,
  SpotifyTrackSearchJobSchema,
  SpotifyTrackSearchMarketSchema,
  SpotifyTrackSearchParamsSchema,
  SpotifyTrackSearchQuerySchema,
  SpotifyTrackSearchSchema,
  SpotifyTrackSearchStatusInputSchema,
  SpotifyTrackSearchStatusSchema,
  type SpotifyTrackSearchFreshness,
  type SpotifyTrackSearchInput,
} from '@repo/schemas/spotify-track-search'
import { parseTrackNumberPrefix } from '@/lib/album-track-aliases'
import { albumNameKey } from '@/lib/album-import-candidates'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import { createStableId } from '@/lib/media-utils'
import {
  lastfmTrackSource,
  libraryTrack,
  mediaItem,
  scrapeJob,
  scrapeJobLog,
} from '@/schemas/db'
import { lockLibraryTrackWrites } from './album-library-tracks'
import { createTaskJob, type TaskJobContext, type TaskJobResult } from './jobs'
import {
  prepareSpotifyCatalogTrackSearch,
  searchSpotifyTrackCandidates,
} from './manual-add'
import { closeChangeBatch, openChangeBatch } from './library-changes'
import { reconcileSpotifyTrackSearchInTransaction } from './spotify-track-search-acceptance'
import {
  sameSpotifySearchArtists,
  spotifySearchArtistNames,
} from './spotify-track-search-evidence'
import {
  listTracksNeedingSpotifyMatch,
  spotifySearchRecordingId,
  trackMatchesSpotifySearchFreshness,
} from './track-match-diagnostics'

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
type SearchReader = Pick<typeof db, 'select' | 'selectDistinctOn'>

const SearchOptionsSchema = SpotifyTrackSearchParamsSchema.extend({
  trackTitle: z.string().min(1).max(500),
  trackArtists: z.array(z.string()).optional(),
  groupKey: z.string().min(1),
  market: SpotifyTrackSearchMarketSchema.optional(),
  query: SpotifyTrackSearchQuerySchema,
  reviewOnly: z.literal(true).optional(),
})
const StoredResultSchema = z.object({
  diagnostics: z.array(
    z.object({
      kind: z.literal(SPOTIFY_TRACK_SEARCH_TASK),
      query: SearchOptionsSchema.shape.query,
      candidates: z
        .array(SpotifyTrackSearchCandidateSchema)
        .max(SPOTIFY_TRACK_SEARCH_LIMIT),
    }),
  ),
})

const searchTrackId = sql<string>`${scrapeJob.options}->>'trackId'`
const retainedTrackId = spotifySearchRecordingId(sql`${scrapeJob.options}`)
const isTrackSearch = sql`${scrapeJob.options}->>'task' = ${sql.raw(`'${SPOTIFY_TRACK_SEARCH_TASK}'`)}`
const searchJobColumns = {
  id: scrapeJob.id,
  status: scrapeJob.status,
  errorMessage: scrapeJob.errorMessage,
  createdAt: scrapeJob.createdAt,
  startedAt: scrapeJob.startedAt,
  finishedAt: scrapeJob.finishedAt,
  scope: scrapeJob.scope,
  options: scrapeJob.options,
  requestedByUserId: scrapeJob.requestedByUserId,
}
type SearchJob = Pick<
  typeof scrapeJob.$inferSelect,
  keyof typeof searchJobColumns
>

function searchOption(value: string, maxLength: number) {
  return value
    .replace(/["\\:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
    .trimEnd()
}

async function trackSearchTarget(
  database: Pick<typeof db, 'select'>,
  trackId: string,
) {
  const [track] = await database
    .select({
      title: mediaItem.title,
      sourceLabel: mediaItem.sourceLabel,
      artists: spotifySearchArtistNames(sql`${mediaItem.id}`),
    })
    .from(mediaItem)
    .innerJoin(libraryTrack, eq(libraryTrack.mediaItemId, mediaItem.id))
    .where(
      and(
        eq(mediaItem.id, trackId),
        eq(mediaItem.mediaType, 'track'),
        sql`${mediaItem.metadata}->>'legacyHidden' is distinct from 'true'`,
      ),
    )
  if (!track) return undefined
  const numbered =
    track.sourceLabel === 'lastfm'
      ? parseTrackNumberPrefix(track.title.trim())
      : undefined
  const title = searchOption(numbered?.title ?? track.title, 110)
  const artistName = searchOption(track.artists[0] ?? '', 70)
  return {
    trackTitle: track.title.trim(),
    trackArtists: track.artists,
    query: title
      ? `track:"${title}"${artistName ? ` artist:"${artistName}"` : ''}`
      : '',
  }
}

async function needsMatch(
  database: Pick<typeof db, 'execute'>,
  trackId: string,
) {
  return (await listTracksNeedingSpotifyMatch(database, [trackId])).length > 0
}

export async function prepareSpotifyTrackSearch(
  userId: string | null,
  input: Record<string, unknown>,
) {
  const { trackId } = SpotifyTrackSearchParamsSchema.parse(input)
  const target = await trackSearchTarget(db, trackId)
  if (!target)
    throw new ServerError({
      statusCode: 404,
      message: 'Library track not found.',
    })
  const groupKey = createStableId(
    SPOTIFY_TRACK_SEARCH_TASK,
    JSON.stringify([userId, trackId]),
  )
  const reviewQuery =
    input.reviewOnly === true
      ? SpotifyTrackSearchQuerySchema.parse(input.query)
      : undefined
  if (
    (input.groupKey !== undefined && input.groupKey !== groupKey) ||
    !(reviewQuery ?? target.query)
  )
    throw new ServerError({
      statusCode: 409,
      message: 'The track is unavailable for this search.',
    })
  const market = SearchOptionsSchema.shape.market.parse(input.market)
  await prepareSpotifyCatalogTrackSearch(userId, market)
  return SearchOptionsSchema.parse({
    trackId,
    groupKey,
    ...target,
    ...(reviewQuery ? { query: reviewQuery, reviewOnly: true } : {}),
    trackTitle: target.trackTitle.slice(0, 500),
    ...(market ? { market } : {}),
  })
}

/** Serialize the final eligibility and replay checks with track identity writes. */
export async function validateQueuedSpotifyTrackSearch(
  tx: Transaction,
  input: {
    trackId: string
    userId: string | null
    batchId?: string
    retryOf?: string
    freshness?: SpotifyTrackSearchFreshness
  },
) {
  await lockLibraryTrackWrites(tx)
  if (!(await needsMatch(tx, input.trackId)))
    throw new ServerError({
      statusCode: 409,
      message: 'The track is missing or already has a Spotify match.',
    })
  if (
    input.freshness?.length &&
    !(await trackMatchesSpotifySearchFreshness(
      tx,
      input.trackId,
      input.userId,
      input.freshness,
    ))
  )
    throw new ServerError({
      statusCode: 409,
      message:
        'The track no longer meets the selected Spotify search freshness.',
    })
  if (input.retryOf) {
    const jobs = await latestTrackSearchJobs(tx, [input.trackId], input.userId)
    const newest = jobs[0]
    if (!newest || newest.id !== input.retryOf)
      throw new ServerError({
        statusCode: 409,
        message: 'A newer Spotify search already exists.',
      })
  } else if (input.batchId) {
    const [sameBatch] = await tx
      .select({ id: scrapeJob.id })
      .from(scrapeJob)
      .where(
        and(
          isTrackSearch,
          eq(searchTrackId, input.trackId),
          requesterIs(input.userId),
          sql`${scrapeJob.options}->>'batchId' = ${input.batchId}`,
        ),
      )
      .limit(1)
    if (sameBatch)
      throw new ServerError({
        statusCode: 409,
        message: 'This track already has a search in the batch.',
      })
  }
}

export async function runSpotifyTrackSearch(
  context: TaskJobContext,
  input: Record<string, unknown>,
): Promise<TaskJobResult> {
  try {
    const options = SearchOptionsSchema.parse(input)
    await context.assertActive()
    const eligible = await db.transaction(async (tx) => {
      await lockLibraryTrackWrites(tx)
      return needsMatch(tx, options.trackId)
    })
    if (!eligible)
      return {
        outcome: 'complete',
        message:
          'Search skipped: the track is missing or already has a Spotify match.',
      }
    const candidates = await searchSpotifyTrackCandidates(
      options.query,
      context.requestedByUserId,
      context.assertActive,
      options.market,
      context.jobId,
    )
    if (!(await context.isActive())) return { outcome: 'stopped' }
    return {
      outcome: 'complete',
      message: `Spotify search returned ${candidates.length} tracks.`,
      options: { resultCount: candidates.length },
      metadata: {
        diagnostics: [
          { kind: SPOTIFY_TRACK_SEARCH_TASK, query: options.query, candidates },
        ],
      },
      persist: async (tx) => {
        if (options.reviewOnly || !context.requestedByUserId) return
        const batchId = await openChangeBatch(tx, 'spotify-search')
        await reconcileSpotifyTrackSearchInTransaction(
          tx,
          {
            trackId: options.trackId,
            userId: context.requestedByUserId,
            jobId: context.jobId,
          },
          false,
          batchId,
        )
        await closeChangeBatch(tx, batchId)
      },
    }
  } catch (error) {
    if (!(await context.isActive())) return { outcome: 'stopped' }
    return { outcome: 'failed', error }
  }
}

export async function queueSpotifyTrackSearches(
  input: SpotifyTrackSearchInput,
  userId: string | null,
) {
  const {
    trackIds,
    batchId = nanoid(),
    freshness,
    market,
    query,
  } = SpotifyTrackSearchInputSchema.parse(input)
  const eligible = await listTracksNeedingSpotifyMatch(db, [
    ...new Set(trackIds),
  ])
  let queued = 0
  for (const trackId of eligible) {
    try {
      await createTaskJob(SPOTIFY_TRACK_SEARCH_TASK, userId, {
        taskOptions: {
          trackId,
          batchId,
          ...(query ? { query, reviewOnly: true } : {}),
          ...(freshness?.length ? { freshness } : {}),
          ...(market ? { market } : {}),
        },
        skipActive: true,
      })
      queued += 1
    } catch (error) {
      if (
        !(
          error instanceof ServerError &&
          [404, 409].includes(error.response.statusCode)
        )
      )
        throw error
    }
  }
  const skipped = trackIds.length - queued
  return EnrichmentResultSchema.parse({
    batchId,
    queued,
    skipped,
    warnings: skipped
      ? [
          freshness?.length
            ? 'Tracks outside the selected freshness filters, missing tracks, covered tracks and duplicate requests were skipped.'
            : 'Missing, covered, duplicate or already queued tracks were skipped.',
        ]
      : [],
  })
}

function requesterIs(userId: string | null) {
  return sql`${scrapeJob.requestedByUserId} is not distinct from ${userId}`
}

function latestTrackSearchJobs(
  database: SearchReader,
  trackIds: string[],
  userId: string | null | undefined,
  scope: 'requested' | 'retained' = 'requested',
) {
  const visibleId = scope === 'retained' ? retainedTrackId : searchTrackId
  const pastId =
    scope === 'retained'
      ? spotifySearchRecordingId(sql`previous.options`)
      : sql`previous.options->>'trackId'`
  const history = sql`from scrape_job previous
    where previous.options->>'task' = ${sql.raw(`'${SPOTIFY_TRACK_SEARCH_TASK}'`)}
      and previous.provider = 'spotify' and ${pastId} = ${visibleId}
      ${userId === undefined ? sql`` : sql`and previous.requested_by_user_id is not distinct from ${userId}`}`
  return database
    .selectDistinctOn([visibleId], {
      trackId: visibleId,
      ...searchJobColumns,
      lastAttemptAt:
        sql<Date | null>`(select max(previous.started_at) ${history}
      and (previous.status <> 'succeeded' or previous.options ? 'resultCount'))`.mapWith(
          scrapeJob.startedAt,
        ),
      lastSuccessfulAt:
        sql<Date | null>`(select max(previous.finished_at) ${history}
      and previous.status = 'succeeded' and previous.options ? 'resultCount')`.mapWith(
          scrapeJob.finishedAt,
        ),
    })
    .from(scrapeJob)
    .where(
      and(
        eq(scrapeJob.provider, 'spotify'),
        isTrackSearch,
        userId === undefined ? undefined : requesterIs(userId),
        inArray(visibleId, trackIds),
      ),
    )
    .orderBy(
      visibleId,
      sql`${scrapeJob.createdAt} desc nulls last`,
      sql`${scrapeJob.id} desc nulls last`,
    )
}

function summarizeSearch(job: SearchJob) {
  return SpotifyTrackSearchJobSchema.parse({
    jobId: job.id,
    status: job.status,
    acceptedTrackId: job.options.acceptedTrackId,
    matchMethod: job.options.matchMethod,
    resultCount: job.options.resultCount ?? null,
    errorMessage: job.errorMessage,
    createdAt: job.createdAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
  })
}

export async function listSpotifyTrackSearchStatuses(
  input: z.input<typeof SpotifyTrackSearchStatusInputSchema>,
  userId: string,
) {
  const { trackIds } = SpotifyTrackSearchStatusInputSchema.parse(input)
  const ids = [...new Set(trackIds)]
  const jobs = new Map(
    (await latestTrackSearchJobs(db, ids, userId, 'retained')).map((job) => [
      job.trackId,
      job,
    ]),
  )
  return SpotifyTrackSearchStatusSchema.parse({
    items: ids.map((trackId) => {
      const job = jobs.get(trackId)
      return {
        trackId,
        job: job ? summarizeSearch(job) : null,
        lastAttemptAt: job?.lastAttemptAt?.toISOString() ?? null,
        lastSuccessfulAt: job?.lastSuccessfulAt?.toISOString() ?? null,
      }
    }),
  })
}

function parseStoredSearch(metadata: unknown) {
  const parsed = StoredResultSchema.safeParse(metadata)
  return parsed.success ? (parsed.data.diagnostics[0] ?? null) : null
}

async function storedSearch(
  database: Pick<SearchReader, 'select'>,
  jobId: string,
) {
  const logs = await database
    .select({ metadata: scrapeJobLog.metadata })
    .from(scrapeJobLog)
    .where(
      and(
        eq(scrapeJobLog.jobId, jobId),
        sql`${scrapeJobLog.metadata} ? 'diagnostics'`,
      ),
    )
    .orderBy(desc(scrapeJobLog.createdAt), desc(scrapeJobLog.id))
  for (const log of logs) {
    const result = parseStoredSearch(log.metadata)
    if (result) return result
  }
  return null
}

function trackSearchHistoryScope(trackId: string, userId?: string) {
  return and(
    eq(scrapeJob.provider, 'spotify'),
    isTrackSearch,
    userId === undefined ? undefined : requesterIs(userId),
    or(eq(searchTrackId, trackId), eq(retainedTrackId, trackId)),
  )
}

function savedSearchScopeMatches(job: SearchJob) {
  const scope = JobScopeSchema.safeParse(job.scope)
  return (
    scope.success &&
    scope.data.mediaType === 'track' &&
    scope.data.mediaItemIds.length === 1 &&
    scope.data.mediaItemIds[0] === job.options.trackId
  )
}

async function savedSearchesWithCandidates(
  database: Pick<SearchReader, 'select'>,
  trackId: string,
  userId: string,
) {
  const rows = await database
    .select({ job: searchJobColumns, metadata: scrapeJobLog.metadata })
    .from(scrapeJob)
    .innerJoin(scrapeJobLog, eq(scrapeJobLog.jobId, scrapeJob.id))
    .where(
      and(
        trackSearchHistoryScope(trackId, userId),
        eq(scrapeJob.status, 'succeeded'),
        sql`jsonb_path_exists(${scrapeJobLog.metadata}, '$.diagnostics[*].candidates[0]')`,
      ),
    )
    .orderBy(
      desc(scrapeJob.createdAt),
      desc(scrapeJob.id),
      desc(scrapeJobLog.createdAt),
      desc(scrapeJobLog.id),
    )
  const jobs = new Set<string>()
  const spotifyIds = new Set<string>()
  return rows.flatMap(({ job, metadata }) => {
    if (jobs.has(job.id)) return []
    const result = parseStoredSearch(metadata)
    if (
      !result?.candidates.length ||
      (job.options.query !== undefined && result.query !== job.options.query) ||
      (job.options.resultCount !== undefined &&
        result.candidates.length !== job.options.resultCount) ||
      !savedSearchScopeMatches(job)
    )
      return []

    jobs.add(job.id)
    const candidates = result.candidates.filter(({ spotifyTrackId }) => {
      if (spotifyIds.has(spotifyTrackId)) return false
      spotifyIds.add(spotifyTrackId)
      return true
    })
    return candidates.length
      ? [
          {
            job,
            query: result.query,
            resultCount: result.candidates.length,
            peers: result.candidates,
            candidates,
          },
        ]
      : []
  })
}

export async function readSpotifySearchHistory(
  database: Pick<SearchReader, 'select'>,
  trackId: string,
  userId: string,
) {
  const [[job], searches] = await Promise.all([
    database
      .select(searchJobColumns)
      .from(scrapeJob)
      .where(trackSearchHistoryScope(trackId, userId))
      .orderBy(desc(scrapeJob.createdAt), desc(scrapeJob.id))
      .limit(1),
    savedSearchesWithCandidates(database, trackId, userId),
  ])
  return { job, searches }
}

export async function getSpotifyTrackSearch(trackId: string, userId: string) {
  const { job, searches } = await readSpotifySearchHistory(db, trackId, userId)
  const [saved, ...earlier] = searches.map((search) => ({
    job: { ...summarizeSearch(search.job), resultCount: search.resultCount },
    query: search.query,
    candidates: search.candidates,
  }))
  let query = saved?.query ?? job?.options.query
  if (query === undefined || query === null) {
    const target = await trackSearchTarget(db, trackId)
    if (!target)
      throw new ServerError({
        statusCode: 404,
        message: 'Library track not found.',
      })
    query = target.query
  }
  return SpotifyTrackSearchSchema.parse({
    job: job ? summarizeSearch(job) : null,
    resultJob: saved?.job ?? null,
    query,
    candidates: saved?.candidates ?? [],
    earlierResults: earlier,
  })
}

async function savedSearchTargetMatches(
  database: Pick<SearchReader, 'select'>,
  trackId: string,
  options: SearchJob['options'],
) {
  const saved = SearchOptionsSchema.safeParse(options)
  if (!saved.success) return false
  const target = await trackSearchTarget(database, trackId)
  return (
    target !== undefined &&
    albumNameKey(target.trackTitle) === albumNameKey(saved.data.trackTitle) &&
    (saved.data.trackArtists
      ? sameSpotifySearchArtists(target.trackArtists, saved.data.trackArtists)
      : albumNameKey(target.query) === albumNameKey(saved.data.query))
  )
}

/** Re-check the latest saved result and the current subject within the library write lock. */
export async function readSpotifyTrackSearchForAutomaticMatch(
  database: Transaction,
  {
    trackId,
    jobId,
    userId,
  }: { trackId: string; jobId: string; userId: string | null },
) {
  const [job] = await latestTrackSearchJobs(database, [trackId], undefined)
  if (
    !job ||
    job.id !== jobId ||
    job.status !== 'succeeded' ||
    job.requestedByUserId !== userId ||
    !userId ||
    job.options.reviewOnly === true ||
    job.options.acceptedTrackId !== undefined ||
    job.options.acceptedSpotifyTrackId !== undefined
  )
    return null
  if (
    !savedSearchScopeMatches(job) ||
    !(await savedSearchTargetMatches(database, trackId, job.options))
  )
    return null
  const result = await storedSearch(database, jobId)
  if (
    !result ||
    result.query !== job.options.query ||
    result.candidates.length !== job.options.resultCount
  )
    return null
  return result.candidates
}

/** The caller holds the library track write lock throughout acceptance. */
export async function readSpotifyTrackSearchCandidate(
  database: Transaction,
  {
    trackId,
    jobId,
    spotifyTrackId,
    userId,
  }: { trackId: string; jobId: string; spotifyTrackId: string; userId: string },
) {
  const searches = await savedSearchesWithCandidates(database, trackId, userId)
  const saved = searches.find((search) => search.job.id === jobId)
  if (!saved)
    throw new ServerError({
      statusCode: 409,
      message: 'The Spotify search has changed. Review the latest results.',
    })
  const candidate = saved.candidates.find(
    (item) => item.spotifyTrackId === spotifyTrackId,
  )
  if (!candidate)
    throw new ServerError({
      statusCode: 404,
      message: 'Spotify candidate was not found in the stored search.',
    })
  const [newer] = await database
    .select({ status: scrapeJob.status, options: scrapeJob.options })
    .from(scrapeJob)
    .where(
      and(
        trackSearchHistoryScope(trackId),
        sql`(${scrapeJob.createdAt}, ${scrapeJob.id}) >
          (select created_at, id from scrape_job where id = ${jobId})`,
        or(
          requesterIs(userId),
          inArray(scrapeJob.status, ['queued', 'running']),
          sql`${scrapeJob.options} ?| array['acceptedTrackId', 'acceptedSpotifyTrackId']`,
        ),
      ),
    )
    .orderBy(
      sql`(${scrapeJob.status} in ('queued', 'running') or
        ${scrapeJob.options} ?| array['acceptedTrackId', 'acceptedSpotifyTrackId']) desc`,
      desc(scrapeJob.createdAt),
      desc(scrapeJob.id),
    )
    .limit(1)
  if (
    newer?.status === 'queued' ||
    newer?.status === 'running' ||
    newer?.options.acceptedTrackId !== undefined ||
    newer?.options.acceptedSpotifyTrackId !== undefined
  )
    throw new ServerError({
      statusCode: 409,
      message: 'The Spotify search has changed. Review the latest results.',
    })
  if (newer && saved.job.options.acceptedTrackId === undefined) {
    if (
      !(await savedSearchTargetMatches(database, trackId, {
        ...saved.job.options,
        query: saved.query,
      }))
    )
      throw new ServerError({
        statusCode: 409,
        message: 'The library recording has changed. Review the current track.',
      })
    const [manual] = await database
      .select({ id: lastfmTrackSource.trackMediaItemId })
      .from(lastfmTrackSource)
      .where(
        and(
          eq(lastfmTrackSource.trackMediaItemId, trackId),
          eq(lastfmTrackSource.manuallyMatched, true),
        ),
      )
      .limit(1)
    if (manual)
      throw new ServerError({
        statusCode: 409,
        message: 'This recording has a manual match. Review its Sources.',
      })
  }
  return candidate
}
