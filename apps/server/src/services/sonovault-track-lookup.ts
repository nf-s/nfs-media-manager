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
  SONOVAULT_SIMILAR_LOOKUP_TASK,
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
  type SonovaultRecordInputType,
  type SonovaultReferenceMetadata,
  type SonovaultTrackLookupInput,
} from '@repo/schemas/sonovault'
import { SONOVAULT_ALBUM_LOOKUP_TASK } from '@repo/schemas/sonovault-album'
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
  SonovaultStoredRecordSchema,
  type SonovaultLink,
  type SonovaultReleaseTrack,
  type SonovaultResolveResult,
  type SonovaultTrack,
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
  sonovaultAlbumLookup,
  sonovaultTrackCandidate,
  sonovaultTrackLookup,
  spotifyCodeLookup,
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

export type SonovaultTarget = {
  id: string
  title: string
  durationSec: number | null
  spotifyTrackId: string | null
  isrc: string | null
  libraryIsrc: string | null
  lookup: {
    status: string
    inputType: string
    input: string
    responseId: string | null
    verified: boolean | null
    lookedUpAt: Date
    primaryIsrc: string | null
  } | null
  active: boolean
}

/** Visible library tracks with their identifiers, latest lookup and active job. */
export async function readSonovaultTargets(
  database: Reader,
  ids: string[],
): Promise<SonovaultTarget[]> {
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
      lookupInputType: sonovaultTrackLookup.inputType,
      lookupInput: sonovaultTrackLookup.input,
      lookupResponseId: sonovaultTrackLookup.responseId,
      lookupVerified: sonovaultTrackLookup.verified,
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
            inputType: row.lookupInputType ?? '',
            input: row.lookupInput ?? '',
            responseId: row.lookupResponseId,
            verified: row.lookupVerified,
            lookedUpAt: row.lookedUpAt,
            primaryIsrc: row.primaryIsrc,
          }
        : null,
    active: row.active,
  }))
}

/**
 * Whether a track is due a lookup: never looked up, a miss over 30 days old
 * or by another input type, or a refresh.
 */
export function dueForSonovaultLookup(
  target: SonovaultTarget,
  inputType: SonovaultLookupInputType,
  refresh: boolean,
  now: Date,
) {
  const { lookup } = target
  if (!lookup) return true
  if (lookup.status === 'not_found')
    return (
      lookup.inputType !== inputType || lookup.lookedUpAt < missRetryCutoff(now)
    )
  return refresh && lookup.lookedUpAt < refreshCutoff(now)
}

export async function prepareSonovaultTrackLookup(
  _userId: string | null,
  input: Record<string, unknown>,
) {
  const options = JobOptionsSchema.parse(input)
  const trackIds = [...new Set(options.trackIds)]
  const targets = await readSonovaultTargets(db, trackIds)
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

/**
 * The credits the latest job reported, with whether it is this calendar month
 * (UTC): from a track lookup or a similar-track lookup (SONO-26), as their
 * bulk response said, or from an album lookup, as that said or the previous
 * report less the releases it fetched.
 */
export async function reportedSonovaultCredits(database: Reader, now: Date) {
  const [latest] = await database
    .select({ options: scrapeJob.options })
    .from(scrapeJob)
    .where(
      and(
        eq(scrapeJob.provider, PROVIDER),
        sql`${scrapeJob.options}->>'task' in (${SONOVAULT_TRACK_LOOKUP_TASK}, ${SONOVAULT_SIMILAR_LOOKUP_TASK}, ${SONOVAULT_ALBUM_LOOKUP_TASK})`,
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
export async function storedSonovaultResponse(
  tx: Pick<typeof db, 'select'>,
  jobId: string,
) {
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

/** How an artist-and-title line is stored as a lookup's input. */
export const sonovaultTrackNameInput = (item: {
  artist: string
  title: string
}) => JSON.stringify({ artist: item.artist, title: item.title })

/** Whether a bulk response line answers what was sent. */
export const sameSonovaultInput = (
  inputType: SonovaultLookupInputType,
  sent: string,
  echoed: SonovaultResolveResult['input'],
) =>
  typeof echoed !== 'string'
    ? inputType === 'track_name' &&
      sonovaultTrackNameInput({
        artist: echoed.artist.trim(),
        title: echoed.title.trim(),
      }) === sent
    : inputType === 'isrc'
      ? validIsrc(echoed) === sent
      : echoed.trim() === sent

export type SonovaultRecordsWritten = {
  matched: number
  verified: number
  notFound: number
  skipped: number
  primaryIsrcs: number
  /** Verified records given an `isrc` reference. */
  isrcs: number
}
type Written = SonovaultRecordsWritten

/** What one response said about one library track. */
export type SonovaultRecordEntry = {
  trackId: string
  /** What the track was reached by: its ID, ISRC, artist and title, or release. */
  input: string
  /** Null for a line Sonovault skipped for lack of credits. */
  record: {
    track: SonovaultTrack | SonovaultReleaseTrack | null
    links: SonovaultLink[]
  } | null
  /** The owner or the stage 4 rule accepted the record as the library recording. */
  accepted?: boolean
  /**
   * Whether a verified record may fill an empty primary ISRC (SONO-07): a
   * lookup by Spotify ID, or a release track aligned on its duration.
   */
  fillsPrimaryIsrc: boolean
}

/**
 * Replaces each answered track's Sonovault references and lookup with what
 * one stored response says, for every stage that reads a track's record. A
 * track Sonovault skipped for lack of credits keeps what it had, and a
 * release never replaces a track's own lookup. Only Sonovault's own rows
 * change (SONO-06).
 */
export async function writeSonovaultRecords(
  tx: Transaction,
  input: {
    jobId: string
    inputType: SonovaultRecordInputType
    response: { id: string; fetchedAt: Date }
    entries: SonovaultRecordEntry[]
  },
): Promise<Written> {
  const { response } = input
  const fetchedAt = response.fetchedAt.toISOString()
  // Read again under the lock: another job may have changed the tracks.
  const current = new Map(
    (
      await readSonovaultTargets(
        tx,
        input.entries.map(({ trackId }) => trackId),
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
    isrcs: 0,
  }
  for (const entry of input.entries) {
    const sent = entry.input
    const target = current.get(entry.trackId)
    const ownLookup =
      target?.lookup?.status === 'matched' &&
      target.lookup.inputType !== 'release'
    if (
      !entry.record ||
      !target ||
      (input.inputType === 'release' && ownLookup)
    ) {
      written.skipped += 1
      continue
    }
    const record = entry.record.track
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
        record: null,
        scrapeJobId: input.jobId,
        responseId: response.id,
        lookedUpAt: response.fetchedAt,
      })
      continue
    }
    const verified =
      entry.accepted === true || verifySonovaultRecord(target, record)
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
    for (const link of entry.record.links)
      add(
        sonovaultLinkReferenceTypes[link.source],
        link.external_id.trim(),
        metadata(sonovaultLinkUrl(link)),
      )
    // An unverified record may be another version: its ISRC stays on the
    // Sonovault track reference and is not offered to other features.
    if (verified && recordIsrc) {
      written.isrcs += 1
      isrcs.push({
        mediaItemId: target.id,
        isrc: recordIsrc,
        provider: PROVIDER,
        source: {
          kind:
            input.inputType === 'release'
              ? SONOVAULT_ALBUM_LOOKUP_TASK
              : SONOVAULT_TRACK_LOOKUP_TASK,
          jobId: input.jobId,
          responseId: response.id,
        },
      })
    }
    // SONO-07: only an empty primary ISRC, or one Sonovault gave.
    const fills =
      entry.fillsPrimaryIsrc &&
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
      // The track's own record, so it is never requested again (SONO-05).
      record: SonovaultStoredRecordSchema.parse(
        input.inputType === 'release'
          ? { kind: 'release', releaseId: Number(sent), track: record }
          : { kind: 'resolve', track: record, links: entry.record.links },
      ),
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
        record: sql`excluded.record`,
        lookedUpAt: sql`excluded.looked_up_at`,
        updatedAt: new Date(),
      },
    })
  return written
}

/**
 * Checks a bulk response's lines against what was sent, then writes them.
 * `accepted` marks records the owner or the stage 4 rule accepted as the
 * library recording.
 */
export async function writeSonovaultLookups(
  tx: Transaction,
  input: {
    jobId: string
    inputType: SonovaultLookupInputType
    sent: { target: Pick<SonovaultTarget, 'id'>; input: string }[]
    results: SonovaultResolveResult[]
    accepted?: boolean
    /** The stored response; the job's latest when not given. */
    response?: { id: string; fetchedAt: Date }
  },
): Promise<Written> {
  input.sent.forEach(({ input: sent }, index) => {
    const result = input.results[index]
    if (!result || !sameSonovaultInput(input.inputType, sent, result.input))
      throw new Error('Sonovault answered the lines in a different order.')
  })
  return writeSonovaultRecords(tx, {
    jobId: input.jobId,
    inputType: input.inputType,
    response:
      input.response ?? (await storedSonovaultResponse(tx, input.jobId)),
    entries: input.sent.map(({ target, input: sent }, index) => {
      const result = input.results[index]
      return {
        trackId: target.id,
        input: sent,
        record:
          !result || result.status === 'skipped_no_credits'
            ? null
            : {
                track: result.status === 'matched' ? result.track : null,
                links: result.links,
              },
        ...(input.accepted ? { accepted: true } : {}),
        fillsPrimaryIsrc: input.inputType === 'spotify_id',
      }
    }),
  })
}

export async function runSonovaultTrackLookup(
  context: TaskJobContext,
  input: Record<string, unknown>,
): Promise<TaskJobResult> {
  try {
    const options = JobOptionsSchema.parse(input)
    await context.assertActive()
    const now = new Date()
    const sent = (await readSonovaultTargets(db, options.trackIds)).flatMap(
      (target) => {
        const lookup = sonovaultLookupInput(target)
        return lookup?.inputType === options.inputType &&
          dueForSonovaultLookup(target, lookup.inputType, options.refresh, now)
          ? [{ target, input: lookup.input }]
          : []
      },
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
        written = await writeSonovaultLookups(tx, {
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
  for (const target of await readSonovaultTargets(db, unique)) {
    const lookup = sonovaultLookupInput(target)
    if (
      !lookup ||
      target.active ||
      !dueForSonovaultLookup(target, lookup.inputType, refresh, now)
    )
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

/**
 * Queues every matched record older than 11 months again, 100 to a job.
 * Records read from an album's release are refreshed by its album lookup.
 */
export async function queueSonovaultTrackRefresh(
  userId: string | null,
  batchId = nanoid(),
) {
  const due = await db
    .select({ id: sonovaultTrackLookup.mediaItemId })
    .from(sonovaultTrackLookup)
    .where(
      and(
        eq(sonovaultTrackLookup.status, 'matched'),
        sql`${sonovaultTrackLookup.inputType} <> 'release'`,
        sql`${sonovaultTrackLookup.lookedUpAt} < ${refreshCutoff(new Date()).toISOString()}::timestamp`,
      ),
    )
    .orderBy(sonovaultTrackLookup.lookedUpAt, sonovaultTrackLookup.mediaItemId)
  // A similar track's Spotify match from Sonovault (SONO-26) is removed
  // rather than re-requested: the Similar tab looks it up again when it next
  // reads that item's similar tracks.
  await db
    .delete(spotifyCodeLookup)
    .where(
      and(
        eq(spotifyCodeLookup.source, PROVIDER),
        sql`${spotifyCodeLookup.searchedAt} < ${refreshCutoff(new Date()).toISOString()}::timestamp`,
      ),
    )
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
  const [target] = await readSonovaultTargets(db, [id])
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
  const report = await reportedSonovaultCredits(db, now)
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
 * (with the Spotify matches it gave similar tracks, SONO-26) and its stored
 * responses. Jobs keep their counts and messages only.
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
    await tx.delete(sonovaultTrackCandidate)
    const lookups = await tx
      .delete(sonovaultTrackLookup)
      .returning({ id: sonovaultTrackLookup.mediaItemId })
    const similarLookups = await tx
      .delete(spotifyCodeLookup)
      .where(eq(spotifyCodeLookup.source, PROVIDER))
      .returning({ code: spotifyCodeLookup.code })
    const albums = await tx
      .delete(sonovaultAlbumLookup)
      .returning({ id: sonovaultAlbumLookup.mediaItemId })
    const responses = await tx
      .delete(providerResponse)
      .where(eq(providerResponse.provider, PROVIDER))
      .returning({ id: providerResponse.id })
    return SonovaultRemovalSchema.parse({
      references: references.length,
      lookups: lookups.length + similarLookups.length + albums.length,
      primaryIsrcs: cleared.rowCount ?? 0,
      responses: responses.length,
      trackFacts,
    })
  })
}
