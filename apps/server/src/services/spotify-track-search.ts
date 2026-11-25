import { and, asc, desc, eq, gt, inArray, or, sql } from 'drizzle-orm'
import { requireTrackSelectionScope } from './catalog-scope'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import { EnrichmentResultSchema, JobScopeSchema } from '@repo/schemas/job'
import {
  SPOTIFY_INTERACTIVE_TRACK_SEARCH,
  SPOTIFY_TRACK_SEARCH_LIMIT,
  SPOTIFY_TRACK_SEARCH_TASK,
  SpotifyInteractiveTrackSearchInputSchema,
  SpotifyInteractiveTrackSearchResultSchema,
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
  isInteractiveSpotifyTrackSearchResponse,
  spotifyInteractiveSearchMetadata,
} from '@/lib/spotify-interactive-search'
import {
  catalogObservation,
  lastfmTrackSource,
  libraryTrack,
  mediaItem,
  providerSnapshot,
  scrapeJob,
  scrapeJobLog,
} from '@/schemas/db'
import { lockLibraryTrackWrites } from './album-library-tracks'
import { createTaskJob, type TaskJobContext, type TaskJobResult } from './jobs'
import {
  lookupSpotifyTrackCandidates,
  prepareSpotifyCatalogTrackSearch,
  searchSpotifyTrackCandidates,
  searchSpotifyTrackCandidatesInRequest,
} from './manual-add'
import {
  completeSonovaultSpotifyStep,
  sonovaultSpotifyStepIsCurrent,
} from './sonovault-track-candidates'
import { closeChangeBatch, openChangeBatch } from './library-changes'
import {
  latestCatalogResponseId,
  observeSpotifySearchResults,
  observeSpotifySearchTrack,
} from './music-catalog-observations'
import type { SpotifySearchObservation } from './provider-search-task-replay'
import { reconcileSpotifyTrackSearchInTransaction } from './spotify-track-search-acceptance'
import {
  sameSpotifySearchArtists,
  spotifySearchArtistNames,
} from './spotify-track-search-evidence'
import {
  listTracksNeedingSpotifyMatch,
  spotifySearchRecordingId,
  spotifyTrackSearchHistory,
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
  /**
   * Read this one catalog track instead of searching: the Spotify ID of a
   * Sonovault candidate accepted for the track (SONO-25).
   */
  spotifyTrackId: z
    .string()
    .regex(/^[A-Za-z0-9]{22}$/)
    .optional(),
  sonovaultTrackId: z.string().min(1).max(100).optional(),
})
const SonovaultStepSchema = SearchOptionsSchema.pick({
  spotifyTrackId: true,
  sonovaultTrackId: true,
}).required()

const InteractiveSearchSchema = SpotifyInteractiveTrackSearchResultSchema.omit({
  searchId: true,
  searchedAt: true,
}).extend({
  trackId: SearchOptionsSchema.shape.trackId,
  trackTitle: z.string().min(1),
  trackArtists: z.array(z.string()),
  kind: z.literal(SPOTIFY_INTERACTIVE_TRACK_SEARCH),
  ownerKey: z.string(),
  acceptedSpotifyTrackId:
    SpotifyTrackSearchCandidateSchema.shape.spotifyTrackId.optional(),
})

export async function readSpotifyTrackSearchSnapshotIds(
  tx: Transaction,
  trackId: string,
) {
  const rows = await tx
    .select({ id: providerSnapshot.id })
    .from(providerSnapshot)
    .where(
      and(
        isInteractiveSpotifyTrackSearchResponse,
        eq(providerSnapshot.mediaItemId, trackId),
      ),
    )
  return rows.map(({ id }) => id)
}
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

function sameSearchTarget(
  target: Awaited<ReturnType<typeof trackSearchTarget>>,
  saved: { trackTitle: string; trackArtists: string[] },
) {
  return (
    target !== undefined &&
    albumNameKey(target.trackTitle) === albumNameKey(saved.trackTitle) &&
    sameSpotifySearchArtists(target.trackArtists, saved.trackArtists)
  )
}

export async function searchSpotifyTrackInRequest(
  trackId: string,
  input: z.infer<typeof SpotifyInteractiveTrackSearchInputSchema>,
  userId: string,
) {
  const target = await trackSearchTarget(db, trackId)
  if (!target)
    throw new ServerError({
      statusCode: 404,
      message: 'Library track not found.',
    })
  const unavailable = () =>
    new ServerError({
      statusCode: 409,
      message:
        'The recording changed or already has a Spotify match. Review the current track.',
    })
  if (!(await needsMatch(db, trackId))) throw unavailable()

  const { items, observations, evidence } =
    await searchSpotifyTrackCandidatesInRequest(
      trackId,
      input.query,
      userId,
      input.market,
    )
  const searchId = evidence.snapshotId
  return db.transaction(async (tx) => {
    await lockLibraryTrackWrites(tx)
    if (
      !sameSearchTarget(await trackSearchTarget(tx, trackId), target) ||
      !(await needsMatch(tx, trackId))
    )
      throw unavailable()
    const ids = await observeSpotifySearchResults(tx, observations, {
      operation: 'spotify-match',
      key: searchId,
      subjectKind: 'track',
      subjectId: trackId,
      snapshotId: searchId,
      observedAt: evidence.observedAt,
    })
    const library = ids.size
      ? await tx
          .select({ id: mediaItem.id, inLibrary: mediaItem.inLibrary })
          .from(mediaItem)
          .where(inArray(mediaItem.id, [...ids.values()]))
      : []
    const membership = new Map(
      library.map(({ id, inLibrary }) => [id, inLibrary]),
    )
    const saved = InteractiveSearchSchema.parse({
      ...spotifyInteractiveSearchMetadata(userId),
      trackId,
      trackTitle: target.trackTitle,
      trackArtists: target.trackArtists,
      query: input.query,
      candidates: items,
    })
    await tx
      .update(providerSnapshot)
      .set({ normalizedData: saved })
      .where(eq(providerSnapshot.id, searchId))
    return SpotifyInteractiveTrackSearchResultSchema.parse({
      ...saved,
      searchId,
      searchedAt: evidence.observedAt.toISOString(),
      candidates: saved.candidates.map((candidate) => {
        const id = ids.get(candidate.spotifyTrackId)
        return id
          ? {
              ...candidate,
              catalogMediaItemId: id,
              inLibrary: membership.get(id),
            }
          : candidate
      }),
    })
  })
}

async function interactiveSearchHistory(trackId: string, userId: string) {
  const rows = await db
    .select({
      searchId: providerSnapshot.id,
      searchedAt: providerSnapshot.createdAt,
      data: providerSnapshot.normalizedData,
    })
    .from(providerSnapshot)
    .where(
      and(
        isInteractiveSpotifyTrackSearchResponse,
        eq(providerSnapshot.mediaItemId, trackId),
        sql`${providerSnapshot.normalizedData} ? 'candidates'`,
        sql`${providerSnapshot.normalizedData}->>'ownerKey' = ${spotifyInteractiveSearchMetadata(userId).ownerKey}`,
      ),
    )
    .orderBy(desc(providerSnapshot.createdAt), desc(providerSnapshot.id))
  const searches = rows.flatMap(({ searchId, searchedAt, data }) => {
    const saved = InteractiveSearchSchema.safeParse(data)
    if (!saved.success) return []
    return [{ saved: saved.data, searchId, searchedAt }]
  })
  if (!searches.length) return []
  const observations = await db
    .select({
      searchId: catalogObservation.snapshotId,
      position: catalogObservation.position,
      catalogMediaItemId: mediaItem.id,
      inLibrary: mediaItem.inLibrary,
    })
    .from(catalogObservation)
    .innerJoin(mediaItem, eq(mediaItem.id, catalogObservation.mediaItemId))
    .where(
      and(
        eq(catalogObservation.operation, 'spotify-match'),
        eq(catalogObservation.subjectKind, 'track'),
        eq(catalogObservation.targetKind, 'track'),
        inArray(catalogObservation.subjectId, [
          ...new Set(searches.map(({ saved }) => saved.trackId)),
        ]),
        inArray(
          catalogObservation.snapshotId,
          searches.map(({ searchId }) => searchId),
        ),
      ),
    )
  const byPosition = new Map(
    observations.map((row) => [
      JSON.stringify([row.searchId, row.position]),
      row,
    ]),
  )
  return searches.map(({ saved, searchId, searchedAt }) =>
    SpotifyInteractiveTrackSearchResultSchema.parse({
      ...saved,
      searchId,
      searchedAt: searchedAt.toISOString(),
      candidates: saved.candidates.map((candidate, index) => {
        const hit = byPosition.get(
          JSON.stringify([searchId, candidate.catalogPosition ?? index + 1]),
        )
        return hit
          ? {
              ...candidate,
              catalogMediaItemId: hit.catalogMediaItemId,
              inLibrary: hit.inLibrary,
            }
          : candidate
      }),
    }),
  )
}

export async function readInteractiveSpotifyTrackSearch(
  tx: Transaction,
  {
    trackId,
    searchId,
    spotifyTrackId,
    userId,
  }: {
    trackId: string
    searchId: string
    spotifyTrackId: string
    userId: string
  },
) {
  const [row] = await tx
    .select({ data: providerSnapshot.normalizedData })
    .from(providerSnapshot)
    .where(
      and(
        isInteractiveSpotifyTrackSearchResponse,
        eq(providerSnapshot.id, searchId),
      ),
    )
  const saved = InteractiveSearchSchema.safeParse(row?.data)
  if (
    !saved.success ||
    saved.data.trackId !== trackId ||
    saved.data.ownerKey !== spotifyInteractiveSearchMetadata(userId).ownerKey
  )
    throw new ServerError({
      statusCode: 404,
      message: 'Saved Spotify search not found.',
    })
  const candidate = saved.data.candidates.find(
    (item) => item.spotifyTrackId === spotifyTrackId,
  )
  if (!candidate)
    throw new ServerError({
      statusCode: 404,
      message: 'Spotify candidate was not found in the stored search.',
    })
  if (
    saved.data.acceptedTrackId === undefined &&
    !sameSearchTarget(await trackSearchTarget(tx, trackId), saved.data)
  )
    throw new ServerError({
      statusCode: 409,
      message: 'The library recording has changed. Review the current track.',
    })
  return { candidate, options: saved.data }
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
  const sonovault =
    input.sonovaultTrackId === undefined
      ? undefined
      : SonovaultStepSchema.parse(input)
  const reviewQuery = sonovault
    ? `spotify:track:${sonovault.spotifyTrackId}`
    : input.reviewOnly === true
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
    ...(sonovault
      ? {
          ...sonovault,
          query: reviewQuery,
          ...(input.reviewOnly === true ? { reviewOnly: true } : {}),
        }
      : reviewQuery
        ? { query: reviewQuery, reviewOnly: true }
        : {}),
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
    await context.activity('Checking the track match')
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
    const sonovault =
      options.sonovaultTrackId && options.spotifyTrackId
        ? {
            sonovaultTrackId: options.sonovaultTrackId,
            spotifyTrackId: options.spotifyTrackId,
          }
        : null
    if (
      sonovault &&
      !(await sonovaultSpotifyStepIsCurrent(db, {
        trackId: options.trackId,
        ...sonovault,
      }))
    )
      return {
        outcome: 'complete',
        message:
          'Lookup skipped: the Sonovault candidate is no longer accepted.',
      }
    let observed: SpotifySearchObservation[] | undefined
    const capture = (results: SpotifySearchObservation[]) => {
      observed = results
    }
    await context.activity(
      sonovault
        ? 'Reading the Spotify track'
        : 'Searching Spotify for the track',
    )
    const candidates = sonovault
      ? await lookupSpotifyTrackCandidates(
          sonovault.spotifyTrackId,
          context.requestedByUserId,
          context.assertActive,
          options.market,
          context.jobId,
          capture,
        )
      : await searchSpotifyTrackCandidates(
          options.query,
          context.requestedByUserId,
          context.assertActive,
          options.market,
          context.jobId,
          capture,
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
        if (sonovault && context.requestedByUserId) {
          await completeSonovaultSpotifyStep(tx, {
            trackId: options.trackId,
            jobId: context.jobId,
            userId: context.requestedByUserId,
            ...sonovault,
          })
        } else if (!options.reviewOnly && context.requestedByUserId) {
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
        }
        if (observed?.length) {
          const responseId = await latestCatalogResponseId(
            tx,
            context.jobId,
            'spotify',
          )
          await observeSpotifySearchResults(tx, observed, {
            operation: 'spotify-match',
            key: context.jobId,
            subjectKind: 'track',
            subjectId: options.trackId,
            jobId: context.jobId,
            responseId,
          })
        } else {
          await observeSpotifyMatchCandidates(
            tx,
            context.jobId,
            options.trackId,
            candidates,
          )
        }
      },
    }
  } catch (error) {
    if (!(await context.isActive())) return { outcome: 'stopped' }
    return { outcome: 'failed', error }
  }
}

async function observeSpotifyMatchCandidates(
  tx: Transaction,
  jobId: string,
  trackId: string,
  candidates: z.infer<typeof SpotifyTrackSearchCandidateSchema>[],
  observedAt?: Date,
) {
  if (candidates.length === 0) return
  const responseId = await latestCatalogResponseId(tx, jobId, 'spotify')
  for (const [index, candidate] of candidates.entries()) {
    await observeSpotifySearchTrack(tx, candidate, {
      operation: 'spotify-match',
      key: jobId,
      subjectKind: 'track',
      subjectId: trackId,
      jobId,
      responseId,
      position: candidate.catalogPosition ?? index + 1,
      observedAt,
    })
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
    catalogScope,
  } = SpotifyTrackSearchInputSchema.parse(input)
  await requireTrackSelectionScope(trackIds, catalogScope)
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
  return database
    .selectDistinctOn([visibleId], {
      trackId: visibleId,
      ...searchJobColumns,
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
  const [jobRows, historyRows] = await Promise.all([
    latestTrackSearchJobs(db, ids, userId, 'retained'),
    db
      .select({
        trackId: sql<string>`search_history.id`,
        lastAttemptAt: sql<Date | null>`search_history.last_attempt`.mapWith(
          scrapeJob.startedAt,
        ),
        lastSuccessfulAt: sql<Date | null>`search_history.last_success`.mapWith(
          scrapeJob.finishedAt,
        ),
        latestStatus: sql<string>`search_history.latest_attempt_status`,
        latestResultCount: sql<
          number | null
        >`search_history.latest_result_count`,
        latestInteractive: sql<boolean>`search_history.latest_attempt_interactive`,
      })
      .from(sql`(${spotifyTrackSearchHistory(userId, ids)}) search_history`),
  ])
  const jobs = new Map(jobRows.map((job) => [job.trackId, job]))
  const history = new Map(historyRows.map((row) => [row.trackId, row]))
  return SpotifyTrackSearchStatusSchema.parse({
    items: ids.map((trackId) => {
      const job = jobs.get(trackId)
      const dates = history.get(trackId)
      return {
        trackId,
        job: job ? summarizeSearch(job) : null,
        lastAttemptAt: dates?.lastAttemptAt?.toISOString() ?? null,
        lastSuccessfulAt: dates?.lastSuccessfulAt?.toISOString() ?? null,
        ...(dates?.latestInteractive
          ? {
              interactive: {
                status: dates.latestStatus,
                resultCount: dates.latestResultCount,
              },
            }
          : {}),
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

/** Projects a bounded batch of saved candidate lists without calling Spotify. */
export async function backfillSpotifyTrackDiscoveries(input: {
  after?: string
  limit: number
  apply: boolean
}) {
  const jobs = await db
    .select({
      id: scrapeJob.id,
      options: scrapeJob.options,
      scope: scrapeJob.scope,
      finishedAt: scrapeJob.finishedAt,
    })
    .from(scrapeJob)
    .where(
      and(
        isTrackSearch,
        eq(scrapeJob.provider, 'spotify'),
        eq(scrapeJob.status, 'succeeded'),
        input.after ? gt(scrapeJob.id, input.after) : undefined,
      ),
    )
    .orderBy(asc(scrapeJob.id))
    .limit(input.limit)
  let candidates = 0
  let skipped = 0
  for (const job of jobs) {
    const trackId = SpotifyTrackSearchParamsSchema.shape.trackId.safeParse(
      job.options.trackId,
    )
    const result = await storedSearch(db, job.id)
    if (!trackId.success || !result || !savedSearchScopeMatches(job)) {
      skipped += 1
      continue
    }
    candidates += result.candidates.length
    if (input.apply)
      await db.transaction((tx) =>
        observeSpotifyMatchCandidates(
          tx,
          job.id,
          trackId.data,
          result.candidates,
          job.finishedAt ?? undefined,
        ),
      )
  }
  return { next: jobs.at(-1)?.id ?? null, candidates, skipped }
}

function trackSearchHistoryScope(trackId: string, userId?: string) {
  return and(
    eq(scrapeJob.provider, 'spotify'),
    isTrackSearch,
    userId === undefined ? undefined : requesterIs(userId),
    or(eq(searchTrackId, trackId), eq(retainedTrackId, trackId)),
  )
}

function savedSearchScopeMatches(job: Pick<SearchJob, 'scope' | 'options'>) {
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
  const [{ job, searches }, interactiveResults] = await Promise.all([
    readSpotifySearchHistory(db, trackId, userId),
    interactiveSearchHistory(trackId, userId),
  ])
  const observations = searches.length
    ? await db
        .select({
          jobId: catalogObservation.jobId,
          position: catalogObservation.position,
          id: mediaItem.id,
          inLibrary: mediaItem.inLibrary,
        })
        .from(catalogObservation)
        .innerJoin(mediaItem, eq(mediaItem.id, catalogObservation.mediaItemId))
        .where(
          and(
            eq(catalogObservation.operation, 'spotify-match'),
            eq(mediaItem.mediaType, 'track'),
            inArray(
              catalogObservation.jobId,
              searches.map(({ job }) => job.id),
            ),
          ),
        )
    : []
  const byPosition = new Map(
    observations.map((item) => [
      JSON.stringify([item.jobId, item.position]),
      item,
    ]),
  )
  const [saved, ...earlier] = searches.map((search) => ({
    job: { ...summarizeSearch(search.job), resultCount: search.resultCount },
    query: search.query,
    candidates: search.candidates.map((candidate) => {
      const position =
        candidate.catalogPosition ?? search.peers.indexOf(candidate) + 1
      const observed = byPosition.get(JSON.stringify([search.job.id, position]))
      return observed
        ? {
            ...candidate,
            catalogMediaItemId: observed.id,
            inLibrary: observed.inLibrary,
          }
        : candidate
    }),
  }))
  let query = saved?.query ?? job?.options.query ?? interactiveResults[0]?.query
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
    interactiveResults,
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
