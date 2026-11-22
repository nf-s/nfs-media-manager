import { and, desc, eq, inArray, notInArray, sql } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import type { JsonValue } from '@repo/media-plugin-sdk'
import { EnrichmentResultSchema } from '@repo/schemas/job'
import {
  SONOVAULT_BULK_LIMIT,
  SONOVAULT_DEFAULT_CREDIT_RESERVE,
  SONOVAULT_DEFAULT_MONTHLY_CREDITS,
  SONOVAULT_MISS_RETRY_DAYS,
  SONOVAULT_REFRESH_MONTHS,
  SONOVAULT_TRACK_LOOKUP_TASK,
  SonovaultReferenceMetadataSchema,
  SonovaultReferenceTypeSchema,
  SonovaultRemovalSchema,
  SonovaultSummarySchema,
  SonovaultTrackLookupInputSchema,
  SonovaultTrackLookupJobSchema,
  SonovaultTrackLookupParamsSchema,
  SonovaultTrackParamsSchema,
  SonovaultTrackStateSchema,
  SonovaultTrackStatusInputSchema,
  SonovaultTrackStatusSchema,
  type SonovaultLookupInputType,
  type SonovaultReferenceMetadata,
  type SonovaultTrackLookupInput,
} from '@repo/schemas/sonovault'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import { validIsrc } from '@/lib/isrc'
import { createStableId } from '@/lib/media-utils'
import {
  createProviderResponseRecorder,
  providerResponseSecretValues,
} from '@/lib/provider-response-history'
import { resolveProviderSecrets } from '@/lib/provider-secrets'
import {
  resolveSonovaultTracks,
  sonovaultGatedPlugin,
  sonovaultLinkReferenceTypes,
  sonovaultLinkUrl,
  sonovaultSettings,
  type SonovaultBulkResolveResponse,
  type SonovaultResolveResult,
} from '@/lib/sonovault-api'
import { trackVersionKey } from '@/lib/track-matching'
import { getScrapePlugin } from '@/plugins/registry'
import {
  libraryTrack,
  mediaItem,
  providerReference,
  providerResponse,
  providerSecret,
  scrapeJob,
  sonovaultTrackLookup,
  trackFact,
} from '@/schemas/db'
import { lockLibraryTrackWrites } from './album-library-tracks'
import { createTaskJob, type TaskJobContext, type TaskJobResult } from './jobs'
import { providerOperation } from './manual-add'
import { createProviderRequest } from './provider-requests'
import { saveProviderResponseCapture } from './provider-response-history'
import { recordTrackIsrcs, sonovaultPrimaryIsrcSql } from './track-isrcs'
import {
  recordSonovaultTrackFacts,
  removeProviderTrackFacts,
  type SonovaultTrackFactsEntry,
} from './track-facts'

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
type Reader = Pick<typeof db, 'select'>

const PROVIDER = 'sonovault'
/** Durations within this many seconds agree (SONO-08). */
const DURATION_TOLERANCE_SEC = 5
const WRITE_BATCH = 500
const DAY_MS = 86_400_000
const spotifyTrackIdPattern = /^[0-9A-Za-z]{22}$/

const JobOptionsSchema = SonovaultTrackLookupParamsSchema.extend({
  refresh: z.boolean().default(false),
  trackTitle: z.string().max(500).optional(),
})
const CreditReportSchema = z.object({
  creditsRemaining: z.number().int().nonnegative(),
  creditsReportedAt: z.string().datetime(),
})

const missRetryCutoff = (now: Date) =>
  new Date(now.getTime() - SONOVAULT_MISS_RETRY_DAYS * DAY_MS)
function refreshCutoff(now: Date) {
  const cutoff = new Date(now)
  cutoff.setUTCMonth(cutoff.getUTCMonth() - SONOVAULT_REFRESH_MONTHS)
  return cutoff
}

/** How a track is sent: by Spotify ID where it has one, otherwise by ISRC (SONO-04). */
export function sonovaultLookupInput(track: {
  spotifyTrackId: string | null
  isrc: string | null
}): { inputType: SonovaultLookupInputType; input: string } | null {
  const spotifyTrackId = track.spotifyTrackId?.trim() ?? ''
  if (spotifyTrackIdPattern.test(spotifyTrackId))
    return { inputType: 'spotify_id', input: spotifyTrackId }
  const isrc = validIsrc(track.isrc)
  return isrc ? { inputType: 'isrc', input: isrc } : null
}

/**
 * SONO-08: the durations agree within five seconds where both are known, and
 * the titles agree once case, punctuation and how version text is written are
 * ignored.
 */
export function verifySonovaultRecord(
  library: { title: string; durationSec: number | null },
  record: { title: string; duration: number | null },
) {
  const durations =
    library.durationSec === null ||
    record.duration === null ||
    Math.abs(library.durationSec - record.duration) <= DURATION_TOLERANCE_SEC
  return (
    durations &&
    trackVersionKey(library.title) === trackVersionKey(record.title)
  )
}

type Target = {
  id: string
  title: string
  durationSec: number | null
  spotifyTrackId: string | null
  isrc: string | null
  libraryIsrc: string | null
  lookup: {
    status: string
    lookedUpAt: Date
    primaryIsrc: string | null
  } | null
  active: boolean
}

/** Visible library tracks with their identifiers, latest lookup and active job. */
async function readTargets(database: Reader, ids: string[]): Promise<Target[]> {
  if (!ids.length) return []
  const rows = await database
    .select({
      id: mediaItem.id,
      title: mediaItem.title,
      durationSec: sql<number | null>`coalesce(${libraryTrack.durationSec},
        (select t.duration_sec from track t
          where t.track_media_item_id = ${mediaItem.id} and t.duration_sec is not null
          order by t.created_at, t.id limit 1))`,
      spotifyTrackId: libraryTrack.spotifyTrackId,
      libraryIsrc: libraryTrack.isrc,
      referenceIsrc: sql<
        string | null
      >`(select r.external_id from provider_reference r
          where r.media_item_id = ${mediaItem.id} and r.reference_type = 'isrc'
            and r.provider <> ${PROVIDER}
          order by r.created_at, r.external_id limit 1)`,
      lookupStatus: sonovaultTrackLookup.status,
      lookedUpAt: sonovaultTrackLookup.lookedUpAt,
      // The primary ISRC only while it is still Sonovault's own.
      primaryIsrc: sql<string | null>`case when ${sonovaultPrimaryIsrcSql(
        sql`${mediaItem.id}`,
        sql`${libraryTrack.isrc}`,
      )} then ${sonovaultTrackLookup.primaryIsrc} end`,
      active: sql<boolean>`exists (select 1 from scrape_job j
          where j.provider = ${PROVIDER}
            and j.options->>'task' = ${SONOVAULT_TRACK_LOOKUP_TASK}
            and j.status in ('queued', 'running')
            and j.options->'trackIds' ? ${mediaItem.id})`,
    })
    .from(mediaItem)
    .innerJoin(libraryTrack, eq(libraryTrack.mediaItemId, mediaItem.id))
    .leftJoin(
      sonovaultTrackLookup,
      eq(sonovaultTrackLookup.mediaItemId, mediaItem.id),
    )
    .where(
      and(
        inArray(mediaItem.id, ids),
        eq(mediaItem.mediaType, 'track'),
        sql`${mediaItem.metadata}->>'legacyHidden' is distinct from 'true'`,
      ),
    )
  return rows.map((row) => ({
    id: row.id,
    title: row.title.trim(),
    durationSec: row.durationSec,
    spotifyTrackId: row.spotifyTrackId,
    libraryIsrc: validIsrc(row.libraryIsrc),
    isrc: validIsrc(row.libraryIsrc) ?? validIsrc(row.referenceIsrc),
    lookup:
      row.lookupStatus && row.lookedUpAt
        ? {
            status: row.lookupStatus,
            lookedUpAt: row.lookedUpAt,
            primaryIsrc: row.primaryIsrc,
          }
        : null,
    active: row.active,
  }))
}

/** Whether a track is due a lookup: never looked up, a miss over 30 days old, or a refresh. */
function dueForLookup(target: Target, refresh: boolean, now: Date) {
  const { lookup } = target
  if (!lookup) return true
  if (lookup.status === 'not_found')
    return lookup.lookedUpAt < missRetryCutoff(now)
  return refresh && lookup.lookedUpAt < refreshCutoff(now)
}

export async function prepareSonovaultTrackLookup(
  _userId: string | null,
  input: Record<string, unknown>,
) {
  const options = JobOptionsSchema.parse(input)
  const trackIds = [...new Set(options.trackIds)]
  const targets = await readTargets(db, trackIds)
  const first = targets.find(({ id }) => id === trackIds[0])
  return {
    trackIds,
    inputType: options.inputType,
    refresh: options.refresh,
    // Jobs for other tracks are separate jobs, not the same one queued again.
    groupKey: createStableId(
      SONOVAULT_TRACK_LOOKUP_TASK,
      JSON.stringify([options.inputType, [...trackIds].sort()]),
    ),
    ...(first ? { trackTitle: first.title.slice(0, 500) } : {}),
  }
}

/** The credits the latest lookup reported, this calendar month (UTC). */
async function reportedCredits(database: Reader, now: Date) {
  const [latest] = await database
    .select({ options: scrapeJob.options })
    .from(scrapeJob)
    .where(
      and(
        eq(scrapeJob.provider, PROVIDER),
        sql`${scrapeJob.options}->>'task' = ${SONOVAULT_TRACK_LOOKUP_TASK}`,
        sql`${scrapeJob.options} ? 'creditsReportedAt'`,
      ),
    )
    .orderBy(
      desc(sql`${scrapeJob.options}->>'creditsReportedAt'`),
      desc(scrapeJob.id),
    )
    .limit(1)
  const report = CreditReportSchema.safeParse(latest?.options)
  if (!report.success) return null
  const reportedAt = new Date(report.data.creditsReportedAt)
  return {
    remaining: report.data.creditsRemaining,
    reportedAt,
    current:
      reportedAt.getUTCFullYear() === now.getUTCFullYear() &&
      reportedAt.getUTCMonth() === now.getUTCMonth(),
  }
}

type Lookup =
  | { kind: 'reserve'; remaining: number; reserve: number }
  | { kind: 'resolved'; payload: SonovaultBulkResolveResponse }

/** The ID and time of the response this job stored for its bulk call. */
async function storedResponse(tx: Transaction, jobId: string) {
  const [row] = await tx
    .select({
      id: providerResponse.id,
      receivedAt: providerResponse.receivedAt,
    })
    .from(providerResponse)
    .where(
      and(
        eq(providerResponse.jobId, jobId),
        eq(providerResponse.provider, PROVIDER),
        eq(providerResponse.status, 200),
        eq(providerResponse.bodyState, 'captured'),
      ),
    )
    .orderBy(desc(providerResponse.ordinal))
    .limit(1)
  if (!row) throw new Error('The Sonovault response was not stored.')
  return { id: row.id, fetchedAt: row.receivedAt ?? new Date() }
}

const sameInput = (
  inputType: SonovaultLookupInputType,
  sent: string,
  echoed: string,
) =>
  inputType === 'isrc' ? validIsrc(echoed) === sent : echoed.trim() === sent

type Written = {
  matched: number
  verified: number
  notFound: number
  skipped: number
  primaryIsrcs: number
}

/**
 * Replaces each answered track's Sonovault references and lookup with what
 * this response says. A track Sonovault skipped for lack of credits keeps
 * what it had. Only Sonovault's own rows change (SONO-06).
 */
async function writeLookups(
  tx: Transaction,
  input: {
    jobId: string
    inputType: SonovaultLookupInputType
    sent: { target: Target; input: string }[]
    results: SonovaultResolveResult[]
  },
): Promise<Written> {
  const response = await storedResponse(tx, input.jobId)
  const fetchedAt = response.fetchedAt.toISOString()
  // Read again under the lock: another job may have changed the tracks.
  const current = new Map(
    (
      await readTargets(
        tx,
        input.sent.map(({ target }) => target.id),
      )
    ).map((target) => [target.id, target]),
  )
  const references: (typeof providerReference.$inferInsert)[] = []
  const lookups: (typeof sonovaultTrackLookup.$inferInsert)[] = []
  const isrcs: Parameters<typeof recordTrackIsrcs>[1] = []
  const facts: SonovaultTrackFactsEntry[] = []
  const primary: { id: string; isrc: string | null }[] = []
  const written: Written = {
    matched: 0,
    verified: 0,
    notFound: 0,
    skipped: 0,
    primaryIsrcs: 0,
  }
  input.sent.forEach(({ input: sent }, index) => {
    const result = input.results[index]
    if (!result || !sameInput(input.inputType, sent, result.input))
      throw new Error('Sonovault answered the lines in a different order.')
  })
  for (const [
    index,
    { target: sentTarget, input: sent },
  ] of input.sent.entries()) {
    const result = input.results[index]
    const target = current.get(sentTarget.id)
    if (!result || !target || result.status === 'skipped_no_credits') {
      written.skipped += 1
      continue
    }
    const record = result.status === 'matched' ? result.track : null
    const previousPrimary =
      target.lookup?.primaryIsrc &&
      target.libraryIsrc === target.lookup.primaryIsrc
        ? target.lookup.primaryIsrc
        : null
    if (!record) {
      written.notFound += 1
      if (previousPrimary) primary.push({ id: target.id, isrc: null })
      lookups.push({
        mediaItemId: target.id,
        inputType: input.inputType,
        input: sent,
        status: 'not_found',
        sonovaultTrackId: null,
        verified: null,
        primaryIsrc: null,
        scrapeJobId: input.jobId,
        responseId: response.id,
        lookedUpAt: response.fetchedAt,
      })
      continue
    }
    const verified = verifySonovaultRecord(target, record)
    // Tempo and key (SONO-13); an unverified record's are kept for details only.
    facts.push({
      mediaItemId: target.id,
      track: record,
      verified,
      responseId: response.id,
      fetchedAt: response.fetchedAt,
    })
    const recordIsrc = validIsrc(record.isrc)
    written.matched += 1
    if (verified) written.verified += 1
    const metadata = (url: string | null): Record<string, JsonValue> =>
      SonovaultReferenceMetadataSchema.parse({
        url,
        verified,
        fetchedAt,
        responseId: response.id,
        jobId: input.jobId,
        inputType: input.inputType,
      } satisfies SonovaultReferenceMetadata)
    const add = (
      referenceType: string,
      externalId: string,
      data: Record<string, JsonValue>,
    ) => {
      const id = createStableId(
        'pref',
        `${target.id}:${PROVIDER}:${referenceType}:${externalId}`,
      )
      if (references.some((row) => row.id === id)) return
      references.push({
        id,
        mediaItemId: target.id,
        provider: PROVIDER,
        referenceType,
        externalId,
        isPrimary: referenceType === 'sonovault-track',
        metadata: data,
      })
    }
    add('sonovault-track', String(record.id), {
      ...metadata(null),
      isrc: recordIsrc,
      title: record.title.slice(0, 2000),
      durationSec: record.duration,
    })
    for (const link of result.links)
      add(
        sonovaultLinkReferenceTypes[link.source],
        link.external_id.trim(),
        metadata(sonovaultLinkUrl(link)),
      )
    // An unverified record may be another version: its ISRC stays on the
    // Sonovault track reference and is not offered to other features.
    if (verified && recordIsrc)
      isrcs.push({
        mediaItemId: target.id,
        isrc: recordIsrc,
        provider: PROVIDER,
        source: {
          kind: SONOVAULT_TRACK_LOOKUP_TASK,
          jobId: input.jobId,
          responseId: response.id,
        },
      })
    // SONO-07: only an empty primary ISRC, or one Sonovault gave, and only
    // for a lookup by Spotify ID.
    const fills =
      input.inputType === 'spotify_id' &&
      verified &&
      recordIsrc !== null &&
      (target.libraryIsrc === null || previousPrimary !== null)
    if (fills) {
      if (target.libraryIsrc !== recordIsrc) {
        primary.push({ id: target.id, isrc: recordIsrc })
        written.primaryIsrcs += 1
      }
    } else if (previousPrimary) primary.push({ id: target.id, isrc: null })
    lookups.push({
      mediaItemId: target.id,
      inputType: input.inputType,
      input: sent,
      status: 'matched',
      sonovaultTrackId: String(record.id),
      verified,
      primaryIsrc: fills ? recordIsrc : null,
      scrapeJobId: input.jobId,
      responseId: response.id,
      lookedUpAt: response.fetchedAt,
    })
  }
  const answered = lookups.map(({ mediaItemId }) => mediaItemId)
  if (!answered.length) return written
  await tx
    .delete(providerReference)
    .where(
      and(
        inArray(providerReference.mediaItemId, answered),
        eq(providerReference.provider, PROVIDER),
      ),
    )
  for (let start = 0; start < references.length; start += WRITE_BATCH)
    await tx
      .insert(providerReference)
      .values(references.slice(start, start + WRITE_BATCH))
      .onConflictDoNothing()
  await recordTrackIsrcs(tx, isrcs, response.fetchedAt)
  // A track that is no longer found keeps no facts from an earlier record.
  await tx.delete(trackFact).where(
    and(
      inArray(trackFact.mediaItemId, answered),
      eq(trackFact.provider, PROVIDER),
      notInArray(
        trackFact.mediaItemId,
        facts.map(({ mediaItemId }) => mediaItemId),
      ),
    ),
  )
  await recordSonovaultTrackFacts(tx, facts)
  if (primary.length)
    await tx.execute(sql`
      update library_track lt
      set isrc = r.isrc, updated_at = now()
      from jsonb_to_recordset(${JSON.stringify(primary)}::jsonb) as r(id text, isrc text)
      where lt.media_item_id = r.id`)
  await tx
    .insert(sonovaultTrackLookup)
    .values(lookups)
    .onConflictDoUpdate({
      target: sonovaultTrackLookup.mediaItemId,
      set: {
        inputType: sql`excluded.input_type`,
        input: sql`excluded.input`,
        status: sql`excluded.status`,
        sonovaultTrackId: sql`excluded.sonovault_track_id`,
        verified: sql`excluded.verified`,
        primaryIsrc: sql`excluded.primary_isrc`,
        scrapeJobId: sql`excluded.scrape_job_id`,
        responseId: sql`excluded.response_id`,
        lookedUpAt: sql`excluded.looked_up_at`,
        updatedAt: new Date(),
      },
    })
  return written
}

export async function runSonovaultTrackLookup(
  context: TaskJobContext,
  input: Record<string, unknown>,
): Promise<TaskJobResult> {
  try {
    const options = JobOptionsSchema.parse(input)
    await context.assertActive()
    const now = new Date()
    const sent = (await readTargets(db, options.trackIds)).flatMap((target) => {
      const lookup = sonovaultLookupInput(target)
      return lookup?.inputType === options.inputType &&
        dueForLookup(target, options.refresh, now)
        ? [{ target, input: lookup.input }]
        : []
    })
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
        const report = await reportedCredits(db, now)
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
          // Only the key is secret; the plan settings are numbers that also
          // appear in response bodies and must not be scrubbed from them.
          providerResponseSecretValues({ apiKey: settings.apiKey }),
        )
        const payload = await resolveSonovaultTracks(
          createProviderRequest(
            sonovaultGatedPlugin(plugin, settings),
            context.assertActive,
            { beginResponseCapture: recorder('task') },
          ),
          settings.apiKey,
          options.inputType,
          sent.map(({ input: value }) => value),
        )
        recorder.assertStored()
        return { kind: 'resolved', payload }
      },
      context.assertActive,
      'looking up tracks',
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
    const creditOptions = {
      creditsUsed: payload.credits_used,
      creditsRemaining: payload.credits_remaining,
      creditsReportedAt: new Date().toISOString(),
    }
    let written: Written | undefined
    return {
      outcome: 'complete',
      message: [
        `Looked up ${sent.length} tracks: ${payload.results.filter((row) => row.status === 'matched').length} matched,`,
        `${payload.results.filter((row) => row.status === 'not_found').length} not found,`,
        `${payload.results.filter((row) => row.status === 'skipped_no_credits').length} skipped for credits.`,
        `${payload.credits_remaining} credits left.`,
      ].join(' '),
      options: {
        lookedUp: sent.length,
        ...creditOptions,
        ...(payload.partial ? { partial: true } : {}),
      },
      persist: async (tx) => {
        await lockLibraryTrackWrites(tx)
        written = await writeLookups(tx, {
          jobId: context.jobId,
          inputType: options.inputType,
          sent,
          results: payload.results,
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
 * Queues lookups for the selected tracks that are due one: one job per input
 * type, each a single bulk request of at most 100 lines.
 */
export async function queueSonovaultTrackLookups(
  input: SonovaultTrackLookupInput,
  userId: string | null,
) {
  const {
    trackIds,
    refresh,
    batchId = nanoid(),
  } = SonovaultTrackLookupInputSchema.parse(input)
  const unique = [...new Set(trackIds)]
  const now = new Date()
  const groups = new Map<SonovaultLookupInputType, string[]>()
  for (const target of await readTargets(db, unique)) {
    const lookup = sonovaultLookupInput(target)
    if (!lookup || target.active || !dueForLookup(target, refresh, now))
      continue
    groups.set(lookup.inputType, [
      ...(groups.get(lookup.inputType) ?? []),
      target.id,
    ])
  }
  let queued = 0
  for (const [inputType, ids] of groups) {
    await createTaskJob(SONOVAULT_TRACK_LOOKUP_TASK, userId, {
      taskOptions: { trackIds: ids, inputType, refresh, batchId },
    })
    queued += ids.length
  }
  const skipped = trackIds.length - queued
  return EnrichmentResultSchema.parse({
    batchId,
    queued,
    skipped,
    warnings: skipped
      ? [
          'Tracks without a Spotify ID or ISRC, tracks already looked up, misses from the last 30 days and queued tracks were skipped.',
        ]
      : [],
  })
}

/** Queues every matched record older than 11 months again, 100 to a job. */
export async function queueSonovaultRefresh(
  userId: string | null,
  batchId = nanoid(),
) {
  const due = await db
    .select({ id: sonovaultTrackLookup.mediaItemId })
    .from(sonovaultTrackLookup)
    .where(
      and(
        eq(sonovaultTrackLookup.status, 'matched'),
        sql`${sonovaultTrackLookup.lookedUpAt} < ${refreshCutoff(new Date()).toISOString()}::timestamp`,
      ),
    )
    .orderBy(sonovaultTrackLookup.lookedUpAt, sonovaultTrackLookup.mediaItemId)
  const result = { batchId, queued: 0, skipped: 0, warnings: [] as string[] }
  for (let start = 0; start < due.length; start += SONOVAULT_BULK_LIMIT) {
    const chunk = await queueSonovaultTrackLookups(
      {
        trackIds: due
          .slice(start, start + SONOVAULT_BULK_LIMIT)
          .map(({ id }) => id),
        refresh: true,
        batchId,
        confirmBroadRun: true,
      },
      userId,
    )
    result.queued += chunk.queued
    result.skipped += chunk.skipped
  }
  return EnrichmentResultSchema.parse(result)
}

const referenceTypes = new Set<string>([
  ...SonovaultReferenceTypeSchema.options,
  'isrc',
])

/** Each track's lookup, Sonovault references and latest lookup job. */
async function readStates(
  database: Pick<typeof db, 'select' | 'selectDistinctOn'>,
  trackIds: string[],
) {
  const ids = [...new Set(trackIds)]
  const [lookups, references, jobs] = await Promise.all([
    database
      .select()
      .from(sonovaultTrackLookup)
      .where(inArray(sonovaultTrackLookup.mediaItemId, ids)),
    database
      .select({
        trackId: providerReference.mediaItemId,
        referenceType: providerReference.referenceType,
        externalId: providerReference.externalId,
        metadata: providerReference.metadata,
      })
      .from(providerReference)
      .where(
        and(
          inArray(providerReference.mediaItemId, ids),
          eq(providerReference.provider, PROVIDER),
        ),
      )
      .orderBy(providerReference.referenceType, providerReference.externalId),
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
          sql`t.id in ${ids}`,
        ),
      )
      .orderBy(sql`t.id`, desc(scrapeJob.createdAt), desc(scrapeJob.id)),
  ])
  const lookupById = new Map(lookups.map((row) => [row.mediaItemId, row]))
  const jobById = new Map(jobs.map((row) => [row.trackId, row]))
  return SonovaultTrackStatusSchema.parse({
    items: ids.map((trackId) => {
      const lookup = lookupById.get(trackId)
      const job = jobById.get(trackId)
      return SonovaultTrackStateSchema.parse({
        trackId,
        lookup: lookup
          ? {
              status: lookup.status,
              inputType: lookup.inputType,
              sonovaultTrackId: lookup.sonovaultTrackId,
              verified: lookup.verified,
              primaryIsrc: lookup.primaryIsrc,
              lookedUpAt: lookup.lookedUpAt.toISOString(),
              retryAfter:
                lookup.status === 'not_found'
                  ? new Date(
                      lookup.lookedUpAt.getTime() +
                        SONOVAULT_MISS_RETRY_DAYS * DAY_MS,
                    ).toISOString()
                  : null,
            }
          : null,
        references: references.flatMap((row) => {
          if (row.trackId !== trackId || !referenceTypes.has(row.referenceType))
            return []
          const parsed = SonovaultReferenceMetadataSchema.partial().safeParse(
            row.metadata,
          )
          const metadata = parsed.success ? parsed.data : {}
          const fetchedAt =
            metadata.fetchedAt ??
            (typeof row.metadata?.['recordedAt'] === 'string'
              ? row.metadata['recordedAt']
              : null)
          if (!fetchedAt) return []
          return [
            {
              referenceType: row.referenceType,
              externalId: row.externalId,
              url: metadata.url ?? null,
              // ISRC references are written only for verified records.
              verified: metadata.verified ?? row.referenceType === 'isrc',
              fetchedAt,
            },
          ]
        }),
        job: job
          ? SonovaultTrackLookupJobSchema.parse({
              jobId: job.jobId,
              status: job.status,
              errorMessage: job.errorMessage,
              createdAt: job.createdAt.toISOString(),
              finishedAt: job.finishedAt?.toISOString() ?? null,
            })
          : null,
      })
    }),
  })
}

export async function getSonovaultTrackState(trackId: string) {
  const { trackId: id } = SonovaultTrackParamsSchema.parse({ trackId })
  const [target] = await readTargets(db, [id])
  if (!target)
    throw new ServerError({
      statusCode: 404,
      message: 'Library track not found.',
    })
  const { items } = await readStates(db, [id])
  const [state] = items
  if (!state) throw new Error('Missing Sonovault track state')
  return state
}

export async function listSonovaultTrackStates(
  input: z.input<typeof SonovaultTrackStatusInputSchema>,
) {
  return readStates(db, SonovaultTrackStatusInputSchema.parse(input).trackIds)
}

async function sonovaultSecrets() {
  const plugin = await getScrapePlugin(PROVIDER)
  if (!plugin) throw new Error('The Sonovault provider is not loaded')
  const rows = await db
    .select()
    .from(providerSecret)
    .where(eq(providerSecret.provider, PROVIDER))
  return resolveProviderSecrets(PROVIDER, rows, plugin.manifest.secrets)
}

/** Counts of what is stored, and the credits the latest response reported. */
export async function getSonovaultSummary() {
  const now = new Date()
  const secrets = await sonovaultSecrets()
  const settings = (() => {
    try {
      return sonovaultSettings(secrets)
    } catch {
      return null
    }
  })()
  const [lookups] = await db
    .select({
      matched: sql<number>`count(*) filter (where ${sonovaultTrackLookup.status} = 'matched')::int`,
      verified: sql<number>`count(*) filter (where ${sonovaultTrackLookup.verified})::int`,
      notFound: sql<number>`count(*) filter (where ${sonovaultTrackLookup.status} = 'not_found')::int`,
      dueForRefresh: sql<number>`count(*) filter (where ${sonovaultTrackLookup.status} = 'matched'
        and ${sonovaultTrackLookup.lookedUpAt} < ${refreshCutoff(now).toISOString()}::timestamp)::int`,
      primaryIsrcs: sql<number>`count(*) filter (where exists (
        select 1 from library_track lt
        where lt.media_item_id = sonovault_track_lookup.media_item_id
          and ${sonovaultPrimaryIsrcSql(sql`lt.media_item_id`, sql`lt.isrc`)}))::int`,
    })
    .from(sonovaultTrackLookup)
  const [references] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(providerReference)
    .where(eq(providerReference.provider, PROVIDER))
  const [responses] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(providerResponse)
    .where(eq(providerResponse.provider, PROVIDER))
  const report = await reportedCredits(db, now)
  return SonovaultSummarySchema.parse({
    lookups: {
      matched: lookups?.matched ?? 0,
      verified: lookups?.verified ?? 0,
      notFound: lookups?.notFound ?? 0,
      dueForRefresh: lookups?.dueForRefresh ?? 0,
    },
    references: references?.count ?? 0,
    primaryIsrcs: lookups?.primaryIsrcs ?? 0,
    responses: responses?.count ?? 0,
    credits: {
      remaining: report?.remaining ?? null,
      reportedAt: report?.reportedAt.toISOString() ?? null,
      monthlyCredits:
        settings?.monthlyCredits ?? SONOVAULT_DEFAULT_MONTHLY_CREDITS,
      reserve: settings?.creditReserve ?? SONOVAULT_DEFAULT_CREDIT_RESERVE,
    },
  })
}

/**
 * SONO-10: removes everything stored from Sonovault in one transaction of
 * set-based statements: primary ISRCs it gave, its references, its lookups
 * and its stored responses. Jobs keep their counts and messages only.
 */
export async function removeSonovaultData() {
  return db.transaction(async (tx) => {
    await lockLibraryTrackWrites(tx)
    const cleared = await tx.execute(sql`
      update library_track lt set isrc = null, updated_at = now()
      where lt.media_item_id in (select media_item_id from sonovault_track_lookup
          where primary_isrc is not null)
        and ${sonovaultPrimaryIsrcSql(sql`lt.media_item_id`, sql`lt.isrc`)}`)
    const references = await tx
      .delete(providerReference)
      .where(eq(providerReference.provider, PROVIDER))
      .returning({ id: providerReference.id })
    const trackFacts = await removeProviderTrackFacts(tx, PROVIDER)
    const lookups = await tx
      .delete(sonovaultTrackLookup)
      .returning({ id: sonovaultTrackLookup.mediaItemId })
    const responses = await tx
      .delete(providerResponse)
      .where(eq(providerResponse.provider, PROVIDER))
      .returning({ id: providerResponse.id })
    return SonovaultRemovalSchema.parse({
      references: references.length,
      lookups: lookups.length,
      primaryIsrcs: cleared.rowCount ?? 0,
      responses: responses.length,
      trackFacts,
    })
  })
}
