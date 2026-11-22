import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import type { JsonValue } from '@repo/media-plugin-sdk'
import { EnrichmentResultSchema } from '@repo/schemas/job'
import {
  SONOVAULT_MISS_RETRY_DAYS,
  SONOVAULT_REFRESH_MONTHS,
  SonovaultTrackLookupJobSchema,
} from '@repo/schemas/sonovault'
import {
  SONOVAULT_ALBUM_LOOKUP_TASK,
  SONOVAULT_ALBUM_MAX_CREDITS,
  SONOVAULT_RELEASE_CANDIDATE_LIMIT,
  SonovaultAlbumConfirmationSchema,
  SonovaultAlbumLookupInputSchema,
  SonovaultAlbumLookupParamsSchema,
  SonovaultAlbumMissSchema,
  SonovaultAlbumParamsSchema,
  SonovaultAlbumReferenceMetadataSchema,
  SonovaultAlbumReferenceTypeSchema,
  SonovaultAlbumReviewListSchema,
  SonovaultAlbumStateSchema,
  SonovaultAlbumSummarySchema,
  type SonovaultAlbumConfirmation,
  type SonovaultAlbumLookupInput,
  type SonovaultAlbumMiss,
  type SonovaultAlbumReferenceMetadata,
  type SonovaultAlbumReview,
} from '@repo/schemas/sonovault-album'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import { validIsrc } from '@/lib/isrc'
import { createStableId } from '@/lib/media-utils'
import {
  createProviderResponseRecorder,
  providerResponseSecretValues,
} from '@/lib/provider-response-history'
import {
  confirmSonovaultRelease,
  positionedReleaseTracks,
  sonovaultAlbumReferences,
  type SonovaultAlbumIdentity,
} from '@/lib/sonovault-album-match'
import {
  getSonovaultRelease,
  SonovaultBulkResolveResponseSchema,
  SonovaultStoredRecordSchema,
  sonovaultGatedPlugin,
  sonovaultSettings,
  type SonovaultRelease,
  type SonovaultTrack,
} from '@/lib/sonovault-api'
import {
  mediaItem,
  providerReference,
  providerResponse,
  scrapeJob,
  sonovaultAlbumLookup,
  sonovaultTrackLookup,
  track,
} from '@/schemas/db'
import { lockLibraryTrackWrites } from './album-library-tracks'
import { alignProviderAlbumTracks } from './album-track-provider-references'
import { createTaskJob, type TaskJobContext, type TaskJobResult } from './jobs'
import { providerOperation } from './manual-add'
import { createProviderRequest } from './provider-requests'
import { saveProviderResponseCapture } from './provider-response-history'
import {
  dueForSonovaultLookup,
  queueSonovaultTrackRefresh,
  readSonovaultTargets,
  reportedSonovaultCredits,
  sonovaultLookupInput,
  writeSonovaultRecords,
  type SonovaultTarget,
} from './sonovault-track-lookup'

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
type Reader = Pick<typeof db, 'select'>

const PROVIDER = 'sonovault'
const WRITE_BATCH = 500
const DAY_MS = 86_400_000

const JobOptionsSchema = SonovaultAlbumLookupParamsSchema.extend({
  albumTitle: z.string().max(500).optional(),
})

const missRetryCutoff = (now: Date) =>
  new Date(now.getTime() - SONOVAULT_MISS_RETRY_DAYS * DAY_MS)
function refreshCutoff(now: Date) {
  const cutoff = new Date(now)
  cutoff.setUTCMonth(cutoff.getUTCMonth() - SONOVAULT_REFRESH_MONTHS)
  return cutoff
}

type AlbumTrack = {
  trackMediaItemId: string
  position: number
  title: string
  durationSec: number | null
}

type AlbumTarget = {
  id: string
  title: string
  identity: SonovaultAlbumIdentity
  discogsMasters: string[]
  discogsReleases: string[]
  tracks: AlbumTrack[]
  lookup: { status: string; lookedUpAt: Date } | null
  active: boolean
}

/**
 * Visible library albums with the identifiers that confirm a release, their
 * Discogs matches, their tracks in order, their latest lookup and active job.
 */
async function readAlbumTargets(
  database: Reader,
  ids: string[],
): Promise<AlbumTarget[]> {
  if (!ids.length) return []
  const [albums, references, tracks] = await Promise.all([
    database
      .select({
        id: mediaItem.id,
        title: mediaItem.title,
        lookupStatus: sonovaultAlbumLookup.status,
        lookedUpAt: sonovaultAlbumLookup.lookedUpAt,
        active: sql<boolean>`exists (select 1 from scrape_job j
          where j.provider = ${PROVIDER}
            and j.options->>'task' = ${SONOVAULT_ALBUM_LOOKUP_TASK}
            and j.status in ('queued', 'running')
            and j.options->>'albumId' = ${mediaItem.id})`,
      })
      .from(mediaItem)
      .leftJoin(
        sonovaultAlbumLookup,
        eq(sonovaultAlbumLookup.mediaItemId, mediaItem.id),
      )
      .where(
        and(
          inArray(mediaItem.id, ids),
          eq(mediaItem.mediaType, 'album'),
          sql`${mediaItem.metadata}->>'legacyHidden' is distinct from 'true'`,
        ),
      ),
    database
      .select({
        albumId: providerReference.mediaItemId,
        provider: providerReference.provider,
        referenceType: providerReference.referenceType,
        externalId: providerReference.externalId,
      })
      .from(providerReference)
      .where(
        and(
          inArray(providerReference.mediaItemId, ids),
          sql`(${providerReference.provider}, ${providerReference.referenceType}) in
            (('spotify', 'album'), ('spotify', 'upc'), ('musicbrainz', 'release-group'),
             ('discogs', 'master'), ('discogs', 'release'))`,
        ),
      )
      .orderBy(providerReference.createdAt, providerReference.externalId),
    database
      .select({
        albumId: track.albumMediaItemId,
        trackMediaItemId: track.trackMediaItemId,
        position: track.position,
        title: track.title,
        durationSec: track.durationSec,
      })
      .from(track)
      .where(inArray(track.albumMediaItemId, ids))
      .orderBy(track.albumMediaItemId, asc(track.position)),
  ])
  return albums.map((album) => {
    const own = references.filter((row) => row.albumId === album.id)
    const of = (provider: string, referenceType: string) =>
      own
        .filter(
          (row) =>
            row.provider === provider && row.referenceType === referenceType,
        )
        .map((row) => row.externalId.trim())
        .filter(Boolean)
    const albumTracks = tracks
      .filter((row) => row.albumId === album.id)
      .map(({ trackMediaItemId, position, title, durationSec }) => ({
        trackMediaItemId,
        position,
        title,
        durationSec,
      }))
    return {
      id: album.id,
      title: album.title.trim(),
      identity: {
        spotifyAlbumId: of('spotify', 'album')[0] ?? null,
        upc: of('spotify', 'upc')[0] ?? null,
        musicbrainzReleaseGroups: of('musicbrainz', 'release-group'),
        trackCount: albumTracks.length,
      },
      discogsMasters: of('discogs', 'master'),
      discogsReleases: of('discogs', 'release'),
      tracks: albumTracks,
      lookup:
        album.lookupStatus && album.lookedUpAt
          ? { status: album.lookupStatus, lookedUpAt: album.lookedUpAt }
          : null,
      active: album.active,
    }
  })
}

/**
 * Whether an album is due a lookup: never looked up, a miss over 30 days old
 * or asked to be tried again, or a refresh.
 */
function dueForLookup(
  album: AlbumTarget,
  refresh: boolean,
  now: Date,
  retry = false,
) {
  const { lookup } = album
  if (!lookup) return true
  if (lookup.status === 'not_found')
    return retry || lookup.lookedUpAt < missRetryCutoff(now)
  return refresh && lookup.lookedUpAt < refreshCutoff(now)
}

const StoredBodySchema = z.object({
  state: z.literal('captured'),
  text: z.string(),
})

type StoredBulk = z.infer<typeof SonovaultBulkResolveResponseSchema> | null

/** A stored bulk response, parsed once however many album tracks it answers. */
async function storedBulk(
  database: Reader,
  cache: Map<string, StoredBulk>,
  responseId: string,
): Promise<StoredBulk> {
  if (cache.has(responseId)) return cache.get(responseId) ?? null
  const [row] = await database
    .select({ body: providerResponse.body })
    .from(providerResponse)
    .where(
      and(
        eq(providerResponse.id, responseId),
        eq(providerResponse.provider, PROVIDER),
      ),
    )
  const body = StoredBodySchema.safeParse(row?.body)
  let parsed: StoredBulk = null
  if (body.success)
    try {
      const payload = SonovaultBulkResolveResponseSchema.safeParse(
        JSON.parse(body.data.text),
      )
      parsed = payload.success ? payload.data : null
    } catch {
      parsed = null
    }
  cache.set(responseId, parsed)
  return parsed
}

/**
 * The record a track's own lookup stored, with the releases it is on: from
 * its lookup row, or, for a row stored before records were kept there, from
 * the response it names.
 */
async function storedRecord(
  database: Reader,
  cache: Map<string, StoredBulk>,
  target: SonovaultTarget,
  own: unknown,
): Promise<SonovaultTrack | null> {
  const lookup = target.lookup
  if (
    lookup?.status !== 'matched' ||
    (lookup.inputType !== 'spotify_id' && lookup.inputType !== 'isrc')
  )
    return null
  const kept = SonovaultStoredRecordSchema.safeParse(own)
  if (kept.success) return kept.data.kind === 'resolve' ? kept.data.track : null
  if (!lookup.responseId) return null
  const payload = await storedBulk(database, cache, lookup.responseId)
  const sent = lookup.input
  const line = payload?.results.find(({ input }) =>
    typeof input !== 'string'
      ? false
      : lookup.inputType === 'isrc'
        ? validIsrc(input) === sent
        : input.trim() === sent,
  )
  return line?.status === 'matched' ? line.track : null
}

type Candidates =
  | {
      kind: 'releases'
      /** The first album track with a record. */
      trackId: string
      /** Release IDs, most album tracks listing them first. */
      releases: number[]
    }
  /** Tracks that can be looked up have not been yet: nothing is decided. */
  | { kind: 'pending' }
  | { kind: 'miss'; miss: SonovaultAlbumMiss; trackId: string | null }

/**
 * SONO-18: the releases listed on the album's stored track records, ranked by
 * how many of its tracks list each, read from the track lookups' stored
 * responses with no request of its own. An album whose tracks can still be
 * looked up waits for those lookups.
 */
async function releaseCandidates(
  database: Reader,
  album: AlbumTarget,
  now: Date,
): Promise<Candidates> {
  const byId = new Map(
    (
      await readSonovaultTargets(
        database,
        album.tracks.map(({ trackMediaItemId }) => trackMediaItemId),
      )
    ).map((target) => [target.id, target]),
  )
  const ordered = album.tracks.flatMap(
    ({ trackMediaItemId }) => byId.get(trackMediaItemId) ?? [],
  )
  const kept = new Map(
    ordered.length
      ? (
          await database
            .select({
              id: sonovaultTrackLookup.mediaItemId,
              record: sonovaultTrackLookup.record,
            })
            .from(sonovaultTrackLookup)
            .where(
              inArray(
                sonovaultTrackLookup.mediaItemId,
                ordered.map(({ id }) => id),
              ),
            )
        ).map((row) => [row.id, row.record])
      : [],
  )
  const cache = new Map<string, StoredBulk>()
  const counts = new Map<number, number>()
  let first: string | null = null
  for (const target of ordered) {
    const record = await storedRecord(
      database,
      cache,
      target,
      kept.get(target.id) ?? null,
    )
    if (!record) continue
    first ??= target.id
    for (const id of new Set(record.releases.map((release) => release.id)))
      counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  if (first)
    return counts.size
      ? {
          kind: 'releases',
          trackId: first,
          // Map order keeps the first-listed release first among equals.
          releases: [...counts]
            .sort((left, right) => right[1] - left[1])
            .map(([id]) => id),
        }
      : { kind: 'miss', miss: 'no-release', trackId: first }
  const pending = ordered.some((target) => {
    const input = sonovaultLookupInput(target)
    return (
      input !== null &&
      (input.inputType === 'spotify_id' || input.inputType === 'isrc') &&
      (target.active ||
        dueForSonovaultLookup(target, input.inputType, false, now))
    )
  })
  if (pending) return { kind: 'pending' }
  return {
    kind: 'miss',
    miss: ordered.some((target) => target.lookup?.status === 'not_found')
      ? 'track-not-found'
      : 'no-track',
    trackId: null,
  }
}

export async function prepareSonovaultAlbumLookup(
  _userId: string | null,
  input: Record<string, unknown>,
) {
  const options = JobOptionsSchema.parse(input)
  const [album] = await readAlbumTargets(db, [options.albumId])
  return {
    albumId: options.albumId,
    refresh: options.refresh,
    retry: options.retry,
    groupKey: createStableId(SONOVAULT_ALBUM_LOOKUP_TASK, options.albumId),
    ...(album ? { albumTitle: album.title.slice(0, 500) } : {}),
  }
}

type Confirmed = {
  release: SonovaultRelease
  /** The release in the matched edition's numbering, when fetched. */
  numbered: SonovaultRelease | null
  confirmedBy: SonovaultAlbumConfirmation[]
  editionId: number | null
}

type Run =
  | { kind: 'reserve'; remaining: number; reserve: number }
  | {
      kind: 'done'
      releases: number
      confirmed: Confirmed | null
      remainingBefore: number
    }

/** The stored responses of this job, in request order. */
async function jobResponses(tx: Transaction, jobId: string) {
  return tx
    .select({
      id: providerResponse.id,
      requestUrl: providerResponse.requestUrl,
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
    .orderBy(asc(providerResponse.attempt), asc(providerResponse.ordinal))
}

/**
 * The stored response of one request, by its path: the first for a request
 * made once, the second for a release read again in an edition's numbering.
 * Stored URLs keep no query values, so the order tells the two apart.
 */
function responseFor(
  responses: Awaited<ReturnType<typeof jobResponses>>,
  path: string,
  occurrence: 1 | 2 = 1,
) {
  const row = responses.filter((entry) => {
    if (!entry.requestUrl) return false
    try {
      return new URL(entry.requestUrl).pathname === path
    } catch {
      return false
    }
  })[occurrence - 1]
  if (!row) throw new Error('The Sonovault response was not stored.')
  return { id: row.id, fetchedAt: row.receivedAt ?? new Date() }
}

type AlbumWritten = {
  confirmed: boolean
  aligned: number
  unaligned: number
  isrcs: number
  primaryIsrcs: number
  albumReferences: number
}

/**
 * Records what one album lookup found: the album's references and, for each
 * aligned track without its own record, its record through the track
 * lookup's own writer.
 */
async function writeAlbumLookup(
  tx: Transaction,
  input: {
    jobId: string
    albumId: string
    seedTrackId: string
    run: Extract<Run, { kind: 'done' }>
    creditsUsed: number
  },
): Promise<AlbumWritten> {
  const { jobId, run } = input
  const responses = await jobResponses(tx, jobId)
  const now = new Date()
  const [album] = await readAlbumTargets(tx, [input.albumId])
  const written: AlbumWritten = {
    confirmed: false,
    aligned: 0,
    unaligned: album?.tracks.length ?? 0,
    isrcs: 0,
    primaryIsrcs: 0,
    albumReferences: 0,
  }
  if (!album) return written
  // A new result replaces what an earlier lookup gave the album.
  await tx
    .delete(providerReference)
    .where(
      and(
        eq(providerReference.mediaItemId, album.id),
        eq(providerReference.provider, PROVIDER),
      ),
    )
  const { confirmed } = run
  const miss: SonovaultAlbumMiss | null = confirmed
    ? null
    : run.releases === 0
      ? 'no-release'
      : 'not-confirmed'
  let responseId: string | null = null
  if (confirmed) {
    const releaseResponse = responseFor(
      responses,
      `/v1/releases/${confirmed.release.id}`,
    )
    const numbered = confirmed.numbered ?? confirmed.release
    const numberedResponse = confirmed.numbered
      ? responseFor(responses, `/v1/releases/${confirmed.release.id}`, 2)
      : releaseResponse
    responseId = numberedResponse.id
    const aligned = alignProviderAlbumTracks(
      album.tracks,
      positionedReleaseTracks(numbered),
    )
    const records = new Map(
      numbered.tracks.map((entry) => [String(entry.id), entry]),
    )
    const tracks = await writeSonovaultRecords(tx, {
      jobId,
      inputType: 'release',
      response: numberedResponse,
      entries: aligned.flatMap(({ library, provider, alignment }) => {
        const record = provider.externalId
          ? records.get(provider.externalId)
          : undefined
        return record
          ? [
              {
                trackId: library.trackMediaItemId,
                input: String(confirmed.release.id),
                record: { track: record, links: [] },
                // As in TIDAL-03: a position paired on its title alone is
                // recorded but does not fill the primary ISRC.
                fillsPrimaryIsrc: alignment !== 'position-title',
              },
            ]
          : []
      }),
    })
    const fetchedAt = releaseResponse.fetchedAt.toISOString()
    const edition = (
      numbered.editions.length ? numbered : confirmed.release
    ).editions.find(({ id }) => id === confirmed.editionId)
    const rows = sonovaultAlbumReferences(
      confirmed.release,
      confirmed.editionId,
    ).map((row) => {
      const metadata: SonovaultAlbumReferenceMetadata = {
        url: row.url,
        fetchedAt,
        responseId: releaseResponse.id,
        jobId,
        editionId: row.editionId,
        matchedEdition: row.matchedEdition,
        ...(row.referenceType === 'sonovault-release'
          ? {
              confirmedBy: confirmed.confirmedBy,
              title: confirmed.release.title.slice(0, 2000),
              artist: confirmed.release.artist.name.slice(0, 2000),
              label: (edition?.label ?? confirmed.release.label)?.name ?? null,
              catalogNo:
                edition?.catalog_no ?? confirmed.release.catalog_no ?? null,
              editionId: confirmed.editionId,
            }
          : {}),
      }
      const data: Record<string, JsonValue> =
        SonovaultAlbumReferenceMetadataSchema.parse(metadata)
      return {
        id: createStableId(
          'pref',
          `${album.id}:${PROVIDER}:${row.referenceType}:${row.externalId}`,
        ),
        mediaItemId: album.id,
        provider: PROVIDER,
        referenceType: row.referenceType,
        externalId: row.externalId,
        isPrimary: row.referenceType === 'sonovault-release',
        metadata: data,
      }
    })
    for (let start = 0; start < rows.length; start += WRITE_BATCH)
      await tx
        .insert(providerReference)
        .values(rows.slice(start, start + WRITE_BATCH))
        .onConflictDoNothing()
    Object.assign(written, {
      confirmed: true,
      aligned: aligned.length,
      unaligned: album.tracks.length - aligned.length,
      isrcs: tracks.isrcs,
      primaryIsrcs: tracks.primaryIsrcs,
      albumReferences: rows.length,
    })
  } else if (run.releases) {
    // The last release fetched, kept as the evidence for the miss.
    responseId = responses.at(-1)?.id ?? null
  }
  const row = {
    mediaItemId: album.id,
    status: confirmed ? 'confirmed' : 'not_found',
    miss,
    releaseId: confirmed ? String(confirmed.release.id) : null,
    editionId:
      confirmed && confirmed.editionId !== null
        ? String(confirmed.editionId)
        : null,
    confirmedBy: confirmed?.confirmedBy ?? [],
    seedTrackId: input.seedTrackId,
    aligned: written.aligned,
    unaligned: written.unaligned,
    isrcs: written.isrcs,
    creditsUsed: input.creditsUsed,
    scrapeJobId: jobId,
    responseId,
    lookedUpAt: now,
  }
  await tx
    .insert(sonovaultAlbumLookup)
    .values(row)
    .onConflictDoUpdate({
      target: sonovaultAlbumLookup.mediaItemId,
      set: { ...row, updatedAt: now },
    })
  return written
}

/** Records a miss that needed no request: the album has no track to ask about. */
async function writeAlbumMiss(
  tx: Transaction,
  albumId: string,
  jobId: string,
  miss: SonovaultAlbumMiss,
  seedTrackId: string | null,
) {
  const now = new Date()
  await tx
    .delete(providerReference)
    .where(
      and(
        eq(providerReference.mediaItemId, albumId),
        eq(providerReference.provider, PROVIDER),
      ),
    )
  const row = {
    mediaItemId: albumId,
    status: 'not_found',
    miss,
    releaseId: null,
    editionId: null,
    confirmedBy: [],
    seedTrackId,
    aligned: 0,
    unaligned: 0,
    isrcs: 0,
    creditsUsed: 0,
    scrapeJobId: jobId,
    responseId: null,
    lookedUpAt: now,
  }
  await tx
    .insert(sonovaultAlbumLookup)
    .values(row)
    .onConflictDoUpdate({
      target: sonovaultAlbumLookup.mediaItemId,
      set: { ...row, updatedAt: now },
    })
}

const missMessages: Record<SonovaultAlbumMiss, string> = {
  'no-track':
    'Not looked up: no track of the album has a Spotify ID, an ISRC or a Sonovault record.',
  'track-not-found': 'Not found: no track of the album is on Sonovault.',
  'no-release':
    'Not found: the album’s Sonovault track records list no release.',
  'not-confirmed':
    'Not found: no candidate release carries the album’s Spotify album ID, UPC or MusicBrainz release group.',
}

export async function runSonovaultAlbumLookup(
  context: TaskJobContext,
  input: Record<string, unknown>,
): Promise<TaskJobResult> {
  try {
    const options = JobOptionsSchema.parse(input)
    await context.assertActive()
    const now = new Date()
    const [album] = await readAlbumTargets(db, [options.albumId])
    if (!album || !dueForLookup(album, options.refresh, now, options.retry))
      return {
        outcome: 'complete',
        message: 'Nothing to look up: the album changed or was looked up.',
        noProviderRequests: true,
        options: { creditsUsed: 0 },
      }
    const candidates = await releaseCandidates(db, album, now)
    if (candidates.kind === 'pending')
      return {
        outcome: 'complete',
        message:
          'Not looked up yet: look up the album’s tracks first; the album stays due.',
        noProviderRequests: true,
        options: { creditsUsed: 0, tracksPending: true },
      }
    if (candidates.kind === 'miss') {
      const { miss, trackId } = candidates
      return {
        outcome: 'complete',
        message: missMessages[miss],
        noProviderRequests: true,
        options: { creditsUsed: 0, miss },
        persist: (tx) =>
          writeAlbumMiss(tx, album.id, context.jobId, miss, trackId),
      }
    }
    const run = await providerOperation<Run>(
      PROVIDER,
      async ({ secrets }, plugin) => {
        const settings = sonovaultSettings(secrets)
        const report = await reportedSonovaultCredits(db, now)
        const remaining = report?.current
          ? report.remaining
          : settings.monthlyCredits
        if (remaining - SONOVAULT_ALBUM_MAX_CREDITS < settings.creditReserve)
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
        const request = createProviderRequest(
          sonovaultGatedPlugin(plugin, settings),
          context.assertActive,
          { beginResponseCapture: recorder('task') },
        )
        let releases = 0
        let confirmed: Confirmed | null = null
        for (const candidate of candidates.releases.slice(
          0,
          SONOVAULT_RELEASE_CANDIDATE_LIMIT,
        )) {
          const release = await getSonovaultRelease(
            request,
            settings.apiKey,
            candidate,
          )
          releases += 1
          const confirmation = confirmSonovaultRelease(release, album.identity)
          if (!confirmation) continue
          const editionId = confirmation.edition?.id ?? null
          confirmed = {
            release,
            numbered:
              editionId !== null && release.edition !== editionId
                ? await getSonovaultRelease(
                    request,
                    settings.apiKey,
                    release.id,
                    editionId,
                  )
                : null,
            confirmedBy: confirmation.confirmedBy,
            editionId,
          }
          break
        }
        recorder.assertStored()
        return { kind: 'done', releases, confirmed, remainingBefore: remaining }
      },
      context.assertActive,
      'looking up albums',
    )
    if (!(await context.isActive())) return { outcome: 'stopped' }
    if (run.kind === 'reserve')
      return {
        outcome: 'complete',
        message: `Not looked up: up to ${SONOVAULT_ALBUM_MAX_CREDITS} credits would leave fewer than the ${run.reserve}-credit reserve (${run.remaining} left).`,
        noProviderRequests: true,
        options: { creditsUsed: 0, creditReserveReached: true },
      }
    const creditsUsed = run.releases + (run.confirmed?.numbered ? 1 : 0)
    const creditOptions = {
      creditsUsed,
      // Release fetches report no credits: the last report less those fetched.
      creditsRemaining: Math.max(0, run.remainingBefore - creditsUsed),
      creditsReportedAt: new Date().toISOString(),
    }
    const confirmedBy = run.confirmed?.confirmedBy ?? []
    const miss: SonovaultAlbumMiss = run.releases
      ? 'not-confirmed'
      : 'no-release'
    let written: AlbumWritten | undefined
    return {
      outcome: 'complete',
      message: run.confirmed
        ? `Confirmed as Sonovault release ${run.confirmed.release.id} by ${confirmedBy.join(', ')}. ${creditsUsed} credits used.`
        : `${missMessages[miss]} ${creditsUsed} credits used.`,
      options: {
        ...creditOptions,
        releasesFetched: creditsUsed,
        releaseCandidates: candidates.releases.length,
        ...(run.confirmed
          ? {
              releaseId: String(run.confirmed.release.id),
              confirmedBy:
                SonovaultAlbumConfirmationSchema.array().parse(confirmedBy),
            }
          : { miss }),
      },
      persist: async (tx) => {
        await lockLibraryTrackWrites(tx)
        written = await writeAlbumLookup(tx, {
          jobId: context.jobId,
          albumId: album.id,
          seedTrackId: candidates.trackId,
          run,
          creditsUsed,
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

/** Queues one lookup for each selected album that is due one. */
export async function queueSonovaultAlbumLookups(
  input: SonovaultAlbumLookupInput,
  userId: string | null,
) {
  const {
    albumIds,
    refresh,
    retry,
    batchId = nanoid(),
  } = SonovaultAlbumLookupInputSchema.parse(input)
  const unique = [...new Set(albumIds)]
  const now = new Date()
  let queued = 0
  for (const album of await readAlbumTargets(db, unique)) {
    if (album.active || !album.tracks.length) continue
    if (!dueForLookup(album, refresh, now, retry)) continue
    await createTaskJob(SONOVAULT_ALBUM_LOOKUP_TASK, userId, {
      taskOptions: { albumId: album.id, refresh, retry, batchId },
    })
    queued += 1
  }
  const skipped = albumIds.length - queued
  return EnrichmentResultSchema.parse({
    batchId,
    queued,
    skipped,
    warnings: skipped
      ? [
          'Albums without tracks, albums already looked up, misses from the last 30 days and queued albums were skipped.',
        ]
      : [],
  })
}

/** Queues every album lookup older than 11 months again. */
async function queueSonovaultAlbumRefresh(
  userId: string | null,
  batchId: string,
) {
  const due = await db
    .select({ id: sonovaultAlbumLookup.mediaItemId })
    .from(sonovaultAlbumLookup)
    .where(
      and(
        eq(sonovaultAlbumLookup.status, 'confirmed'),
        sql`${sonovaultAlbumLookup.lookedUpAt} < ${refreshCutoff(new Date()).toISOString()}::timestamp`,
      ),
    )
    .orderBy(sonovaultAlbumLookup.lookedUpAt, sonovaultAlbumLookup.mediaItemId)
  const result = { batchId, queued: 0, skipped: 0, warnings: [] as string[] }
  for (let start = 0; start < due.length; start += 100) {
    const chunk = await queueSonovaultAlbumLookups(
      {
        albumIds: due.slice(start, start + 100).map(({ id }) => id),
        refresh: true,
        batchId,
        confirmBroadRun: true,
      },
      userId,
    )
    result.queued += chunk.queued
    result.skipped += chunk.skipped
  }
  return result
}

/**
 * SONO-10: queues every track record and album lookup older than 11 months
 * again. Track records read from a release are refreshed with their album.
 */
export async function queueSonovaultRefresh(
  userId: string | null,
  batchId = nanoid(),
) {
  const tracks = await queueSonovaultTrackRefresh(userId, batchId)
  const albums = await queueSonovaultAlbumRefresh(userId, batchId)
  return EnrichmentResultSchema.parse({
    batchId,
    queued: tracks.queued + albums.queued,
    skipped: tracks.skipped + albums.skipped,
    warnings: tracks.warnings,
  })
}

const albumReferenceTypes = new Set<string>(
  SonovaultAlbumReferenceTypeSchema.options,
)

type StoredAlbumReference = {
  referenceType: string
  externalId: string
  metadata: Record<string, JsonValue> | null
}

/**
 * SONO-22: each Discogs master or MusicBrainz release group of the confirmed
 * release that differs from the album's own, and, where the album has no
 * Discogs or MusicBrainz match, the release's ID as a candidate. The matched
 * edition's ID is offered first.
 */
export function sonovaultAlbumReview(
  album: {
    discogsMasters: readonly string[]
    discogsReleases: readonly string[]
    musicbrainzReleaseGroups: readonly string[]
  },
  references: readonly StoredAlbumReference[],
): SonovaultAlbumReview[] {
  const ofType = (referenceType: string) =>
    references
      .filter((row) => row.referenceType === referenceType)
      .map((row) => ({
        externalId: row.externalId,
        url:
          typeof row.metadata?.['url'] === 'string'
            ? row.metadata['url']
            : null,
        matched: row.metadata?.['matchedEdition'] === true,
      }))
      .sort((left, right) => Number(right.matched) - Number(left.matched))
  const review: SonovaultAlbumReview[] = []
  const compare = (
    provider: SonovaultAlbumReview['provider'],
    referenceType: SonovaultAlbumReview['referenceType'],
    stored: readonly string[],
    offered: ReturnType<typeof ofType>,
    hasMatch: boolean,
  ) => {
    const [first] = offered
    if (!first) return
    const same = (value: string) =>
      offered.some(
        ({ externalId }) => externalId.toLowerCase() === value.toLowerCase(),
      )
    if (!hasMatch)
      review.push({
        provider,
        referenceType,
        stored: null,
        sonovault: first.externalId,
        url: first.url,
      })
    else if (stored.length && !stored.some(same))
      review.push({
        provider,
        referenceType,
        stored: stored[0] ?? null,
        sonovault: first.externalId,
        url: first.url,
      })
  }
  const discogsMatch =
    album.discogsMasters.length > 0 || album.discogsReleases.length > 0
  const masters = ofType('discogs-master')
  compare('discogs', 'master', album.discogsMasters, masters, discogsMatch)
  // With no master on the release, its Discogs release is offered instead.
  if (!discogsMatch && !masters.length)
    compare('discogs', 'release', [], ofType('discogs-release'), false)
  compare(
    'musicbrainz',
    'release-group',
    album.musicbrainzReleaseGroups,
    ofType('musicbrainz-release-group'),
    album.musicbrainzReleaseGroups.length > 0,
  )
  return review
}

async function readAlbumReferences(database: Reader, albumIds: string[]) {
  if (!albumIds.length) return []
  return database
    .select({
      albumId: providerReference.mediaItemId,
      referenceType: providerReference.referenceType,
      externalId: providerReference.externalId,
      metadata: providerReference.metadata,
    })
    .from(providerReference)
    .where(
      and(
        inArray(providerReference.mediaItemId, albumIds),
        eq(providerReference.provider, PROVIDER),
      ),
    )
    .orderBy(providerReference.referenceType, providerReference.externalId)
}

/** The album's lookup, references, review entries and latest job. */
export async function getSonovaultAlbumState(albumId: string) {
  const { albumId: id } = SonovaultAlbumParamsSchema.parse({ albumId })
  const [album] = await readAlbumTargets(db, [id])
  if (!album)
    throw new ServerError({ statusCode: 404, message: 'Album not found.' })
  const [[lookup], references, [job], seed] = await Promise.all([
    db
      .select()
      .from(sonovaultAlbumLookup)
      .where(eq(sonovaultAlbumLookup.mediaItemId, id)),
    readAlbumReferences(db, [id]),
    db
      .select({
        jobId: scrapeJob.id,
        status: scrapeJob.status,
        errorMessage: scrapeJob.errorMessage,
        createdAt: scrapeJob.createdAt,
        finishedAt: scrapeJob.finishedAt,
      })
      .from(scrapeJob)
      .where(
        and(
          eq(scrapeJob.provider, PROVIDER),
          sql`${scrapeJob.options}->>'task' = ${SONOVAULT_ALBUM_LOOKUP_TASK}`,
          sql`${scrapeJob.options}->>'albumId' = ${id}`,
        ),
      )
      .orderBy(desc(scrapeJob.createdAt), desc(scrapeJob.id))
      .limit(1),
    album.tracks.length
      ? readSonovaultTargets(
          db,
          album.tracks.map(({ trackMediaItemId }) => trackMediaItemId),
        )
      : Promise.resolve([]),
  ])
  const confirmedBy = SonovaultAlbumConfirmationSchema.array().safeParse(
    lookup?.confirmedBy,
  )
  const miss = SonovaultAlbumMissSchema.nullable().safeParse(
    lookup?.miss ?? null,
  )
  return SonovaultAlbumStateSchema.parse({
    albumId: id,
    lookup: lookup
      ? {
          status: lookup.status,
          miss: miss.success ? miss.data : null,
          releaseId: lookup.releaseId,
          editionId: lookup.editionId,
          confirmedBy: confirmedBy.success ? confirmedBy.data : [],
          aligned: lookup.aligned,
          unaligned: lookup.unaligned,
          isrcs: lookup.isrcs,
          creditsUsed: lookup.creditsUsed,
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
    canLookUp: seed.some(
      (target) =>
        sonovaultLookupInput(target) !== null ||
        target.lookup?.status === 'matched',
    ),
    references: references.flatMap((row) => {
      if (!albumReferenceTypes.has(row.referenceType)) return []
      const metadata = SonovaultAlbumReferenceMetadataSchema.safeParse(
        row.metadata,
      )
      if (!metadata.success) return []
      return [
        {
          referenceType: row.referenceType,
          externalId: row.externalId,
          url: metadata.data.url,
          matchedEdition: metadata.data.matchedEdition,
          fetchedAt: metadata.data.fetchedAt,
        },
      ]
    }),
    review:
      lookup?.status === 'confirmed'
        ? sonovaultAlbumReview(
            {
              discogsMasters: album.discogsMasters,
              discogsReleases: album.discogsReleases,
              musicbrainzReleaseGroups: album.identity.musicbrainzReleaseGroups,
            },
            references,
          )
        : [],
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
}

/** Review entries of confirmed albums, read in pages of this many. */
const REVIEW_PAGE = 500

/** Every confirmed album with a review entry, with its title and artist. */
async function readReviewAlbums() {
  const confirmed = await db
    .select({
      id: sonovaultAlbumLookup.mediaItemId,
      title: mediaItem.title,
      artist: sql<
        string | null
      >`(select string_agg(a.name, ', ' order by c.billing_order, a.name)
        from media_credit c join artist a on a.id = c.artist_id
        where c.media_item_id = ${mediaItem.id} and c.role = 'artist')`,
    })
    .from(sonovaultAlbumLookup)
    .innerJoin(mediaItem, eq(mediaItem.id, sonovaultAlbumLookup.mediaItemId))
    .where(eq(sonovaultAlbumLookup.status, 'confirmed'))
    .orderBy(sql`lower(${mediaItem.title})`, mediaItem.id)
  const items: {
    albumId: string
    title: string
    artist: string | null
    review: SonovaultAlbumReview[]
  }[] = []
  for (let start = 0; start < confirmed.length; start += REVIEW_PAGE) {
    const page = confirmed.slice(start, start + REVIEW_PAGE)
    const ids = page.map(({ id }) => id)
    const [targets, references] = await Promise.all([
      readAlbumTargets(db, ids),
      readAlbumReferences(db, ids),
    ])
    const targetById = new Map(targets.map((target) => [target.id, target]))
    for (const album of page) {
      const target = targetById.get(album.id)
      if (!target) continue
      const review = sonovaultAlbumReview(
        {
          discogsMasters: target.discogsMasters,
          discogsReleases: target.discogsReleases,
          musicbrainzReleaseGroups: target.identity.musicbrainzReleaseGroups,
        },
        references.filter((row) => row.albumId === album.id),
      )
      if (review.length)
        items.push({
          albumId: album.id,
          title: album.title,
          artist: album.artist,
          review,
        })
    }
  }
  return items
}

/** SONO-22: the albums listed for match review, differing ones first. */
export async function listSonovaultAlbumReview() {
  const items = await readReviewAlbums()
  const differs = (item: (typeof items)[number]) =>
    item.review.some(({ stored }) => stored !== null)
  const ordered = [
    ...items.filter(differs),
    ...items.filter((item) => !differs(item)),
  ]
  return SonovaultAlbumReviewListSchema.parse({
    items: ordered.slice(0, 500),
    totalCount: ordered.length,
  })
}

/** Album counts for Providers → Sonovault. */
export async function getSonovaultAlbumSummary() {
  const [counts] = await db
    .select({
      confirmed: sql<number>`count(*) filter (where ${sonovaultAlbumLookup.status} = 'confirmed')::int`,
      notFound: sql<number>`count(*) filter (where ${sonovaultAlbumLookup.status} = 'not_found')::int`,
      alignedTracks: sql<number>`coalesce(sum(${sonovaultAlbumLookup.aligned}), 0)::int`,
    })
    .from(sonovaultAlbumLookup)
  const items = await readReviewAlbums()
  return SonovaultAlbumSummarySchema.parse({
    confirmed: counts?.confirmed ?? 0,
    notFound: counts?.notFound ?? 0,
    alignedTracks: counts?.alignedTracks ?? 0,
    differing: items.filter((item) =>
      item.review.some(({ stored }) => stored !== null),
    ).length,
    candidates: items.filter((item) =>
      item.review.some(({ stored }) => stored === null),
    ).length,
  })
}

/**
 * The Discogs and MusicBrainz IDs of an album's confirmed release, as Find
 * match candidates for that provider (SONO-22), without a request.
 */
export async function sonovaultAlbumMatchCandidates(albumId: string) {
  const [lookup] = await db
    .select({
      status: sonovaultAlbumLookup.status,
      jobId: sonovaultAlbumLookup.scrapeJobId,
    })
    .from(sonovaultAlbumLookup)
    .where(eq(sonovaultAlbumLookup.mediaItemId, albumId))
  if (lookup?.status !== 'confirmed' || !lookup.jobId) return []
  const [[album], references] = await Promise.all([
    readAlbumTargets(db, [albumId]),
    readAlbumReferences(db, [albumId]),
  ])
  if (!album) return []
  const release = references.find(
    (row) => row.referenceType === 'sonovault-release',
  )
  const metadata = SonovaultAlbumReferenceMetadataSchema.safeParse(
    release?.metadata,
  )
  const jobId = lookup.jobId
  return sonovaultAlbumReview(
    {
      discogsMasters: album.discogsMasters,
      discogsReleases: album.discogsReleases,
      musicbrainzReleaseGroups: album.identity.musicbrainzReleaseGroups,
    },
    references,
  ).map((entry) => ({
    ...entry,
    jobId,
    title: metadata.success
      ? (metadata.data.title ?? album.title)
      : album.title,
    artist: metadata.success ? (metadata.data.artist ?? null) : null,
  }))
}
