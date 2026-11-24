import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { requireTrackSelectionScope } from './catalog-scope'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import {
  ProviderItemNotFoundError,
  type JsonValue,
} from '@repo/media-plugin-sdk'
import {
  TIDAL_TRACK_CANDIDATE_LIMIT,
  TIDAL_TRACK_MATCH_TASK,
  TidalTrackCandidateSchema,
  TidalTrackMatchAcceptInputSchema,
  TidalTrackMatchInputSchema,
  TidalTrackMatchJobSchema,
  TidalTrackMatchParamsSchema,
  TidalTrackMatchReasonSchema,
  TidalTrackMatchReviewSchema,
  TidalTrackMatchRunSchema,
  TidalTrackMatchSchema,
  TidalTrackMatchStatusInputSchema,
  TidalTrackMatchStatusSchema,
  TidalAlbumTrackAlignmentSchema,
  TidalTrackDataSchema,
  type TidalTrackCandidate,
  type TidalTrackMatchInput,
  type TidalTrackMatchReview,
} from '@repo/schemas/tidal'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import { validIsrc } from '@/lib/isrc'
import { plainKey } from '@/lib/lastfm-album-matching'
import { createStableId, parseOptionalDate } from '@/lib/media-utils'
import {
  createProviderResponseRecorder,
  providerResponseSecretValues,
} from '@/lib/provider-response-history'
import { tidalCountry, tidalToken } from '@/lib/tidal-api'
import { trackVersionQualifiers } from '@/lib/track-matching'
import {
  libraryTrack,
  mediaItem,
  providerReference,
  scrapeJob,
  scrapeJobLog,
} from '@/schemas/db'
import { lockLibraryTrackWrites } from './album-library-tracks'
import { observeCatalogMedia } from './catalog-discoveries'
import { createTaskJob, type TaskJobContext, type TaskJobResult } from './jobs'
import { providerOperation } from './manual-add'
import { latestCatalogResponseId } from './music-catalog-observations'
import { createProviderRequest } from './provider-requests'
import { saveProviderResponseCapture } from './provider-response-history'
import { appendProviderTaskReplayStep } from './provider-task-replay'
import {
  lookupTidalTracksByIsrc,
  type TidalTrackLookupPage,
} from './tidal-track-lookup'
import { recordTrackIsrcs } from './track-isrcs'

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
type Reader = Pick<typeof db, 'select'>

const PROVIDER = 'tidal'
const SOURCE = 'tidal-track-match'
/** Durations within this many seconds count as the library recording. */
const DURATION_TOLERANCE_SEC = 2

const MatchOptionsSchema = TidalTrackMatchParamsSchema.extend({
  isrc: z.string().min(1).max(40),
  groupKey: z.string().min(1),
  trackTitle: z.string().min(1).max(500),
})
const StoredMatchSchema = z.object({
  diagnostics: z.array(
    z.object({
      kind: z.literal(TIDAL_TRACK_MATCH_TASK),
      isrc: z.string(),
      reason: TidalTrackMatchReasonSchema,
      candidates: z
        .array(TidalTrackCandidateSchema)
        .max(TIDAL_TRACK_CANDIDATE_LIMIT),
    }),
  ),
})
const matchTrackId = sql<string>`${scrapeJob.options}->>'trackId'`
const isTrackMatch = and(
  eq(scrapeJob.provider, PROVIDER),
  sql`${scrapeJob.options}->>'task' = ${sql.raw(`'${TIDAL_TRACK_MATCH_TASK}'`)}`,
)
const jobColumns = {
  id: scrapeJob.id,
  status: scrapeJob.status,
  errorMessage: scrapeJob.errorMessage,
  createdAt: scrapeJob.createdAt,
  finishedAt: scrapeJob.finishedAt,
  options: scrapeJob.options,
}
type MatchJob = Pick<typeof scrapeJob.$inferSelect, keyof typeof jobColumns>

/** A visible library track, its ISRC and the UPCs of its library albums. */
export async function matchTarget(
  database: Pick<typeof db, 'select'>,
  id: string,
) {
  const [target] = await database
    .select({
      title: mediaItem.title,
      durationSec: sql<number | null>`coalesce(${libraryTrack.durationSec},
        (select t.duration_sec from track t
          where t.track_media_item_id = ${mediaItem.id} and t.duration_sec is not null
          order by t.created_at, t.id limit 1))`,
      isrc: sql<string | null>`coalesce(nullif(btrim(${libraryTrack.isrc}), ''),
        (select r.external_id from provider_reference r
          where r.media_item_id = ${mediaItem.id} and r.reference_type = 'isrc'
          order by r.created_at, r.external_id limit 1))`,
      upcs: sql<string[]>`coalesce((select array_agg(distinct r.external_id)
        from provider_reference r
        where r.reference_type = 'upc' and r.media_item_id in (
          select t.album_media_item_id from track t
            where t.track_media_item_id = ${mediaItem.id}
          union select ${libraryTrack.albumMediaItemId}
            where ${libraryTrack.albumMediaItemId} is not null)), '{}')`,
    })
    .from(mediaItem)
    .innerJoin(libraryTrack, eq(libraryTrack.mediaItemId, mediaItem.id))
    .where(
      and(
        eq(mediaItem.id, id),
        eq(mediaItem.mediaType, 'track'),
        sql`${mediaItem.metadata}->>'legacyHidden' is distinct from 'true'`,
      ),
    )
  if (!target) return undefined
  return {
    ...target,
    title: target.title.trim(),
    isrc: validIsrc(target.isrc),
    upcs: new Set(target.upcs.map(barcodeKey)),
  }
}

const barcodeKey = (value: string) => value.trim().padStart(14, '0')

export async function prepareTidalTrackMatch(
  userId: string | null,
  input: Record<string, unknown>,
) {
  const { trackId } = TidalTrackMatchParamsSchema.parse(input)
  const target = await matchTarget(db, trackId)
  if (!target)
    throw new ServerError({
      statusCode: 404,
      message: 'Library track not found.',
    })
  if (!target.isrc)
    throw new ServerError({
      statusCode: 409,
      message: 'The track has no ISRC.',
    })
  return MatchOptionsSchema.parse({
    trackId,
    isrc: target.isrc,
    groupKey: createStableId(
      TIDAL_TRACK_MATCH_TASK,
      JSON.stringify([userId, trackId]),
    ),
    trackTitle: target.title.slice(0, 500),
  })
}

type Choice = {
  reason: z.infer<typeof TidalTrackMatchReasonSchema>
  chosen: TidalTrackCandidate | null
}

/**
 * Narrows the candidates by album UPC, duration, version and streaming, each
 * step only when it leaves at least one. Several left are left for review.
 */
export function chooseTidalTrack(
  candidates: readonly TidalTrackCandidate[],
  library: { title: string; durationSec: number | null; upcs: Set<string> },
): Choice {
  const [first] = candidates
  if (!first) return { reason: 'none', chosen: null }
  if (candidates.length === 1) return { reason: 'single', chosen: first }
  const versions = trackVersionQualifiers(library.title).map(plainKey)
  const steps: [
    Choice['reason'],
    (list: TidalTrackCandidate[]) => TidalTrackCandidate[],
  ][] = [
    [
      'album-upc',
      (list) =>
        list.filter((candidate) =>
          candidate.albums.some(
            (album) =>
              album.barcodeId !== null &&
              library.upcs.has(barcodeKey(album.barcodeId)),
          ),
        ),
    ],
    [
      'duration',
      (list) => {
        const { durationSec } = library
        if (durationSec === null) return []
        const close = list.flatMap((candidate) =>
          candidate.durationSec !== null &&
          Math.abs(candidate.durationSec - durationSec) <=
            DURATION_TOLERANCE_SEC
            ? [
                {
                  candidate,
                  gap: Math.abs(candidate.durationSec - durationSec),
                },
              ]
            : [],
        )
        const nearest = Math.min(...close.map(({ gap }) => gap))
        return close
          .filter(({ gap }) => gap === nearest)
          .map(({ candidate }) => candidate)
      },
    ],
    [
      'version',
      (list) =>
        list.filter(({ version }) =>
          versions.length
            ? version !== null && versions.includes(plainKey(version))
            : version === null,
        ),
    ],
    ['streamable', (list) => list.filter(({ streamable }) => streamable)],
  ]
  let remaining = [...candidates]
  for (const [reason, step] of steps) {
    const kept = step(remaining)
    if (!kept.length) continue
    remaining = kept
    const [only] = remaining
    if (remaining.length === 1 && only) return { reason, chosen: only }
  }
  return { reason: 'ambiguous', chosen: null }
}

/** What a library track keeps from the chosen TIDAL track. */
function referenceMetadata(
  candidate: TidalTrackCandidate,
  input: {
    jobId: string
    matchReason: z.infer<typeof TidalTrackMatchReasonSchema>
    recordedAt: Date
  },
): Record<string, JsonValue> {
  const { url, version, durationSec, popularity, bpm, key, keyScale } =
    candidate
  return {
    url,
    version,
    durationSec,
    popularity,
    ...(bpm === undefined ? {} : { bpm }),
    ...(key === undefined ? {} : { key }),
    ...(keyScale === undefined ? {} : { keyScale }),
    source: SOURCE,
    jobId: input.jobId,
    matchReason: input.matchReason,
    recordedAt: input.recordedAt.toISOString(),
  }
}

/**
 * Replaces the track's earlier TIDAL track match with this one and records
 * its ISRC. A reference an album job wrote for the same TIDAL track is kept.
 */
async function writeTidalTrackMatch(
  tx: Transaction,
  input: {
    trackId: string
    isrc: string
    candidate: TidalTrackCandidate
    jobId: string
    matchReason: z.infer<typeof TidalTrackMatchReasonSchema>
  },
) {
  const recordedAt = new Date()
  await tx
    .delete(providerReference)
    .where(
      and(
        eq(providerReference.mediaItemId, input.trackId),
        eq(providerReference.provider, PROVIDER),
        eq(providerReference.referenceType, 'track'),
        sql`${providerReference.metadata}->>'source' = ${SOURCE}`,
      ),
    )
  await tx
    .insert(providerReference)
    .values({
      id: createStableId(
        'pref',
        `${input.trackId}:${PROVIDER}:track:${input.candidate.tidalTrackId}`,
      ),
      mediaItemId: input.trackId,
      provider: PROVIDER,
      referenceType: 'track',
      externalId: input.candidate.tidalTrackId,
      isPrimary: true,
      metadata: referenceMetadata(input.candidate, { ...input, recordedAt }),
    })
    .onConflictDoNothing()
  await recordTrackIsrcs(
    tx,
    [
      {
        mediaItemId: input.trackId,
        isrc: validIsrc(input.candidate.isrc) ?? input.isrc,
        provider: PROVIDER,
        source: { kind: SOURCE, jobId: input.jobId },
      },
    ],
    recordedAt,
  )
}

async function libraryTrackExists(tx: Transaction, trackId: string) {
  const [row] = await tx
    .select({ id: libraryTrack.mediaItemId })
    .from(libraryTrack)
    .where(eq(libraryTrack.mediaItemId, trackId))
  return row !== undefined
}

async function observeTidalLookup(
  tx: Transaction,
  jobId: string,
  subjectId: string,
  pages: Array<TidalTrackLookupPage & { responseId?: string }>,
) {
  for (const { page, candidates, responseId } of pages) {
    for (const [index, candidate] of candidates.entries()) {
      const position = index + 1
      const occurrence = {
        provider: PROVIDER,
        operation: 'tidal-track-match',
        jobId,
        responseId,
        page,
        position,
      }
      const trackId = await observeCatalogMedia(
        tx,
        {
          kind: 'track',
          title: candidate.title,
          provider: PROVIDER,
          referenceType: 'track',
          externalId: candidate.tidalTrackId,
          credits: candidate.artistCredits?.map(({ id, name }) => ({
            name,
            externalId: id,
          })),
          durationSec: candidate.durationSec,
          referenceMetadata: {
            url: candidate.url,
            version: candidate.version,
            durationSec: candidate.durationSec,
            popularity: candidate.popularity,
            isrc: candidate.isrc,
          },
        },
        {
          ...occurrence,
          occurrenceKey: JSON.stringify([jobId, page, position]),
          subjectKind: 'track',
          subjectId,
        },
      )
      for (const [albumIndex, item] of candidate.albums.entries()) {
        await observeCatalogMedia(
          tx,
          {
            kind: 'album',
            title: item.title,
            provider: PROVIDER,
            referenceType: 'album',
            externalId: item.tidalAlbumId,
            releaseDate: parseOptionalDate(item.releaseDate),
            referenceMetadata: {
              barcodeId: item.barcodeId,
              albumType: item.albumType,
            },
          },
          {
            ...occurrence,
            occurrenceKey: JSON.stringify([
              jobId,
              page,
              position,
              albumIndex + 1,
            ]),
            subjectKind: 'track',
            subjectId: trackId,
            relationshipRole: 'release',
          },
        )
      }
    }
  }
}

export async function runTidalTrackMatch(
  context: TaskJobContext,
  input: Record<string, unknown>,
): Promise<TaskJobResult> {
  try {
    const options = MatchOptionsSchema.parse(input)
    await context.assertActive()
    const target = await matchTarget(db, options.trackId)
    if (!target || target.isrc !== options.isrc)
      return {
        outcome: 'complete',
        message: 'Match skipped: the track or its ISRC has changed.',
        noProviderRequests: true,
      }
    const pages: Array<TidalTrackLookupPage & { responseId?: string }> = []
    const candidates = await providerOperation(
      PROVIDER,
      async ({ secrets, request }, plugin) => {
        const token = await tidalToken(secrets, request)
        const lookup = {
          countryCode: tidalCountry(secrets),
          isrc: options.isrc,
        }
        await appendProviderTaskReplayStep(
          context.jobId,
          PROVIDER,
          TIDAL_TRACK_MATCH_TASK,
          { operation: 'isrc-lookup', args: lookup },
        )
        const recorder = createProviderResponseRecorder(
          (capture) =>
            saveProviderResponseCapture({
              jobId: context.jobId,
              provider: PROVIDER,
              attempt: 1,
              capture,
            }),
          providerResponseSecretValues(secrets),
        )
        const found = await lookupTidalTracksByIsrc(
          createProviderRequest(plugin, context.assertActive, {
            ...(context.maxSlotWaitMs === undefined
              ? {}
              : { maxSlotWaitMs: context.maxSlotWaitMs }),
            beginResponseCapture: recorder('task'),
          }),
          token,
          lookup,
          async (page) => {
            const responseId = await latestCatalogResponseId(
              db,
              context.jobId,
              PROVIDER,
            )
            pages.push({ ...page, responseId })
          },
        )
        recorder.assertStored()
        return found
      },
      context.assertActive,
      'matching tracks',
      context.maxSlotWaitMs,
    )
    if (!(await context.isActive())) return { outcome: 'stopped' }
    const kept = candidates.slice(0, TIDAL_TRACK_CANDIDATE_LIMIT)
    const { reason, chosen } = chooseTidalTrack(kept, target)
    const diagnostics = [
      {
        kind: TIDAL_TRACK_MATCH_TASK,
        isrc: options.isrc,
        reason,
        candidates: kept,
      },
    ]
    if (reason === 'none') {
      await db.transaction((tx) =>
        observeTidalLookup(tx, context.jobId, options.trackId, pages),
      )
      return {
        outcome: 'failed',
        failureClassification: 'not-found',
        error: new ProviderItemNotFoundError(
          'TIDAL has no track with this ISRC.',
        ),
        metadata: { diagnostics },
      }
    }
    return {
      outcome: 'complete',
      message: chosen
        ? `Matched TIDAL track ${chosen.tidalTrackId} (${reason}).`
        : `${kept.length} TIDAL tracks share the ISRC. Choose one in review.`,
      options: {
        reason,
        candidateCount: kept.length,
        ...(chosen ? { acceptedTidalTrackId: chosen.tidalTrackId } : {}),
      },
      metadata: { diagnostics },
      persist: async (tx) => {
        await lockLibraryTrackWrites(tx)
        if (chosen && (await libraryTrackExists(tx, options.trackId))) {
          await writeTidalTrackMatch(tx, {
            trackId: options.trackId,
            isrc: options.isrc,
            candidate: chosen,
            jobId: context.jobId,
            matchReason: reason,
          })
        }
        await observeTidalLookup(tx, context.jobId, options.trackId, pages)
      },
    }
  } catch (error) {
    if (!(await context.isActive())) return { outcome: 'stopped' }
    return { outcome: 'failed', error }
  }
}

/**
 * Matches each track by ISRC in this request, one after another through the
 * request gate, and returns each one's result. Missing tracks, tracks without
 * an ISRC and tracks already being matched are skipped. A cooldown or busy
 * provider refuses the request when nothing has run yet, and otherwise stops
 * the rest. A later bulk run calls this per batch the same way.
 */
export async function matchTidalTracks(
  input: TidalTrackMatchInput,
  userId: string | null,
) {
  const {
    trackIds,
    batchId = nanoid(),
    catalogScope,
  } = TidalTrackMatchInputSchema.parse(input)
  await requireTrackSelectionScope(trackIds, catalogScope)
  const unique = [...new Set(trackIds)]
  const items: TidalTrackMatchReview[] = []
  const warnings: string[] = []
  let skipped = 0
  let notRun = 0
  for (const [index, trackId] of unique.entries()) {
    try {
      await createTaskJob(TIDAL_TRACK_MATCH_TASK, userId, {
        taskOptions: { trackId, batchId },
        skipActive: true,
      })
      items.push(await readTidalTrackMatch(db, trackId))
    } catch (error) {
      if (!(error instanceof ServerError)) throw error
      const { statusCode, message } = error.response
      if (statusCode === 429 && items.length) {
        notRun = unique.length - index
        warnings.push(message)
        break
      }
      if (![404, 409].includes(statusCode)) throw error
      skipped += 1
    }
  }
  if (skipped)
    warnings.unshift(
      'Missing tracks, tracks without an ISRC and tracks already being matched were skipped.',
    )
  return TidalTrackMatchRunSchema.parse({
    batchId,
    items,
    skipped: skipped + trackIds.length - unique.length,
    notRun,
    warnings,
  })
}

// The latest TIDAL match job of a track. Its expressions and order are those
// of the partial index on TIDAL match jobs.
const latestMatchJobId = sql`(select j.id from scrape_job j
  where j.provider = ${PROVIDER}
    and j.options->>'task' = ${sql.raw(`'${TIDAL_TRACK_MATCH_TASK}'`)}
    and j.options->>'trackId' = ${mediaItem.id}
  order by j.created_at desc, j.id desc limit 1)`
// The track's current TIDAL track: a track match before an album alignment,
// then the most recently recorded.
const currentReferenceId = sql`(select r.id from provider_reference r
  where r.media_item_id = ${mediaItem.id} and r.provider = ${PROVIDER}
    and r.reference_type = 'track'
  order by (r.metadata->>'source' = ${SOURCE}) desc nulls last,
    r.metadata->>'recordedAt' desc nulls last, r.id
  limit 1)`

const ReferenceMetadataSchema = TidalTrackDataSchema.extend({
  source: TidalTrackMatchSchema.shape.source,
  matchReason: TidalTrackMatchReasonSchema.optional(),
  alignment: TidalAlbumTrackAlignmentSchema.optional(),
})

/** Each track's current TIDAL track and latest match job, in one statement. */
function readMatchStates(database: Reader, trackIds: string[]) {
  return database
    .select({
      trackId: mediaItem.id,
      job: jobColumns,
      tidalTrackId: providerReference.externalId,
      referenceMetadata: providerReference.metadata,
    })
    .from(mediaItem)
    .leftJoin(scrapeJob, eq(scrapeJob.id, latestMatchJobId))
    .leftJoin(providerReference, eq(providerReference.id, currentReferenceId))
    .where(inArray(mediaItem.id, trackIds))
}

function currentMatch(
  tidalTrackId: string | null,
  metadata: Record<string, JsonValue> | null,
) {
  const parsed = ReferenceMetadataSchema.safeParse(metadata)
  if (!tidalTrackId || !parsed.success) return null
  const match = TidalTrackMatchSchema.safeParse({
    ...parsed.data,
    tidalTrackId,
    matchReason: parsed.data.matchReason ?? null,
    alignment: parsed.data.alignment ?? null,
  })
  return match.success ? match.data : null
}

const optionalString = (value: JsonValue | undefined) =>
  typeof value === 'string' ? value : null

function summarizeMatch(job: MatchJob) {
  const reason = TidalTrackMatchReasonSchema.safeParse(job.options.reason)
  const count = job.options.candidateCount
  return TidalTrackMatchJobSchema.parse({
    jobId: job.id,
    status: job.status,
    isrc: optionalString(job.options.isrc),
    reason: reason.success ? reason.data : null,
    acceptedTidalTrackId: optionalString(job.options.acceptedTidalTrackId),
    candidateCount: typeof count === 'number' ? count : null,
    errorMessage: job.errorMessage,
    createdAt: job.createdAt.toISOString(),
    finishedAt: job.finishedAt?.toISOString() ?? null,
  })
}

async function storedMatch(database: Pick<Reader, 'select'>, jobId: string) {
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
    const parsed = StoredMatchSchema.safeParse(log.metadata)
    const result = parsed.success ? parsed.data.diagnostics[0] : undefined
    if (result) return result
  }
  return null
}

/**
 * The candidates a review shows: all of an unresolved ambiguous lookup, or
 * the one the job settled on.
 */
async function reviewCandidates(database: Reader, job: MatchJob) {
  if (job.status !== 'succeeded') return []
  const accepted = optionalString(job.options.acceptedTidalTrackId)
  if (!accepted && job.options.reason !== 'ambiguous') return []
  const stored = await storedMatch(database, job.id)
  if (!stored) return []
  return accepted
    ? stored.candidates.filter(({ tidalTrackId }) => tidalTrackId === accepted)
    : stored.candidates
}

async function readTidalTrackMatch(database: Reader, trackId: string) {
  const [state] = await readMatchStates(database, [trackId])
  const job = state?.job ?? null
  return TidalTrackMatchReviewSchema.parse({
    trackId,
    match: state
      ? currentMatch(state.tidalTrackId, state.referenceMetadata)
      : null,
    job: job ? summarizeMatch(job) : null,
    candidates: job ? await reviewCandidates(database, job) : [],
  })
}

export async function getTidalTrackMatch(trackId: string) {
  const { trackId: id } = TidalTrackMatchParamsSchema.parse({ trackId })
  if (!(await matchTarget(db, id)))
    throw new ServerError({
      statusCode: 404,
      message: 'Library track not found.',
    })
  return readTidalTrackMatch(db, id)
}

export async function listTidalTrackMatchStatuses(
  input: z.input<typeof TidalTrackMatchStatusInputSchema>,
) {
  const ids = [
    ...new Set(TidalTrackMatchStatusInputSchema.parse(input).trackIds),
  ]
  const states = new Map(
    (await readMatchStates(db, ids)).map((state) => [state.trackId, state]),
  )
  return TidalTrackMatchStatusSchema.parse({
    items: ids.map((trackId) => {
      const state = states.get(trackId)
      return {
        trackId,
        match: state
          ? currentMatch(state.tidalTrackId, state.referenceMetadata)
          : null,
        job: state?.job ? summarizeMatch(state.job) : null,
        candidates: [],
      }
    }),
  })
}

/** Links the track to a TIDAL track the owner chose from a stored lookup. */
export async function acceptTidalTrackMatch(input: {
  trackId: string
  jobId: string
  tidalTrackId: string
}) {
  const { trackId } = TidalTrackMatchParamsSchema.parse(input)
  const { jobId, tidalTrackId } = TidalTrackMatchAcceptInputSchema.parse({
    jobId: input.jobId,
    tidalTrackId: input.tidalTrackId,
  })
  return db.transaction(async (tx) => {
    await lockLibraryTrackWrites(tx)
    const [job] = await tx
      .select(jobColumns)
      .from(scrapeJob)
      .where(
        and(eq(scrapeJob.id, jobId), isTrackMatch, eq(matchTrackId, trackId)),
      )
      .for('update')
    if (!job || job.status !== 'succeeded')
      throw new ServerError({
        statusCode: 404,
        message: 'TIDAL match was not found.',
      })
    const [active] = await tx
      .select({ id: scrapeJob.id })
      .from(scrapeJob)
      .where(
        and(
          isTrackMatch,
          eq(matchTrackId, trackId),
          inArray(scrapeJob.status, ['queued', 'running']),
        ),
      )
      .limit(1)
    if (active)
      throw new ServerError({
        statusCode: 409,
        message: 'A newer TIDAL match is queued or running.',
      })
    const stored = await storedMatch(tx, jobId)
    const candidate = stored?.candidates.find(
      (item) => item.tidalTrackId === tidalTrackId,
    )
    if (!stored || !candidate)
      throw new ServerError({
        statusCode: 404,
        message: 'TIDAL candidate was not found in the stored match.',
      })
    const isrc = optionalString(job.options.isrc)
    if (!isrc || !(await libraryTrackExists(tx, trackId)))
      throw new ServerError({
        statusCode: 404,
        message: 'Library track not found.',
      })
    await writeTidalTrackMatch(tx, {
      trackId,
      isrc,
      candidate,
      jobId,
      matchReason: 'manual',
    })
    await tx
      .update(scrapeJob)
      .set({
        options: sql`${scrapeJob.options} || ${JSON.stringify({ acceptedTidalTrackId: tidalTrackId })}::jsonb`,
      })
      .where(eq(scrapeJob.id, jobId))
    return readTidalTrackMatch(tx, trackId)
  })
}
