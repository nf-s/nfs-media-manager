import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import type { JsonValue } from '@repo/media-plugin-sdk'
import { JsonValueSchema } from '@repo/schemas/common'
import { EnrichmentResultSchema } from '@repo/schemas/job'
import {
  SONOVAULT_BULK_LIMIT,
  SONOVAULT_TRACK_LOOKUP_TASK,
  SonovaultTrackLookupJobSchema,
  SonovaultTrackLookupParamsSchema,
} from '@repo/schemas/sonovault'
import {
  SonovaultCandidateAcceptResultSchema,
  SonovaultCandidateDecisionInputSchema,
  SonovaultCandidateParamsSchema,
  SonovaultCandidateStatusInputSchema,
  SonovaultCandidateStatusListSchema,
  SonovaultTrackCandidateReviewSchema,
  SonovaultTrackCandidateSchema,
} from '@repo/schemas/sonovault-candidates'
import { SPOTIFY_TRACK_SEARCH_TASK } from '@repo/schemas/spotify-track-search'
import { parseTrackNumberPrefix } from '@/lib/album-track-aliases'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import { validIsrc } from '@/lib/isrc'
import {
  createProviderResponseRecorder,
  providerResponseSecretValues,
} from '@/lib/provider-response-history'
import {
  resolveSonovaultTracks,
  SonovaultResolveResultSchema,
  sonovaultGatedPlugin,
  sonovaultLinkUrl,
  sonovaultSettings,
  type SonovaultBulkResolveResponse,
  type SonovaultResolveResult,
  type SonovaultTrack,
} from '@/lib/sonovault-api'
import {
  sonovaultCandidateArtists,
  sonovaultCandidateIsAutomatic,
  sonovaultCandidateSpotifyId,
  sonovaultSpotifyLink,
} from '@/lib/sonovault-candidates'
import {
  mediaItem,
  providerReference,
  scrapeJob,
  sonovaultTrackCandidate,
  sonovaultTrackLookup,
} from '@/schemas/db'
import { lockLibraryTrackWrites } from './album-library-tracks'
import {
  createTaskJob,
  insertPreparedTaskJob,
  type TaskJobContext,
  type TaskJobResult,
} from './jobs'
import { closeChangeBatch, openChangeBatch } from './library-changes'
import { providerOperation } from './manual-add'
import { createProviderRequest } from './provider-requests'
import { saveProviderResponseCapture } from './provider-response-history'
import {
  dueForSonovaultLookup,
  readSonovaultTargets,
  reportedSonovaultCredits,
  storedSonovaultResponse,
  sonovaultLookupInput,
  sonovaultTrackNameInput,
  writeSonovaultLookups,
  type SonovaultTarget,
} from './sonovault-track-lookup'
import {
  acceptSpotifyTrackSearchInTransaction,
  reconcileSpotifyTrackSearchInTransaction,
} from './spotify-track-search-acceptance'
import { spotifySearchArtistNames } from './spotify-track-search-evidence'
import { prepareSpotifyTrackSearch } from './spotify-track-search'
import { listTracksNeedingSpotifyMatch } from './track-match-diagnostics'

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
type Reader = Pick<typeof db, 'select'>

const PROVIDER = 'sonovault'
const INPUT_TYPE = 'track_name'
const MAX_TEXT = 500

const JobOptionsSchema = SonovaultTrackLookupParamsSchema.extend({
  inputType: z.literal(INPUT_TYPE),
})
const QueueInputSchema = z
  .object({
    trackIds: z.array(z.string().trim().min(1).max(200)).min(1).max(1000),
    batchId: z.string().min(1).max(200).optional(),
    confirmBroadRun: z.boolean().default(false),
  })
  .strict()
  .refine((input) => input.trackIds.length <= 5 || input.confirmBroadRun, {
    message: 'Confirm looking up more than five tracks',
    path: ['confirmBroadRun'],
  })
const StoredCandidateSchema = z.object({
  mediaItemId: z.string(),
  sonovaultTrackId: z.string(),
  status: z.enum(['pending', 'accepted', 'rejected']),
  acceptedBy: z.enum(['automatic', 'owner']).nullable(),
  input: z.string(),
  result: SonovaultResolveResultSchema,
  scrapeJobId: z.string().nullable(),
  responseId: z.string().nullable(),
  spotifyJobId: z.string().nullable(),
  foundAt: z.date(),
  decidedAt: z.date().nullable(),
})
type StoredCandidate = z.infer<typeof StoredCandidateSchema>

type NameTarget = SonovaultTarget & {
  artists: string[]
  item: { artist: string; title: string } | null
  candidates: { sonovaultTrackId: string; status: string }[]
}

const trimmed = (value: string) => value.trim().slice(0, MAX_TEXT).trimEnd()

/**
 * The artist and title a track is sent with: its first credited artist, and
 * its title without a Last.fm track number prefix.
 */
function nameItem(
  title: string,
  sourceLabel: string | null,
  artists: string[],
) {
  const numbered =
    sourceLabel === 'lastfm' ? parseTrackNumberPrefix(title.trim()) : undefined
  const artist = trimmed(artists[0] ?? '')
  const name = trimmed(numbered?.title ?? title)
  return artist && name ? { artist, title: name } : null
}

/** Library tracks with their artists, stage 1 lookup and candidates. */
async function readNameTargets(
  database: Reader,
  ids: string[],
): Promise<NameTarget[]> {
  if (!ids.length) return []
  const [targets, names, candidates] = await Promise.all([
    readSonovaultTargets(database, ids),
    database
      .select({
        id: mediaItem.id,
        sourceLabel: mediaItem.sourceLabel,
        artists: spotifySearchArtistNames(sql`${mediaItem.id}`),
      })
      .from(mediaItem)
      .where(inArray(mediaItem.id, ids)),
    database
      .select({
        mediaItemId: sonovaultTrackCandidate.mediaItemId,
        sonovaultTrackId: sonovaultTrackCandidate.sonovaultTrackId,
        status: sonovaultTrackCandidate.status,
      })
      .from(sonovaultTrackCandidate)
      .where(inArray(sonovaultTrackCandidate.mediaItemId, ids)),
  ])
  const byId = new Map(names.map((row) => [row.id, row]))
  return targets.map((target) => {
    const name = byId.get(target.id)
    const artists = name?.artists ?? []
    return {
      ...target,
      artists,
      item: nameItem(target.title, name?.sourceLabel ?? null, artists),
      candidates: candidates.filter((row) => row.mediaItemId === target.id),
    }
  })
}

/**
 * SONO-23: a track with neither a Spotify ID nor an ISRC, with an artist and
 * title, no candidate yet, and no lookup by artist and title in the last 30
 * days.
 */
function dueForNameLookup(
  target: NameTarget,
  now: Date,
  { running = false }: { running?: boolean } = {},
) {
  return (
    target.item !== null &&
    sonovaultLookupInput(target) === null &&
    // The running job holds its own tracks.
    (running || !target.active) &&
    !target.candidates.length &&
    dueForSonovaultLookup(target, INPUT_TYPE, false, now)
  )
}

type Decision = {
  target: NameTarget
  input: string
  result: SonovaultResolveResult & { track: SonovaultTrack }
  automatic: boolean
}

/** Prepared Spotify jobs for automatic acceptances, by library track. */
type SpotifySteps = Map<string, Record<string, JsonValue>>

/**
 * Prepares the Spotify job that takes an automatically accepted candidate's
 * Spotify ID, before the job's transaction. A track Spotify cannot be
 * searched for is left without one.
 */
async function prepareAutomaticSpotifySteps(
  userId: string | null,
  decisions: Decision[],
): Promise<SpotifySteps> {
  const steps: SpotifySteps = new Map()
  if (!userId) return steps
  for (const { target, result, automatic } of decisions) {
    const spotifyTrackId = sonovaultCandidateSpotifyId(result)
    if (!automatic || !spotifyTrackId) continue
    try {
      const prepared = await prepareSpotifyTrackSearch(userId, {
        trackId: target.id,
        spotifyTrackId,
        sonovaultTrackId: String(result.track.id),
      })
      steps.set(
        target.id,
        z.record(z.string(), JsonValueSchema).parse(prepared),
      )
    } catch (error) {
      if (!(error instanceof ServerError)) throw error
    }
  }
  return steps
}

type Written = {
  candidates: number
  automatic: number
  notFound: number
  skipped: number
  rejectedBefore: number
}

/**
 * Records a response by artist and title: misses as lookups not repeated
 * for 30 days, a result accepted automatically as stage 1 records it, and
 * every other result as a candidate for review. A result the owner rejected
 * is not offered again.
 */
async function writeNameLookups(
  tx: Transaction,
  input: {
    jobId: string
    userId: string | null
    sent: { target: NameTarget; input: string }[]
    results: SonovaultResolveResult[]
    spotifySteps: SpotifySteps
  },
): Promise<Written> {
  const written: Written = {
    candidates: 0,
    automatic: 0,
    notFound: 0,
    skipped: 0,
    rejectedBefore: 0,
  }
  const current = new Map(
    (
      await readNameTargets(
        tx,
        input.sent.map(({ target }) => target.id),
      )
    ).map((target) => [target.id, target]),
  )
  const misses: { target: SonovaultTarget; input: string }[] = []
  const missResults: SonovaultResolveResult[] = []
  const accepted: { target: SonovaultTarget; input: string }[] = []
  const acceptedResults: SonovaultResolveResult[] = []
  const rows: (typeof sonovaultTrackCandidate.$inferInsert)[] = []
  const steps: Record<string, JsonValue>[] = []
  const now = new Date()
  const response = await storedSonovaultResponse(tx, input.jobId)
  for (const [index, sent] of input.sent.entries()) {
    const result = input.results[index]
    const target = current.get(sent.target.id)
    if (!result || !target || result.status === 'skipped_no_credits') {
      written.skipped += 1
      continue
    }
    // Another job may have given the track an ID or a candidate meanwhile.
    if (
      sonovaultLookupInput(target) !== null ||
      target.candidates.some(({ status }) => status !== 'rejected')
    ) {
      written.skipped += 1
      continue
    }
    if (result.status !== 'matched' || !result.track) {
      written.notFound += 1
      misses.push({ target, input: sent.input })
      missResults.push(result)
      continue
    }
    const sonovaultTrackId = String(result.track.id)
    if (
      target.candidates.some(
        (candidate) => candidate.sonovaultTrackId === sonovaultTrackId,
      )
    ) {
      written.rejectedBefore += 1
      continue
    }
    const automatic = sonovaultCandidateIsAutomatic(
      {
        title: target.item?.title ?? target.title,
        artists: target.artists,
        durationSec: target.durationSec,
      },
      result.track,
    )
    const step = automatic ? input.spotifySteps.get(target.id) : undefined
    if (automatic) {
      written.automatic += 1
      accepted.push({ target, input: sent.input })
      acceptedResults.push(result)
      if (step) steps.push(step)
    } else written.candidates += 1
    rows.push({
      mediaItemId: target.id,
      sonovaultTrackId,
      status: automatic ? 'accepted' : 'pending',
      acceptedBy: automatic ? 'automatic' : null,
      input: sent.input,
      result: z.record(z.string(), JsonValueSchema).parse(result),
      scrapeJobId: input.jobId,
      responseId: response.id,
      spotifyJobId: null,
      foundAt: response.fetchedAt,
      decidedAt: automatic ? now : null,
    })
  }
  if (misses.length)
    await writeSonovaultLookups(tx, {
      jobId: input.jobId,
      inputType: INPUT_TYPE,
      sent: misses,
      results: missResults,
    })
  if (accepted.length)
    await writeSonovaultLookups(tx, {
      jobId: input.jobId,
      inputType: INPUT_TYPE,
      sent: accepted,
      results: acceptedResults,
      accepted: true,
    })
  if (rows.length)
    await tx.insert(sonovaultTrackCandidate).values(rows).onConflictDoNothing()
  // The Spotify ID goes through the Spotify track search's own rules.
  for (const step of steps) {
    const trackId = z.object({ trackId: z.string() }).parse(step).trackId
    if (!(await listTracksNeedingSpotifyMatch(tx, [trackId])).length) continue
    const jobId = await insertPreparedTaskJob(
      tx,
      SPOTIFY_TRACK_SEARCH_TASK,
      input.userId,
      step,
    )
    await tx
      .update(sonovaultTrackCandidate)
      .set({ spotifyJobId: jobId, updatedAt: now })
      .where(
        and(
          eq(sonovaultTrackCandidate.mediaItemId, trackId),
          eq(sonovaultTrackCandidate.status, 'accepted'),
        ),
      )
  }
  return written
}

type Lookup =
  | { kind: 'reserve'; remaining: number; reserve: number }
  | { kind: 'resolved'; payload: SonovaultBulkResolveResponse }

/** SONO-23: one bulk request of up to 100 tracks by artist and title. */
export async function runSonovaultTrackNameLookup(
  context: TaskJobContext,
  input: Record<string, unknown>,
): Promise<TaskJobResult> {
  try {
    const options = JobOptionsSchema.parse(input)
    await context.assertActive()
    const now = new Date()
    const sent = (await readNameTargets(db, options.trackIds)).flatMap(
      (target) =>
        target.item && dueForNameLookup(target, now, { running: true })
          ? [
              {
                target,
                item: target.item,
                input: sonovaultTrackNameInput(target.item),
              },
            ]
          : [],
    )
    if (!sent.length)
      return {
        outcome: 'complete',
        message: 'Nothing to look up: the tracks changed or were looked up.',
        noProviderRequests: true,
        options: { lookedUp: 0 },
      }
    const lookup = await providerOperation<Lookup>(
      PROVIDER,
      async ({ secrets }, plugin) => {
        const settings = sonovaultSettings(secrets)
        const report = await reportedSonovaultCredits(db, now)
        const remaining = report?.current
          ? report.remaining
          : settings.monthlyCredits
        if (remaining - sent.length < settings.creditReserve)
          return {
            kind: 'reserve',
            remaining,
            reserve: settings.creditReserve,
          }
        const recorder = createProviderResponseRecorder(
          (capture) =>
            saveProviderResponseCapture({
              jobId: context.jobId,
              provider: PROVIDER,
              attempt: 1,
              capture,
            }),
          providerResponseSecretValues({ apiKey: settings.apiKey }),
        )
        const payload = await resolveSonovaultTracks(
          createProviderRequest(
            sonovaultGatedPlugin(plugin, settings),
            context.assertActive,
            { beginResponseCapture: recorder('task') },
          ),
          settings.apiKey,
          INPUT_TYPE,
          sent.map(({ item }) => item),
        )
        recorder.assertStored()
        return { kind: 'resolved', payload }
      },
      context.assertActive,
      'looking up tracks by artist and title',
    )
    if (!(await context.isActive())) return { outcome: 'stopped' }
    if (lookup.kind === 'reserve')
      return {
        outcome: 'complete',
        message: `Not looked up: ${sent.length} credits would leave fewer than the ${lookup.reserve}-credit reserve (${lookup.remaining} left).`,
        noProviderRequests: true,
        options: { lookedUp: 0, creditReserveReached: true },
      }
    const { payload } = lookup
    const decisions = sent.flatMap(({ target, input: line }, index) => {
      const result = payload.results[index]
      return result?.status === 'matched' && result.track
        ? [
            {
              target,
              input: line,
              result: { ...result, track: result.track },
              automatic: sonovaultCandidateIsAutomatic(
                {
                  title: target.item?.title ?? target.title,
                  artists: target.artists,
                  durationSec: target.durationSec,
                },
                result.track,
              ),
            },
          ]
        : []
    })
    const spotifySteps = await prepareAutomaticSpotifySteps(
      context.requestedByUserId,
      decisions,
    )
    const count = (status: string) =>
      payload.results.filter((row) => row.status === status).length
    return {
      outcome: 'complete',
      message: [
        `Looked up ${sent.length} tracks by artist and title: ${count('matched')} found,`,
        `${count('not_found')} not found,`,
        `${count('skipped_no_credits')} skipped for credits.`,
        `${payload.credits_remaining} credits left.`,
      ].join(' '),
      options: {
        lookedUp: sent.length,
        creditsUsed: payload.credits_used,
        creditsRemaining: payload.credits_remaining,
        creditsReportedAt: new Date().toISOString(),
        ...(payload.partial ? { partial: true } : {}),
      },
      persist: async (tx) => {
        await lockLibraryTrackWrites(tx)
        const written = await writeNameLookups(tx, {
          jobId: context.jobId,
          userId: context.requestedByUserId,
          sent,
          results: payload.results,
          spotifySteps,
        })
        await tx
          .update(scrapeJob)
          .set({
            options: sql`${scrapeJob.options} || ${JSON.stringify(written)}::jsonb`,
          })
          .where(eq(scrapeJob.id, context.jobId))
      },
    }
  } catch (error) {
    if (!(await context.isActive())) return { outcome: 'stopped' }
    return { outcome: 'failed', error }
  }
}

/**
 * Queues lookups by artist and title for the selected tracks that are due
 * one, 100 to a job.
 */
export async function queueSonovaultTrackNameLookups(
  input: z.input<typeof QueueInputSchema>,
  userId: string | null,
) {
  const { trackIds, batchId = nanoid() } = QueueInputSchema.parse(input)
  const now = new Date()
  const due = (await readNameTargets(db, [...new Set(trackIds)]))
    .filter((target) => dueForNameLookup(target, now))
    .map(({ id }) => id)
  for (let start = 0; start < due.length; start += SONOVAULT_BULK_LIMIT)
    await createTaskJob(SONOVAULT_TRACK_LOOKUP_TASK, userId, {
      taskOptions: {
        trackIds: due.slice(start, start + SONOVAULT_BULK_LIMIT),
        inputType: INPUT_TYPE,
        refresh: false,
        batchId,
      },
    })
  const skipped = trackIds.length - due.length
  return EnrichmentResultSchema.parse({
    batchId,
    queued: due.length,
    skipped,
    warnings: skipped
      ? [
          'Tracks with a Spotify ID or ISRC, without an artist, with a Sonovault candidate, misses from the last 30 days and queued tracks were skipped.',
        ]
      : [],
  })
}

const PageSchema = z.array(
  z.object({ id: z.string(), scrobbles: z.number().int() }),
)

/** Library tracks due a lookup by artist and title, the most played first. */
export async function listSonovaultTrackNameLookupTargets(limit: number) {
  const size = z.number().int().min(1).max(50_000).parse(limit)
  const now = new Date()
  const chosen: string[] = []
  let after: { scrobbles: number; id: string } | null = null
  while (chosen.length < size) {
    const result = await db.execute(sql`
      select mi.id, lt.scrobble_count as scrobbles from media_item mi
      join library_track lt on lt.media_item_id = mi.id
      where mi.media_type = 'track'
        and mi.metadata->>'legacyHidden' is distinct from 'true'
        and coalesce(lt.spotify_track_id, '') !~ '^[0-9A-Za-z]{22}$'
        and lt.isrc is null
        and not exists (select 1 from provider_reference r
          where r.media_item_id = mi.id and r.reference_type = 'isrc')
        and not exists (select 1 from sonovault_track_candidate c
          where c.media_item_id = mi.id)
        ${after ? sql`and (lt.scrobble_count, mi.id) < (${after.scrobbles}, ${after.id})` : sql``}
      order by lt.scrobble_count desc, mi.id desc
      limit 500`)
    const rows = PageSchema.parse(result.rows)
    const last = rows.at(-1)
    if (!last) break
    after = last
    const due = new Set(
      (
        await readNameTargets(
          db,
          rows.map(({ id }) => id),
        )
      )
        .filter((target) => dueForNameLookup(target, now))
        .map(({ id }) => id),
    )
    for (const row of rows)
      if (due.has(row.id) && chosen.length < size) chosen.push(row.id)
  }
  return chosen
}

const CandidateColumns = {
  mediaItemId: sonovaultTrackCandidate.mediaItemId,
  sonovaultTrackId: sonovaultTrackCandidate.sonovaultTrackId,
  status: sonovaultTrackCandidate.status,
  acceptedBy: sonovaultTrackCandidate.acceptedBy,
  input: sonovaultTrackCandidate.input,
  result: sonovaultTrackCandidate.result,
  scrapeJobId: sonovaultTrackCandidate.scrapeJobId,
  responseId: sonovaultTrackCandidate.responseId,
  spotifyJobId: sonovaultTrackCandidate.spotifyJobId,
  foundAt: sonovaultTrackCandidate.foundAt,
  decidedAt: sonovaultTrackCandidate.decidedAt,
}

async function readCandidates(database: Reader, trackIds: string[]) {
  const rows = await database
    .select(CandidateColumns)
    .from(sonovaultTrackCandidate)
    .where(inArray(sonovaultTrackCandidate.mediaItemId, trackIds))
    .orderBy(
      desc(sonovaultTrackCandidate.foundAt),
      sonovaultTrackCandidate.sonovaultTrackId,
    )
  return rows.flatMap((row) => {
    const parsed = StoredCandidateSchema.safeParse(row)
    return parsed.success ? [parsed.data] : []
  })
}

function presentCandidate(row: StoredCandidate) {
  const { track } = row.result
  const link = sonovaultSpotifyLink(row.result)
  const release = track?.releases[0] ?? null
  return SonovaultTrackCandidateSchema.parse({
    sonovaultTrackId: row.sonovaultTrackId,
    title: track?.title ?? '',
    artists: track ? sonovaultCandidateArtists(track) : [],
    release: release?.title ?? null,
    releaseDate: release?.release_date ?? null,
    durationSec: track?.duration ?? null,
    isrc: validIsrc(track?.isrc ?? null),
    spotifyTrackId: sonovaultCandidateSpotifyId(row.result),
    spotifyUrl: link ? sonovaultLinkUrl(link) : null,
    status: row.status,
    acceptedBy: row.acceptedBy,
    foundAt: row.foundAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    jobId: row.scrapeJobId,
    spotifyJobId: row.spotifyJobId,
  })
}

/** Each track's candidates, latest lookup job by artist and title and miss. */
async function readReviews(
  database: Pick<typeof db, 'select' | 'selectDistinctOn'>,
  trackIds: string[],
) {
  const ids = [...new Set(trackIds)]
  const [candidates, jobs, misses] = await Promise.all([
    readCandidates(database, ids),
    database
      .selectDistinctOn([sql`t.id`], {
        trackId: sql<string>`t.id`,
        jobId: scrapeJob.id,
        status: scrapeJob.status,
        errorMessage: scrapeJob.errorMessage,
        createdAt: scrapeJob.createdAt,
        finishedAt: scrapeJob.finishedAt,
      })
      .from(scrapeJob)
      .innerJoin(
        sql`jsonb_array_elements_text(${scrapeJob.options}->'trackIds') as t(id)`,
        sql`true`,
      )
      .where(
        and(
          eq(scrapeJob.provider, PROVIDER),
          sql`${scrapeJob.options}->>'task' = ${SONOVAULT_TRACK_LOOKUP_TASK}`,
          sql`${scrapeJob.options}->>'inputType' = ${INPUT_TYPE}`,
          sql`t.id in ${ids}`,
        ),
      )
      .orderBy(sql`t.id`, desc(scrapeJob.createdAt), desc(scrapeJob.id)),
    database
      .select({ id: sonovaultTrackLookup.mediaItemId })
      .from(sonovaultTrackLookup)
      .where(
        and(
          inArray(sonovaultTrackLookup.mediaItemId, ids),
          eq(sonovaultTrackLookup.inputType, INPUT_TYPE),
          eq(sonovaultTrackLookup.status, 'not_found'),
        ),
      ),
  ])
  const jobById = new Map(jobs.map((job) => [job.trackId, job]))
  const missed = new Set(misses.map(({ id }) => id))
  return SonovaultCandidateStatusListSchema.parse({
    items: ids.map((trackId) => {
      const job = jobById.get(trackId)
      return SonovaultTrackCandidateReviewSchema.parse({
        trackId,
        job: job
          ? SonovaultTrackLookupJobSchema.parse({
              jobId: job.jobId,
              status: job.status,
              errorMessage: job.errorMessage,
              createdAt: job.createdAt.toISOString(),
              finishedAt: job.finishedAt?.toISOString() ?? null,
            })
          : null,
        notFound: missed.has(trackId),
        candidates: candidates
          .filter((row) => row.mediaItemId === trackId)
          .slice(0, 50)
          .map(presentCandidate),
      })
    }),
  })
}

export async function listSonovaultCandidateReviews(
  input: z.input<typeof SonovaultCandidateStatusInputSchema>,
) {
  return readReviews(
    db,
    SonovaultCandidateStatusInputSchema.parse(input).trackIds,
  )
}

async function readReview(
  database: Pick<typeof db, 'select' | 'selectDistinctOn'>,
  trackId: string,
) {
  const { items } = await readReviews(database, [trackId])
  const [review] = items
  if (!review) throw new Error('Missing Sonovault candidate review')
  return review
}

async function libraryTrackExists(database: Reader, trackId: string) {
  const [target] = await readSonovaultTargets(database, [trackId])
  if (!target)
    throw new ServerError({
      statusCode: 404,
      message: 'Library track not found.',
    })
  return target
}

export async function getSonovaultCandidateReview(trackId: string) {
  const { trackId: id } = SonovaultCandidateParamsSchema.parse({ trackId })
  await libraryTrackExists(db, id)
  return readReview(db, id)
}

async function pendingCandidate(
  tx: Transaction,
  trackId: string,
  sonovaultTrackId: string,
) {
  const [row] = await tx
    .select(CandidateColumns)
    .from(sonovaultTrackCandidate)
    .where(
      and(
        eq(sonovaultTrackCandidate.mediaItemId, trackId),
        eq(sonovaultTrackCandidate.sonovaultTrackId, sonovaultTrackId),
      ),
    )
    .for('update')
  const candidate = row ? StoredCandidateSchema.safeParse(row) : null
  if (!candidate?.success)
    throw new ServerError({
      statusCode: 404,
      message: 'Sonovault candidate not found.',
    })
  if (candidate.data.status !== 'pending')
    throw new ServerError({
      statusCode: 409,
      message: 'This Sonovault candidate was already reviewed.',
    })
  return candidate.data
}

/** SONO-24: the owner rejects a candidate; it is not offered again. */
export async function rejectSonovaultTrackCandidate(input: {
  trackId: string
  sonovaultTrackId: string
}) {
  const { trackId } = SonovaultCandidateParamsSchema.parse(input)
  const { sonovaultTrackId } = SonovaultCandidateDecisionInputSchema.parse({
    sonovaultTrackId: input.sonovaultTrackId,
  })
  return db.transaction(async (tx) => {
    await lockLibraryTrackWrites(tx)
    await libraryTrackExists(tx, trackId)
    await pendingCandidate(tx, trackId, sonovaultTrackId)
    await tx
      .update(sonovaultTrackCandidate)
      .set({ status: 'rejected', decidedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(sonovaultTrackCandidate.mediaItemId, trackId),
          eq(sonovaultTrackCandidate.sonovaultTrackId, sonovaultTrackId),
        ),
      )
    return readReview(tx, trackId)
  })
}

/** Gives a track the candidate's Sonovault references and ISRC (stage 1). */
async function applyCandidate(
  tx: Transaction,
  candidate: StoredCandidate,
  target: SonovaultTarget,
) {
  if (!candidate.scrapeJobId) return false
  await writeSonovaultLookups(tx, {
    jobId: candidate.scrapeJobId,
    inputType: INPUT_TYPE,
    sent: [{ target, input: candidate.input }],
    results: [candidate.result],
    accepted: true,
  })
  return true
}

/**
 * SONO-25: the owner accepts a candidate. The track gets its Sonovault
 * references and ISRC now; its Spotify ID is read from Spotify in a track
 * search job and accepted there, so Spotify ID uniqueness and duplicate
 * groups are handled as for a Spotify search match.
 */
export async function acceptSonovaultTrackCandidate(input: {
  trackId: string
  sonovaultTrackId: string
  userId: string
}) {
  const { trackId } = SonovaultCandidateParamsSchema.parse(input)
  const { sonovaultTrackId } = SonovaultCandidateDecisionInputSchema.parse({
    sonovaultTrackId: input.sonovaultTrackId,
  })
  const candidate = await db.transaction(async (tx) => {
    await lockLibraryTrackWrites(tx)
    const target = await libraryTrackExists(tx, trackId)
    const pending = await pendingCandidate(tx, trackId, sonovaultTrackId)
    if (!(await applyCandidate(tx, pending, target)))
      throw new ServerError({
        statusCode: 409,
        message:
          'The Sonovault response for this candidate is no longer stored. Look the track up again.',
      })
    await tx
      .update(sonovaultTrackCandidate)
      .set({
        status: 'accepted',
        acceptedBy: 'owner',
        decidedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(sonovaultTrackCandidate.mediaItemId, trackId),
          eq(sonovaultTrackCandidate.sonovaultTrackId, sonovaultTrackId),
        ),
      )
    return pending
  })
  const spotifyTrackId = sonovaultCandidateSpotifyId(candidate.result)
  let spotifyWarning: string | null = null
  if (
    spotifyTrackId &&
    (await listTracksNeedingSpotifyMatch(db, [trackId])).length
  ) {
    try {
      const job = await createTaskJob(SPOTIFY_TRACK_SEARCH_TASK, input.userId, {
        taskOptions: {
          trackId,
          spotifyTrackId,
          sonovaultTrackId,
          reviewOnly: true,
        },
        skipActive: true,
      })
      await db
        .update(sonovaultTrackCandidate)
        .set({ spotifyJobId: job.id, updatedAt: new Date() })
        .where(
          and(
            eq(sonovaultTrackCandidate.mediaItemId, trackId),
            eq(sonovaultTrackCandidate.sonovaultTrackId, sonovaultTrackId),
          ),
        )
    } catch (error) {
      if (!(error instanceof ServerError)) throw error
      spotifyWarning = `The Spotify track was not read: ${error.message}`
    }
  }
  return SonovaultCandidateAcceptResultSchema.parse({
    review: await readReview(db, trackId),
    spotifyWarning,
  })
}

/** Whether a Spotify job still has an accepted candidate to read. */
export async function sonovaultSpotifyStepIsCurrent(
  database: Reader,
  input: { trackId: string; sonovaultTrackId: string; spotifyTrackId: string },
) {
  const [row] = await database
    .select(CandidateColumns)
    .from(sonovaultTrackCandidate)
    .where(
      and(
        eq(sonovaultTrackCandidate.mediaItemId, input.trackId),
        eq(sonovaultTrackCandidate.sonovaultTrackId, input.sonovaultTrackId),
        eq(sonovaultTrackCandidate.status, 'accepted'),
      ),
    )
  const candidate = row ? StoredCandidateSchema.safeParse(row) : null
  return (
    candidate?.success === true &&
    sonovaultCandidateSpotifyId(candidate.data.result) === input.spotifyTrackId
  )
}

class SpotifyStepUnmatched extends Error {}

/**
 * The Spotify search's automatic rules for an automatic acceptance, the
 * owner's acceptance path otherwise. Returns the recording that kept the
 * track's names, or null.
 */
async function matchSpotifyStep(
  tx: Transaction,
  input: {
    trackId: string
    jobId: string
    userId: string
    spotifyTrackId: string
  },
  candidate: StoredCandidate,
) {
  if (candidate.acceptedBy !== 'automatic')
    return (
      await acceptSpotifyTrackSearchInTransaction(tx, {
        trackId: input.trackId,
        jobId: input.jobId,
        spotifyTrackId: input.spotifyTrackId,
        userId: input.userId,
      })
    ).targetId
  const batchId = await openChangeBatch(tx, 'spotify-search')
  const result = await reconcileSpotifyTrackSearchInTransaction(
    tx,
    { trackId: input.trackId, userId: input.userId, jobId: input.jobId },
    false,
    batchId,
  )
  await closeChangeBatch(tx, batchId)
  return result.status === 'matched' ? result.targetId : null
}

/**
 * The end of a Spotify job that read an accepted candidate's Spotify ID:
 * the Spotify search's automatic rules for an automatic acceptance, the
 * owner's acceptance path otherwise. A conflict leaves the Spotify result
 * for review in Sources. When the match moved the track's names to another
 * recording, that recording gets the candidate's Sonovault references.
 */
export async function completeSonovaultSpotifyStep(
  tx: Transaction,
  input: {
    trackId: string
    jobId: string
    userId: string
    sonovaultTrackId: string
    spotifyTrackId: string
  },
) {
  await lockLibraryTrackWrites(tx)
  const [row] = await tx
    .select(CandidateColumns)
    .from(sonovaultTrackCandidate)
    .where(
      and(
        eq(sonovaultTrackCandidate.mediaItemId, input.trackId),
        eq(sonovaultTrackCandidate.sonovaultTrackId, input.sonovaultTrackId),
        eq(sonovaultTrackCandidate.status, 'accepted'),
      ),
    )
  const parsed = row ? StoredCandidateSchema.safeParse(row) : null
  if (
    !parsed?.success ||
    sonovaultCandidateSpotifyId(parsed.data.result) !== input.spotifyTrackId
  )
    return
  const candidate = parsed.data
  let targetId: string | null = null
  try {
    targetId = await tx.transaction(async (savepoint) => {
      // Sonovault's references count as the track's own data and would stop
      // its names moving to a Spotify recording; they are written again on
      // the recording that keeps them. A failed match restores them.
      await savepoint
        .delete(providerReference)
        .where(
          and(
            eq(providerReference.mediaItemId, input.trackId),
            eq(providerReference.provider, PROVIDER),
          ),
        )
      const matched = await matchSpotifyStep(savepoint, input, candidate)
      if (!matched) throw new SpotifyStepUnmatched()
      return matched
    })
  } catch (error) {
    if (
      !(error instanceof ServerError || error instanceof SpotifyStepUnmatched)
    )
      throw error
  }
  if (!targetId) return
  const [target] = await readSonovaultTargets(tx, [targetId])
  // Another recording's exact lookup by Spotify ID or ISRC is kept.
  if (
    !target ||
    (targetId !== input.trackId &&
      target.lookup?.status === 'matched' &&
      target.lookup.inputType !== INPUT_TYPE)
  )
    return
  if (!(await applyCandidate(tx, candidate, target))) return
  if (targetId === input.trackId) return
  await tx
    .insert(sonovaultTrackCandidate)
    .values({
      mediaItemId: targetId,
      sonovaultTrackId: candidate.sonovaultTrackId,
      status: 'accepted',
      acceptedBy: candidate.acceptedBy,
      input: candidate.input,
      result: z.record(z.string(), JsonValueSchema).parse(candidate.result),
      scrapeJobId: candidate.scrapeJobId,
      responseId: candidate.responseId,
      spotifyJobId: input.jobId,
      foundAt: candidate.foundAt,
      decidedAt: candidate.decidedAt,
    })
    .onConflictDoNothing()
}
