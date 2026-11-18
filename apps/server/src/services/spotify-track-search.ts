import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import { EnrichmentResultSchema } from '@repo/schemas/job'
import {
  SPOTIFY_TRACK_SEARCH_LIMIT,
  SPOTIFY_TRACK_SEARCH_TASK,
  SpotifyTrackSearchCandidateSchema,
  SpotifyTrackSearchInputSchema,
  SpotifyTrackSearchJobSchema,
  SpotifyTrackSearchParamsSchema,
  SpotifyTrackSearchSchema,
  SpotifyTrackSearchStatusInputSchema,
  SpotifyTrackSearchStatusSchema,
  type SpotifyTrackSearchFreshness,
  type SpotifyTrackSearchInput,
} from '@repo/schemas/spotify-track-search'
import { parseTrackNumberPrefix } from '@/lib/album-track-aliases'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import { createStableId } from '@/lib/media-utils'
import {
  artist,
  libraryTrack,
  mediaCredit,
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
import {
  listTracksNeedingSpotifyMatch,
  spotifySearchRecordingId,
  trackMatchesSpotifySearchFreshness,
} from './track-match-diagnostics'

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
type SearchReader = Pick<typeof db, 'select' | 'selectDistinctOn'>

const SearchOptionsSchema = SpotifyTrackSearchParamsSchema.extend({
  trackTitle: z.string().min(1).max(500),
  groupKey: z.string().min(1),
  query: z.string().min(1).max(200),
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
const isTrackSearch = sql`${scrapeJob.options}->>'task' = ${sql.raw(`'${SPOTIFY_TRACK_SEARCH_TASK}'`)}`

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
      firstArtist: sql<string | null>`(select ${artist.name} from ${mediaCredit}
        join ${artist} on ${artist.id} = ${mediaCredit.artistId}
        where ${mediaCredit.mediaItemId} = ${mediaItem.id} and ${mediaCredit.role} = 'artist'
        order by ${mediaCredit.billingOrder}, ${artist.id} limit 1)`,
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
  if (!track)
    throw new ServerError({
      statusCode: 404,
      message: 'Library track not found.',
    })
  const numbered =
    track.sourceLabel === 'lastfm'
      ? parseTrackNumberPrefix(track.title.trim())
      : undefined
  const title = searchOption(numbered?.title ?? track.title, 110)
  const artistName = searchOption(track.firstArtist ?? '', 70)
  return {
    trackTitle: track.title.trim().slice(0, 500),
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
  const groupKey = createStableId(
    SPOTIFY_TRACK_SEARCH_TASK,
    JSON.stringify([userId, trackId]),
  )
  if (
    (input.groupKey !== undefined && input.groupKey !== groupKey) ||
    !target.query
  )
    throw new ServerError({
      statusCode: 409,
      message: 'The track is unavailable for this search.',
    })
  await prepareSpotifyCatalogTrackSearch(userId)
  return SearchOptionsSchema.parse({ trackId, groupKey, ...target })
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
          ...(freshness?.length ? { freshness } : {}),
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
  userId: string | null,
  scope: 'requested' | 'retained' = 'requested',
) {
  const visibleId =
    scope === 'retained'
      ? spotifySearchRecordingId(sql`${scrapeJob.options}`)
      : searchTrackId
  const pastId =
    scope === 'retained'
      ? spotifySearchRecordingId(sql`previous.options`)
      : sql`previous.options->>'trackId'`
  const history = sql`from scrape_job previous
    where previous.options->>'task' = ${sql.raw(`'${SPOTIFY_TRACK_SEARCH_TASK}'`)}
      and ${pastId} = ${visibleId}
      and previous.requested_by_user_id is not distinct from ${userId}`
  return database
    .selectDistinctOn([visibleId], {
      trackId: visibleId,
      id: scrapeJob.id,
      status: scrapeJob.status,
      errorMessage: scrapeJob.errorMessage,
      createdAt: scrapeJob.createdAt,
      startedAt: scrapeJob.startedAt,
      finishedAt: scrapeJob.finishedAt,
      options: scrapeJob.options,
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
      and(isTrackSearch, requesterIs(userId), inArray(visibleId, trackIds)),
    )
    .orderBy(
      visibleId,
      sql`${scrapeJob.createdAt} desc nulls last`,
      sql`${scrapeJob.id} desc nulls last`,
    )
}

function summarizeSearch(
  job: Awaited<ReturnType<typeof latestTrackSearchJobs>>[number],
) {
  return SpotifyTrackSearchJobSchema.parse({
    jobId: job.id,
    status: job.status,
    acceptedTrackId: job.options.acceptedTrackId,
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

async function storedSearch(database: SearchReader, jobId: string) {
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
    const parsed = StoredResultSchema.safeParse(log.metadata)
    if (parsed.success && parsed.data.diagnostics[0])
      return parsed.data.diagnostics[0]
  }
  return null
}

export async function getSpotifyTrackSearch(trackId: string, userId: string) {
  const [retainedJob] = await latestTrackSearchJobs(
    db,
    [trackId],
    userId,
    'retained',
  )
  const job =
    retainedJob ?? (await latestTrackSearchJobs(db, [trackId], userId))[0]
  const stored =
    job?.status === 'succeeded' ? await storedSearch(db, job.id) : null
  const query =
    stored?.query ??
    job?.options.query ??
    (await trackSearchTarget(db, trackId)).query
  return SpotifyTrackSearchSchema.parse({
    job: job ? summarizeSearch(job) : null,
    query,
    candidates: stored?.candidates ?? [],
  })
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
  const [job] = await latestTrackSearchJobs(database, [trackId], userId)
  if (job?.id !== jobId || job.status !== 'succeeded')
    throw new ServerError({
      statusCode: 409,
      message: 'The Spotify search has changed. Review the latest results.',
    })
  const result = await storedSearch(database, jobId)
  const candidate = result?.candidates.find(
    (item) => item.spotifyTrackId === spotifyTrackId,
  )
  if (!candidate)
    throw new ServerError({
      statusCode: 404,
      message: 'Spotify candidate was not found in the stored search.',
    })
  return candidate
}
