import { and, asc, desc, eq, gt, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { JsonValue } from '@repo/schemas/common'
import { isProviderItemNotFoundError } from '@repo/media-plugin-sdk'
import {
  SPOTIFY_SIMILAR_LOOKUP_TASK,
  SpotifyCodeMatchSchema,
  TIDAL_SIMILAR_LIMIT,
  TIDAL_SIMILAR_TASK,
  TIDAL_TRACK_MATCH_TASK,
  TidalIdSchema,
  TidalSimilarKindSchema,
  TidalSimilarSchema,
  TidalSimilarSourceSchema,
  TidalSuggestionSchema,
  TidalTrackMatchReasonSchema,
  type SpotifyCodeLookupSource,
  type TidalSimilar,
  type TidalSimilarItem,
  type TidalSimilarJob,
  type TidalSimilarKind,
  type TidalSimilarSource,
  type TidalSimilarUnmatched,
  type TidalSuggestion,
} from '@repo/schemas/tidal'
import {
  SONOVAULT_REFRESH_MONTHS,
  SONOVAULT_SIMILAR_LOOKUP_TASK,
  SonovaultReferenceMetadataSchema,
} from '@repo/schemas/sonovault'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import { validIsrc } from '@/lib/isrc'
import { createStableId } from '@/lib/media-utils'
import { sonovaultLinkReferenceTypes } from '@/lib/sonovault-api'
import {
  createProviderResponseRecorder,
  providerResponseSecretValues,
} from '@/lib/provider-response-history'
import { tidalCountry, tidalToken } from '@/lib/tidal-api'
import {
  mediaItem,
  providerReference,
  scrapeJob,
  scrapeJobItem,
  scrapeJobLog,
  spotifyCodeLookup,
  tidalSimilar,
} from '@/schemas/db'
import {
  createJob,
  createTaskJob,
  type TaskJobContext,
  type TaskJobResult,
} from './jobs'
import { providerOperation } from './manual-add'
import {
  latestCatalogResponseId,
  observeTidalSuggestion,
} from './music-catalog-observations'
import { artistGenresByBilledName } from './music-tags'
import { createProviderRequest } from './provider-requests'
import { saveProviderResponseCapture } from './provider-response-history'
import { appendProviderTaskReplayStep } from './provider-task-replay'
import {
  libraryItemsByCode,
  libraryMembershipBySpotifyId,
  libraryMembershipByTidalId,
  librarySimilarGenres,
  similarTrackDetails,
  type SimilarLibraryItem,
} from './similar-library-matches'
import { codeKey } from './spotify-code-search'
import {
  lookupSimilarAlbumGenres,
  readSimilarSonovaultAlbums,
  SimilarAlbumResponsesSchema,
} from './sonovault-similar-albums'
import {
  mapSimilarTracksThroughSonovault,
  readSimilarSonovaultTracks,
  similarTrackCheck,
} from './sonovault-similar-lookup'
import { lookupTidalSimilar } from './tidal-similar-lookup'
import { reconcileSimilarArtistCredits } from './catalog-artist-reconciliation'
import { matchTarget } from './tidal-track-match'

type Reader = Pick<typeof db, 'select' | 'execute'>

const PROVIDER = 'tidal'
type SimilarJobTask =
  | typeof TIDAL_SIMILAR_TASK
  | typeof SPOTIFY_SIMILAR_LOOKUP_TASK
  | typeof SONOVAULT_SIMILAR_LOOKUP_TASK
/** A Spotify search that found nothing is tried again after this long. */
export const SPOTIFY_MISS_RETRY_MS = 30 * 24 * 60 * 60 * 1000

const itemId = z.string().trim().min(1).max(200)
const SimilarParamsSchema = z.object({
  kind: TidalSimilarKindSchema,
  itemId,
})
const TidalIdSourceSchema = TidalSimilarSourceSchema.shape.kind
const SimilarOptionsSchema = SimilarParamsSchema.extend({
  tidalId: TidalIdSchema,
  /** Where the TIDAL ID came from; reads queued before SONO-27 used TIDAL's. */
  tidalIdSource: TidalIdSourceSchema.default('tidal'),
  /** The job that recorded the TIDAL ID, when known. */
  tidalIdJobId: z.string().nullable().default(null),
  /** For a Sonovault ID: the stored response its record was read from. */
  sonovaultResponseId: z.string().nullable().default(null),
  groupKey: z.string().min(1),
  itemTitle: z.string().min(1).max(500),
})
/** What a read's job options say about the ID it used. */
const ReadSourceSchema = z.object({
  tidalId: TidalIdSchema,
  tidalIdSource: TidalIdSourceSchema.default('tidal'),
  tidalIdJobId: z.string().nullable().default(null),
})
const SimilarTrackResponsesSchema = z.object({
  sonovault: z.object({ responseId: z.string().optional() }).optional(),
  sonovaultTrackResponses: z
    .array(z.string())
    .max(TIDAL_SIMILAR_LIMIT)
    .default([]),
})
const SimilarAlbumReadSchema = z.object({
  sonovaultAlbumResponses: SimilarAlbumResponsesSchema,
})
const StoredItemsSchema = z
  .array(TidalSuggestionSchema)
  .max(TIDAL_SIMILAR_LIMIT)

const kindOf = (kind: 'albums' | 'tracks'): TidalSimilarKind =>
  kind === 'albums' ? 'album' : 'track'

/**
 * A field of the item's current TIDAL album or track: for a track, a track
 * match (automatic or chosen by the owner) before an album alignment, then
 * the most recently recorded.
 */
function currentTidalReference(
  kind: TidalSimilarKind,
  field: 'externalId' | 'jobId',
) {
  const column = sql.raw(
    field === 'externalId' ? 'r.external_id' : `r.metadata->>'jobId'`,
  )
  return sql<string | null>`(select ${column} from provider_reference r
    where r.media_item_id = ${mediaItem.id} and r.provider = 'tidal'
      and r.reference_type = ${kind}
    order by (r.metadata->>'source' = 'tidal-track-match') desc nulls last,
      r.metadata->>'recordedAt' desc nulls last, r.id
    limit 1)`
}

type IdSource = TidalSimilarSource & { sonovaultResponseId: string | null }

/**
 * The track's TIDAL ID from its Sonovault record (SONO-27): only a verified
 * record, since an unverified one may be another version of the recording,
 * and not an ID TIDAL said it does not know while the record is unchanged.
 */
async function sonovaultTidalId(
  database: Pick<typeof db, 'select'>,
  trackId: string,
): Promise<IdSource | null> {
  const [reference] = await database
    .select({
      externalId: providerReference.externalId,
      metadata: providerReference.metadata,
    })
    .from(providerReference)
    .where(
      and(
        eq(providerReference.mediaItemId, trackId),
        eq(providerReference.provider, 'sonovault'),
        eq(providerReference.referenceType, sonovaultLinkReferenceTypes.tidal),
        sql`${providerReference.metadata}->>'verified' = 'true'`,
      ),
    )
    .orderBy(providerReference.id)
    .limit(1)
  const tidalId = TidalIdSchema.safeParse(reference?.externalId)
  const metadata = SonovaultReferenceMetadataSchema.safeParse(
    reference?.metadata,
  )
  if (!tidalId.success || !metadata.success || !metadata.data.verified)
    return null
  const [dead] = await database
    .select({ id: scrapeJob.id })
    .from(scrapeJob)
    .where(
      and(
        sql`${scrapeJob.options}->>'task' = ${sql.raw(`'${TIDAL_SIMILAR_TASK}'`)}`,
        sql`${scrapeJob.options}->>'itemId' = ${trackId}`,
        sql`${scrapeJob.options}->>'tidalId' = ${tidalId.data}`,
        sql`${scrapeJob.options}->>'sonovaultResponseId' = ${metadata.data.responseId}`,
        sql`${scrapeJob.options}->>'tidalIdDead' = 'true'`,
      ),
    )
    .limit(1)
  if (dead) return null
  return {
    kind: 'sonovault',
    tidalId: tidalId.data,
    jobId: metadata.data.jobId,
    sonovaultResponseId: metadata.data.responseId,
  }
}

/**
 * A visible library album or track, its TIDAL ID and its stored read. The ID
 * is TIDAL's own match or album job, which includes the owner's choice in
 * review; for a track without one, its verified Sonovault record's.
 */
async function similarTarget(
  database: Pick<typeof db, 'select'>,
  kind: TidalSimilarKind,
  id: string,
) {
  const [target] = await database
    .select({
      title: mediaItem.title,
      tidalId: currentTidalReference(kind, 'externalId'),
      tidalJobId: currentTidalReference(kind, 'jobId'),
      items: tidalSimilar.items,
      readAt: tidalSimilar.readAt,
      readOptions: scrapeJob.options,
    })
    .from(mediaItem)
    .leftJoin(tidalSimilar, eq(tidalSimilar.mediaItemId, mediaItem.id))
    .leftJoin(scrapeJob, eq(scrapeJob.id, tidalSimilar.scrapeJobId))
    .where(
      and(
        eq(mediaItem.id, id),
        eq(mediaItem.mediaType, kind),
        sql`${mediaItem.metadata}->>'legacyHidden' is distinct from 'true'`,
      ),
    )
  if (!target) return undefined
  const tidalId = TidalIdSchema.safeParse(target.tidalId)
  const items = StoredItemsSchema.safeParse(target.items)
  const read = ReadSourceSchema.safeParse(target.readOptions)
  const tracks = SimilarTrackResponsesSchema.safeParse(target.readOptions)
  const albums = SimilarAlbumReadSchema.safeParse(target.readOptions)
  const source: IdSource | null = tidalId.success
    ? {
        kind: 'tidal',
        tidalId: tidalId.data,
        jobId: target.tidalJobId,
        sonovaultResponseId: null,
      }
    : kind === 'track'
      ? await sonovaultTidalId(database, id)
      : null
  return {
    title: target.title.trim(),
    tidalId: source?.tidalId ?? null,
    source,
    items: items.success ? items.data : [],
    readAt: target.readAt,
    sonovaultTrackResponses: tracks.success
      ? [
          ...(tracks.data.sonovault?.responseId
            ? [tracks.data.sonovault.responseId]
            : []),
          ...tracks.data.sonovaultTrackResponses,
        ]
      : [],
    sonovaultAlbumResponses: albums.success
      ? albums.data.sonovaultAlbumResponses
      : [],
    readSource:
      target.readAt && read.success
        ? TidalSimilarSourceSchema.parse({
            kind: read.data.tidalIdSource,
            tidalId: read.data.tidalId,
            jobId: read.data.tidalIdJobId,
          })
        : null,
  }
}

function notFound(kind: TidalSimilarKind): never {
  throw new ServerError({
    statusCode: 404,
    message: kind === 'album' ? 'Album not found.' : 'Library track not found.',
  })
}

export async function prepareTidalSimilar(
  userId: string | null,
  input: Record<string, unknown>,
) {
  const { kind, itemId: id } = SimilarParamsSchema.parse(input)
  const target = await similarTarget(db, kind, id)
  if (!target) notFound(kind)
  if (!target.source)
    throw new ServerError({
      statusCode: 409,
      message: 'Not matched on TIDAL.',
    })
  return SimilarOptionsSchema.parse({
    kind,
    itemId: id,
    tidalId: target.source.tidalId,
    tidalIdSource: target.source.kind,
    tidalIdJobId: target.source.jobId,
    sonovaultResponseId: target.source.sonovaultResponseId,
    groupKey: createStableId(
      TIDAL_SIMILAR_TASK,
      JSON.stringify([userId, kind, id]),
    ),
    itemTitle: target.title.slice(0, 500) || id,
  })
}

/** Each code's stored Spotify search, by code key. */
async function spotifyLookups(
  database: Pick<typeof db, 'select'>,
  kind: TidalSimilarKind,
  keys: readonly string[],
) {
  if (!keys.length)
    return new Map<string, typeof spotifyCodeLookup.$inferSelect>()
  const rows = await database
    .select()
    .from(spotifyCodeLookup)
    .where(
      and(
        eq(spotifyCodeLookup.codeType, kind === 'album' ? 'upc' : 'isrc'),
        sql`${spotifyCodeLookup.code} = any(${sql.param([...keys])}::text[])`,
      ),
    )
  return new Map(rows.map((row) => [row.code, row]))
}

/**
 * The suggestions that still need a Spotify lookup: not in the library, with
 * a valid code, and never looked up, missed longer ago than the retry
 * interval, or mapped by Sonovault longer ago than its refresh interval
 * (SONO-10). At most one per code.
 */
export async function suggestionsNeedingSpotify(
  database: Reader,
  kind: TidalSimilarKind,
  suggestions: readonly TidalSuggestion[],
  now = new Date(),
) {
  const keyed = suggestions.flatMap((suggestion) => {
    const key = suggestion.code ? codeKey(kind, suggestion.code) : null
    return key && suggestion.code
      ? [{ key, code: suggestion.code, suggestion }]
      : []
  })
  const refreshBefore = new Date(now)
  refreshBefore.setUTCMonth(
    refreshBefore.getUTCMonth() - SONOVAULT_REFRESH_MONTHS,
  )
  const keys = [...new Set(keyed.map(({ key }) => key))]
  const [byTidalId, byCode, lookups] = await Promise.all([
    libraryMembershipByTidalId(
      database,
      kind,
      keyed.map(({ suggestion }) => suggestion.tidalId),
    ),
    libraryItemsByCode(database, kind, keys),
    spotifyLookups(database, kind, keys),
  ])
  const seen = new Set<string>()
  return keyed.filter(({ key, suggestion }) => {
    if (
      seen.has(key) ||
      byCode.has(key) ||
      byTidalId.visible.has(suggestion.tidalId)
    )
      return false
    seen.add(key)
    const lookup = lookups.get(key)
    return (
      !lookup ||
      (lookup.spotifyId === null &&
        now.getTime() - lookup.searchedAt.getTime() > SPOTIFY_MISS_RETRY_MS) ||
      (lookup.source === 'sonovault' && lookup.searchedAt < refreshBefore)
    )
  })
}

/** Queues the Spotify search of the suggestions' codes. */
async function queueSpotifySearch(
  userId: string | null,
  input: { kind: TidalSimilarKind; itemId: string; codes: readonly string[] },
) {
  try {
    await createTaskJob(SPOTIFY_SIMILAR_LOOKUP_TASK, userId, {
      taskOptions: {
        kind: input.kind,
        itemId: input.itemId,
        codes: [...input.codes],
      },
    })
    return `Looking up ${input.codes.length} on Spotify.`
  } catch (error) {
    if (!(error instanceof ServerError)) throw error
    return `Not looked up on Spotify: ${error.message}`
  }
}

type SpotifyMapping = {
  message: string | null
  options: Record<string, JsonValue>
}

/**
 * Maps the suggestions that need a Spotify lookup. A track's go to Sonovault
 * in this read, one bulk request through Sonovault's request gate (SONO-26),
 * stored with this job; what it does not map, and all of them when Sonovault
 * cannot be used, go to a queued Spotify search. Albums are searched on
 * Spotify directly. Null when the job stopped.
 */
async function mapToSpotify(
  context: TaskJobContext,
  input: {
    kind: TidalSimilarKind
    itemId: string
    codes: { code: string; suggestion: TidalSuggestion }[]
    items: readonly MappedSimilarItem[]
    previousTrackResponses: readonly string[]
  },
): Promise<SpotifyMapping | null> {
  const userId = context.requestedByUserId
  const codes = input.codes.map(({ code }) => code)
  const spotifyOnly = (pending: readonly string[]) =>
    pending.length
      ? queueSpotifySearch(userId, { ...input, codes: pending })
      : null
  if (input.kind === 'album')
    return {
      message: await spotifyOnly(codes),
      options: {},
    }
  const cached = await readSimilarSonovaultTracks(
    db,
    sonovaultTrackCandidates(input.items, input.previousTrackResponses),
  )
  const spotifyCodes = new Set(codes.flatMap((code) => validIsrc(code) ?? []))
  const tracks = input.items.flatMap((item) => {
    const check = similarTrackCheck(item)
    if (!check || cached.has(item.tidalId)) return []
    return spotifyCodes.has(check.code) ||
      (!item.library && !item.genres.length)
      ? [check]
      : []
  })
  const pending = new Set(tracks.map(({ code }) => code))
  const cachedResponses = {
    sonovaultTrackResponses: [
      ...new Set([...cached.values()].map(({ responseId }) => responseId)),
    ],
  }
  if (!tracks.length)
    return { message: await spotifyOnly(codes), options: cachedResponses }
  try {
    const mapping = await mapSimilarTracksThroughSonovault(
      {
        jobId: context.jobId,
        jobProvider: PROVIDER,
        assertActive: context.assertActive,
        isActive: context.isActive,
        ...(context.maxSlotWaitMs === undefined
          ? {}
          : { maxSlotWaitMs: context.maxSlotWaitMs }),
      },
      {
        userId,
        itemId: input.itemId,
        tracks,
        spotifyCodes,
        spotifyOnlyCodes: [...spotifyCodes].filter(
          (code) => !pending.has(code),
        ),
      },
    )
    if (!mapping) return null
    return {
      message: mapping.message,
      options: {
        ...cachedResponses,
        sonovault: mapping.summary,
        ...mapping.credits,
      },
    }
  } catch (error) {
    // The TIDAL read stands when the Sonovault step fails.
    if (!(await context.isActive())) return null
    const reason = error instanceof Error ? error.message : 'unknown error'
    const spotify = await spotifyOnly(codes)
    return {
      message: [`Sonovault lookup failed (${reason}).`, spotify]
        .filter(Boolean)
        .join(' '),
      options: { ...cachedResponses, sonovault: { sent: 0, mapped: 0 } },
    }
  }
}

export async function runTidalSimilar(
  context: TaskJobContext,
  input: Record<string, unknown>,
): Promise<TaskJobResult> {
  try {
    const options = SimilarOptionsSchema.parse(input)
    await context.assertActive()
    const target = await similarTarget(db, options.kind, options.itemId)
    if (
      !target?.source ||
      target.source.tidalId !== options.tidalId ||
      target.source.kind !== options.tidalIdSource
    )
      return {
        outcome: 'complete',
        message: 'Read skipped: the item or its TIDAL match has changed.',
        noProviderRequests: true,
      }
    const fromSonovault = options.tidalIdSource === 'sonovault'
    const suggestions = await providerOperation(
      PROVIDER,
      async ({ secrets, request }, plugin) => {
        const token = await tidalToken(secrets, request)
        const lookup = {
          countryCode: tidalCountry(secrets),
          kind: options.kind,
          tidalId: options.tidalId,
        }
        await appendProviderTaskReplayStep(
          context.jobId,
          PROVIDER,
          TIDAL_SIMILAR_TASK,
          { operation: 'similar', args: lookup },
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
        const similarRequest = createProviderRequest(
          plugin,
          context.assertActive,
          {
            ...(context.maxSlotWaitMs === undefined
              ? {}
              : { maxSlotWaitMs: context.maxSlotWaitMs }),
            beginResponseCapture: recorder('task'),
          },
        )
        try {
          const found = await lookupTidalSimilar(
            similarRequest,
            token,
            lookup,
            {
              notFoundOn404: fromSonovault,
            },
          )
          recorder.assertStored()
          return found
        } catch (error) {
          // A Sonovault ID TIDAL does not know is not a TIDAL failure.
          if (!fromSonovault || !isProviderItemNotFoundError(error)) throw error
          recorder.assertStored()
          return null
        }
      },
      context.assertActive,
      'reading similar items',
      context.maxSlotWaitMs,
    )
    if (!(await context.isActive())) return { outcome: 'stopped' }
    if (!suggestions)
      return {
        outcome: 'complete',
        message: `TIDAL has no track ${options.tidalId}, the TIDAL ID from Sonovault.`,
        options: { tidalIdDead: true },
      }
    const noun = options.kind === 'album' ? 'albums' : 'tracks'
    const readAt = new Date()
    const [items, codes] = await Promise.all([
      mapSuggestions(db, options.kind, suggestions),
      suggestionsNeedingSpotify(db, options.kind, suggestions),
    ])
    const spotify = await mapToSpotify(context, {
      kind: options.kind,
      itemId: options.itemId,
      codes,
      items,
      previousTrackResponses: target.sonovaultTrackResponses,
    })
    if (!spotify) return { outcome: 'stopped' }
    const albums =
      options.kind === 'album'
        ? await lookupSimilarAlbumGenres(
            context,
            items,
            target.sonovaultAlbumResponses,
          )
        : null
    if (!(await context.isActive())) return { outcome: 'stopped' }
    return {
      outcome: 'complete',
      message: [
        `Read ${suggestions.length} similar ${noun} from TIDAL${fromSonovault ? ' with the TIDAL ID from Sonovault' : ''}.`,
        spotify.message,
        albums?.message,
      ]
        .filter(Boolean)
        .join(' '),
      options: {
        count: suggestions.length,
        ...spotify.options,
        ...albums?.options,
      },
      persist: async (tx) => {
        const [item] = await tx
          .select({ id: mediaItem.id })
          .from(mediaItem)
          .where(eq(mediaItem.id, options.itemId))
        if (!item) return
        const observed = await observeStoredTidalSuggestions(tx, {
          kind: options.kind,
          itemId: options.itemId,
          jobId: context.jobId,
          observedAt: readAt,
          suggestions,
        })
        const values = {
          kind: options.kind,
          items: StoredItemsSchema.parse(observed),
          scrapeJobId: context.jobId,
          readAt,
        }
        await tx
          .insert(tidalSimilar)
          .values({ mediaItemId: options.itemId, ...values })
          .onConflictDoUpdate({
            target: tidalSimilar.mediaItemId,
            set: { ...values, updatedAt: readAt },
          })
      },
    }
  } catch (error) {
    if (!(await context.isActive())) return { outcome: 'stopped' }
    return { outcome: 'failed', error }
  }
}

async function observeStoredTidalSuggestions(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  input: {
    kind: TidalSimilarKind
    itemId: string
    jobId: string | null
    observedAt?: Date
    suggestions: TidalSuggestion[]
  },
) {
  if (!input.suggestions.length) return []
  const responseId = input.jobId
    ? await latestCatalogResponseId(tx, input.jobId, PROVIDER)
    : undefined
  const items: TidalSuggestion[] = []
  for (const [index, item] of input.suggestions.entries()) {
    const catalogMediaItemId = await observeTidalSuggestion(
      tx,
      input.kind,
      item,
      {
        operation: 'similar',
        key: input.jobId ?? input.itemId,
        subjectKind: input.kind,
        subjectId: input.itemId,
        jobId: input.jobId ?? undefined,
        responseId,
        page: 1,
        position: item.catalogPosition ?? index + 1,
        observedAt: input.observedAt,
      },
    )
    items.push({ ...item, catalogMediaItemId })
  }
  if (input.kind === 'track') await reconcileSimilarArtistCredits(tx, items)
  return items
}

/** Projects a bounded batch of the Similar pages still cached by the app. */
export async function backfillTidalSimilarDiscoveries(input: {
  after?: string
  limit: number
  apply: boolean
}) {
  const rows = await db
    .select()
    .from(tidalSimilar)
    .where(input.after ? gt(tidalSimilar.mediaItemId, input.after) : undefined)
    .orderBy(asc(tidalSimilar.mediaItemId))
    .limit(input.limit)
  let candidates = 0
  let skipped = 0
  for (const row of rows) {
    const suggestions = StoredItemsSchema.safeParse(row.items)
    const kind = TidalSimilarKindSchema.safeParse(row.kind)
    if (!suggestions.success || !kind.success) {
      skipped += 1
      continue
    }
    candidates += suggestions.data.length
    if (input.apply) {
      await db.transaction(async (tx) => {
        const items = await observeStoredTidalSuggestions(tx, {
          kind: kind.data,
          itemId: row.mediaItemId,
          jobId: row.scrapeJobId,
          observedAt: row.readAt,
          suggestions: suggestions.data,
        })
        await tx
          .update(tidalSimilar)
          .set({ items })
          .where(
            and(
              eq(tidalSimilar.mediaItemId, row.mediaItemId),
              eq(tidalSimilar.readAt, row.readAt),
            ),
          )
      })
    }
  }
  return { next: rows.at(-1)?.mediaItemId ?? null, candidates, skipped }
}

const jobColumns = {
  jobId: scrapeJob.id,
  status: scrapeJob.status,
  errorMessage: scrapeJob.errorMessage,
  createdAt: scrapeJob.createdAt,
  finishedAt: scrapeJob.finishedAt,
}
type JobRow = {
  jobId: string
  status: TidalSimilarJob['status']
  errorMessage: string | null
  createdAt: Date
  finishedAt: Date | null
}
const summarize = (job: JobRow | undefined): TidalSimilarJob | null =>
  job
    ? {
        ...job,
        createdAt: job.createdAt.toISOString(),
        finishedAt: job.finishedAt?.toISOString() ?? null,
      }
    : null

/**
 * The latest job of the item among the similar tasks, in the partial index's
 * order. A track's Spotify lookup is the Spotify search the read queues, or
 * a Sonovault job queued before the read did the Sonovault lookup itself.
 */
async function latestSimilarJob(
  database: Pick<typeof db, 'select'>,
  tasks: readonly SimilarJobTask[],
  id: string,
) {
  const [job] = await database
    .select(jobColumns)
    .from(scrapeJob)
    .where(
      and(
        sql`${scrapeJob.options}->>'task' in (${sql.raw(tasks.map((task) => `'${task}'`).join(', '))})`,
        sql`${scrapeJob.options}->>'itemId' = ${id}`,
      ),
    )
    .orderBy(desc(scrapeJob.createdAt), desc(scrapeJob.id))
    .limit(1)
  return job
}

/** The latest TIDAL album job or track match of the item. */
async function latestMatchJob(
  database: Pick<typeof db, 'select'>,
  kind: TidalSimilarKind,
  id: string,
) {
  if (kind === 'track') {
    const [job] = await database
      .select(jobColumns)
      .from(scrapeJob)
      .where(
        and(
          eq(scrapeJob.provider, PROVIDER),
          sql`${scrapeJob.options}->>'task' = ${sql.raw(`'${TIDAL_TRACK_MATCH_TASK}'`)}`,
          sql`${scrapeJob.options}->>'trackId' = ${id}`,
        ),
      )
      .orderBy(desc(scrapeJob.createdAt), desc(scrapeJob.id))
      .limit(1)
    return job
  }
  const [job] = await database
    .select(jobColumns)
    .from(scrapeJobItem)
    .innerJoin(scrapeJob, eq(scrapeJob.id, scrapeJobItem.jobId))
    .where(
      and(
        eq(scrapeJobItem.provider, PROVIDER),
        eq(scrapeJobItem.mediaItemId, id),
      ),
    )
    .orderBy(desc(scrapeJob.createdAt), desc(scrapeJob.id))
    .limit(1)
  return job
}

/** What a track match job's options and log say about its result. */
const MatchOutcomeSchema = z.object({
  isrc: z.string().max(40).optional(),
  reason: TidalTrackMatchReasonSchema.optional(),
  candidateCount: z.number().int().optional(),
  acceptedTidalTrackId: z.string().optional(),
})

/**
 * Why a track is not matched on TIDAL, from its latest track match and its
 * ISRC: TIDAL tracks left for the owner's review, no ISRC to match by, or no
 * TIDAL track with the ISRC. Null while a match runs and when not known.
 */
async function unmatchedTrack(
  database: Pick<typeof db, 'select'>,
  id: string,
  matchJob: JobRow | undefined,
): Promise<TidalSimilarUnmatched | null> {
  if (matchJob?.status === 'queued' || matchJob?.status === 'running')
    return null
  const jobId = matchJob?.jobId ?? null
  const [track, [job], [notFound]] = await Promise.all([
    matchTarget(database, id),
    jobId
      ? database
          .select({ options: scrapeJob.options })
          .from(scrapeJob)
          .where(eq(scrapeJob.id, jobId))
      : [],
    jobId && matchJob?.status === 'failed'
      ? database
          .select({ id: scrapeJobLog.id })
          .from(scrapeJobLog)
          .where(
            and(
              eq(scrapeJobLog.jobId, jobId),
              sql`${scrapeJobLog.metadata}->>'classification' = 'not-found'`,
            ),
          )
          .limit(1)
      : [],
  ])
  const options = MatchOutcomeSchema.safeParse(job?.options)
  const result = options.success ? options.data : {}
  if (
    matchJob?.status === 'succeeded' &&
    result.reason === 'ambiguous' &&
    !result.acceptedTidalTrackId &&
    result.candidateCount
  )
    return { reason: 'review', candidateCount: result.candidateCount }
  if (!track?.isrc) return { reason: 'no-isrc' }
  if (notFound && result.isrc) return { reason: 'not-found', isrc: result.isrc }
  return null
}

function stateOf(
  library: SimilarLibraryItem | undefined,
  lookup: typeof spotifyCodeLookup.$inferSelect | undefined,
): TidalSimilarItem['state'] {
  if (library) return 'library'
  if (!lookup) return 'unsearched'
  return lookup.spotifyId ? 'spotify' : 'none'
}

type MappedSimilarItem = TidalSimilarItem & {
  spotifySource: SpotifyCodeLookupSource | null
  sonovaultResponseId: string | null
}

function sonovaultTrackCandidates(
  items: readonly MappedSimilarItem[],
  responseIds: readonly string[],
) {
  return items.flatMap((suggestion) => {
    if (suggestion.genres.length) return []
    const ids = suggestion.sonovaultResponseId
      ? [...responseIds, suggestion.sonovaultResponseId]
      : responseIds
    return ids.length ? [{ suggestion, responseIds: ids }] : []
  })
}

/** The stored suggestions with what each maps to now. */
async function mapSuggestions(
  database: Reader,
  kind: TidalSimilarKind,
  suggestions: readonly TidalSuggestion[],
): Promise<MappedSimilarItem[]> {
  const keyOf = (suggestion: TidalSuggestion) =>
    suggestion.code ? codeKey(kind, suggestion.code) : null
  const keys = [...new Set(suggestions.flatMap((item) => keyOf(item) ?? []))]
  const [byTidalId, byCode, lookups] = await Promise.all([
    libraryMembershipByTidalId(
      database,
      kind,
      suggestions.map(({ tidalId }) => tidalId),
    ),
    libraryItemsByCode(database, kind, keys),
    spotifyLookups(database, kind, keys),
  ])
  const spotifyIds = [
    ...new Set(
      [...lookups.values()].flatMap(({ spotifyId }) => spotifyId ?? []),
    ),
  ]
  const bySpotifyId = await libraryMembershipBySpotifyId(
    database,
    kind,
    spotifyIds,
  )
  return suggestions.map((suggestion) => {
    const key = keyOf(suggestion)
    const lookup = key ? lookups.get(key) : undefined
    const spotify = SpotifyCodeMatchSchema.safeParse(lookup?.result)
    const tidal = byTidalId.visible.get(suggestion.tidalId)
    const code = key ? byCode.get(key) : undefined
    const spotifyId = lookup?.spotifyId
    const spotifyLibrary = spotifyId
      ? bySpotifyId.visible.get(spotifyId)
      : undefined
    const library = tidal ?? code ?? spotifyLibrary
    const hiddenLibraryMatch =
      !library &&
      (byTidalId.hidden.has(suggestion.tidalId) ||
        Boolean(
          spotifyId &&
          lookup?.source === 'spotify' &&
          bySpotifyId.hidden.has(spotifyId),
        ))
    const libraryMatch: TidalSimilarItem['libraryMatch'] = tidal
      ? { basis: 'tidal-id', value: suggestion.tidalId }
      : code && suggestion.code
        ? { basis: kind === 'track' ? 'isrc' : 'upc', value: suggestion.code }
        : spotifyLibrary && spotifyId
          ? { basis: 'spotify-id', value: spotifyId }
          : null
    return {
      ...suggestion,
      genres: suggestion.genres ?? [],
      genreSource: suggestion.genres?.length ? 'tidal' : null,
      genreArtist: null,
      genreEvidence: null,
      state: stateOf(library, lookup),
      library: library ?? null,
      libraryMatch,
      ...(hiddenLibraryMatch ? { hiddenLibraryMatch: true } : {}),
      spotify:
        spotify.success && spotify.data.spotifyId === lookup?.spotifyId
          ? spotify.data
          : null,
      spotifySource: lookup?.source ?? null,
      sonovaultResponseId:
        lookup?.source === 'sonovault' ? lookup.responseId : null,
    }
  })
}

async function mapSimilarGenres(
  database: Reader,
  kind: TidalSimilarKind,
  items: readonly MappedSimilarItem[],
  evidence: Pick<
    NonNullable<Awaited<ReturnType<typeof similarTarget>>>,
    'sonovaultTrackResponses' | 'sonovaultAlbumResponses'
  >,
): Promise<TidalSimilarItem[]> {
  const trackIds: string[] = []
  const albumIds: string[] = []
  const spotifyAlbumIds: string[] = []
  const billedArtists: string[] = []
  const spotifyAlbumId = (item: MappedSimilarItem) =>
    item.spotify?.spotifyId ?? item.library?.spotifyId
  for (const item of items) {
    if (kind === 'track') {
      if (item.library) {
        trackIds.push(item.library.id)
        if (item.library.album) albumIds.push(item.library.album.id)
      }
    } else {
      if (item.library) albumIds.push(item.library.id)
      if (!item.genres.length && !item.spotify?.genres?.length) {
        const id = spotifyAlbumId(item)
        if (id) spotifyAlbumIds.push(id)
        const [artist] = item.artists
        if (artist && item.artists.length === 1) billedArtists.push(artist)
      }
    }
  }
  const [library, sonovault, artistGenres, sonovaultAlbums] = await Promise.all(
    [
      librarySimilarGenres(database, { trackIds, albumIds, spotifyAlbumIds }),
      readSimilarSonovaultTracks(
        database,
        kind === 'track'
          ? sonovaultTrackCandidates(items, evidence.sonovaultTrackResponses)
          : [],
      ),
      artistGenresByBilledName(database, billedArtists),
      readSimilarSonovaultAlbums(
        database,
        kind === 'album' ? items : [],
        kind === 'album' ? evidence.sonovaultAlbumResponses : [],
      ),
    ],
  )
  return items.map((item) => {
    const direct = item.library ? library[kind].get(item.library.id) : undefined
    if (direct?.length)
      return { ...item, genres: direct, genreSource: 'library' }
    if (item.genres.length) return item
    if (kind === 'track') {
      const external = sonovault.get(item.tidalId)
      // A hidden or owner-removed library tag stays hidden when a provider
      // response has the same recording's genres.
      if (external?.genres.length && direct === undefined)
        return {
          ...item,
          genres: external.genres,
          genreSource: 'sonovault',
          genreEvidence: {
            jobId: external.jobId,
            responseId: external.responseId,
          },
        }
      const album =
        item.library?.album && library.album.get(item.library.album.id)
      if (album?.length)
        return { ...item, genres: album, genreSource: 'track-album' }
      return item
    }
    if (item.spotify?.genres?.length)
      return { ...item, genres: item.spotify.genres, genreSource: 'spotify' }
    const external = sonovaultAlbums.get(item.tidalId)
    if (external?.genres.length && direct === undefined)
      return {
        ...item,
        genres: external.genres,
        genreSource: 'sonovault-album-tracks',
        genreEvidence: {
          jobId: external.jobId,
          responseId: external.ref.responseId,
        },
      }
    const id = spotifyAlbumId(item)
    const members = id ? library['member-tracks'].get(id) : undefined
    if (members?.length)
      return { ...item, genres: members, genreSource: 'album-tracks' }
    const [artist] = item.artists
    const profile =
      artist && item.artists.length === 1 ? artistGenres.get(artist) : undefined
    return profile?.genres.length
      ? {
          ...item,
          genres: profile.genres,
          genreSource: 'artist',
          genreArtist: profile.artist,
        }
      : item
  })
}

/** Find one suggestion from the source's saved read using current library matches. */
export async function findStoredTidalSuggestion(
  database: Reader,
  kind: TidalSimilarKind,
  sourceId: string,
  tidalId: string,
): Promise<MappedSimilarItem | null | undefined> {
  const target = await similarTarget(database, kind, sourceId)
  if (!target) return undefined
  const suggestion = target.items.find((item) => item.tidalId === tidalId)
  if (!suggestion) return null
  const [mapped] = await mapSuggestions(database, kind, [suggestion])
  return mapped ?? null
}

async function presentSimilarItems(
  database: Reader,
  kind: TidalSimilarKind,
  target: NonNullable<Awaited<ReturnType<typeof similarTarget>>>,
) {
  const mapped = await mapSuggestions(database, kind, target.items)
  if (kind === 'album') return mapSimilarGenres(database, kind, mapped, target)
  const idOf = (item: TidalSimilarItem) =>
    item.library?.id ?? item.catalogMediaItemId
  const ids = [...new Set(mapped.flatMap((item) => idOf(item) ?? []))]
  const [items, tracks] = await Promise.all([
    mapSimilarGenres(database, kind, mapped, target),
    similarTrackDetails(database, ids),
  ])
  return items.map((item) => {
    const id = idOf(item)
    const track = id ? tracks.get(id) : undefined
    return track ? { ...item, track } : item
  })
}

async function readTidalSimilar(
  kind: TidalSimilarKind,
  id: string,
): Promise<TidalSimilar> {
  const target = await similarTarget(db, kind, id)
  if (!target) notFound(kind)
  const [matchJob, job, lookupJob, items] = await Promise.all([
    latestMatchJob(db, kind, id),
    latestSimilarJob(db, [TIDAL_SIMILAR_TASK], id),
    latestSimilarJob(
      db,
      [SPOTIFY_SIMILAR_LOOKUP_TASK, SONOVAULT_SIMILAR_LOOKUP_TASK],
      id,
    ),
    presentSimilarItems(db, kind, target),
  ])
  const unmatched =
    kind === 'track' && target.tidalId === null
      ? await unmatchedTrack(db, id, matchJob)
      : null
  return TidalSimilarSchema.parse({
    kind,
    itemId: id,
    matched: target.tidalId !== null,
    matchJob: summarize(matchJob),
    unmatched,
    job: summarize(job),
    lookupJob: summarize(lookupJob),
    readAt: target.readAt?.toISOString() ?? null,
    source: target.readSource,
    items,
  })
}

export async function getTidalSimilar(input: {
  kind: 'albums' | 'tracks'
  id: string
}) {
  return readTidalSimilar(kindOf(input.kind), itemId.parse(input.id))
}

async function albumHasSpotifyUpc(id: string) {
  const [row] = await db
    .select({ id: providerReference.id })
    .from(providerReference)
    .where(
      and(
        eq(providerReference.mediaItemId, id),
        eq(providerReference.provider, 'spotify'),
        eq(providerReference.referenceType, 'upc'),
      ),
    )
    .limit(1)
  return row !== undefined
}

/**
 * Matches an item not yet matched on TIDAL, or else reads its similar items,
 * in this request through the request gate, and returns the Similar state.
 * A track with a verified Sonovault TIDAL ID is read without a match; when
 * TIDAL does not know that ID, the track is matched and then read, once
 * (SONO-27). A track's suggestions are mapped through Sonovault in the same
 * read; the Spotify search of what is left stays a queued job.
 */
export async function refreshTidalSimilar(
  input: { kind: 'albums' | 'tracks'; id: string },
  userId: string | null,
): Promise<TidalSimilar> {
  const kind = kindOf(input.kind)
  const id = itemId.parse(input.id)
  const target = await similarTarget(db, kind, id)
  if (!target) notFound(kind)
  if (target.tidalId) {
    const read = await createTaskJob(TIDAL_SIMILAR_TASK, userId, {
      taskOptions: { kind, itemId: id },
    })
    if (read.options.tidalIdDead === true) {
      await createTaskJob(TIDAL_TRACK_MATCH_TASK, userId, {
        taskOptions: { trackId: id },
      })
      const matched = await similarTarget(db, kind, id)
      if (matched?.source?.kind === 'tidal')
        await createTaskJob(TIDAL_SIMILAR_TASK, userId, {
          taskOptions: { kind, itemId: id },
        })
    }
  } else if (kind === 'track') {
    await createTaskJob(TIDAL_TRACK_MATCH_TASK, userId, {
      taskOptions: { trackId: id },
    })
  } else {
    if (!(await albumHasSpotifyUpc(id)))
      throw new ServerError({
        statusCode: 409,
        message: 'The album has no UPC from Spotify.',
      })
    await createJob(
      {
        provider: PROVIDER,
        scope: { mediaType: 'album', mediaItemIds: [id], limit: 1 },
        options: {},
        confirmBroadRun: false,
      },
      userId,
    )
  }
  return readTidalSimilar(kind, id)
}
