import { and, desc, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import {
  SPOTIFY_SIMILAR_LOOKUP_TASK,
  SpotifyCodeMatchSchema,
  TIDAL_SIMILAR_LIMIT,
  TIDAL_SIMILAR_TASK,
  TIDAL_TRACK_MATCH_TASK,
  TidalIdSchema,
  TidalSimilarKindSchema,
  TidalSimilarSchema,
  TidalSuggestionSchema,
  type TidalSimilar,
  type TidalSimilarItem,
  type TidalSimilarJob,
  type TidalSimilarKind,
  type TidalSuggestion,
} from '@repo/schemas/tidal'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import { createStableId } from '@/lib/media-utils'
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
import { createProviderRequest } from './provider-requests'
import { saveProviderResponseCapture } from './provider-response-history'
import { appendProviderTaskReplayStep } from './provider-task-replay'
import {
  libraryItemsByCode,
  libraryItemsBySpotifyId,
  type SimilarLibraryItem,
} from './similar-library-matches'
import { codeKey } from './spotify-code-search'
import { lookupTidalSimilar } from './tidal-similar-lookup'

type Reader = Pick<typeof db, 'select' | 'execute'>

const PROVIDER = 'tidal'
/** A Spotify search that found nothing is tried again after this long. */
export const SPOTIFY_MISS_RETRY_MS = 30 * 24 * 60 * 60 * 1000

const itemId = z.string().trim().min(1).max(200)
const SimilarParamsSchema = z.object({
  kind: TidalSimilarKindSchema,
  itemId,
})
const SimilarOptionsSchema = SimilarParamsSchema.extend({
  tidalId: TidalIdSchema,
  groupKey: z.string().min(1),
  itemTitle: z.string().min(1).max(500),
})
const StoredItemsSchema = z
  .array(TidalSuggestionSchema)
  .max(TIDAL_SIMILAR_LIMIT)

const kindOf = (kind: 'albums' | 'tracks'): TidalSimilarKind =>
  kind === 'albums' ? 'album' : 'track'

/**
 * The item's current TIDAL album or track: for a track, a track match before
 * an album alignment, then the most recently recorded.
 */
function currentTidalId(kind: TidalSimilarKind) {
  return sql<string | null>`(select r.external_id from provider_reference r
    where r.media_item_id = ${mediaItem.id} and r.provider = 'tidal'
      and r.reference_type = ${kind}
    order by (r.metadata->>'source' = 'tidal-track-match') desc nulls last,
      r.metadata->>'recordedAt' desc nulls last, r.id
    limit 1)`
}

/** A visible library album or track, its TIDAL ID and its stored read. */
async function similarTarget(
  database: Pick<typeof db, 'select'>,
  kind: TidalSimilarKind,
  id: string,
) {
  const [target] = await database
    .select({
      title: mediaItem.title,
      tidalId: currentTidalId(kind),
      items: tidalSimilar.items,
      readAt: tidalSimilar.readAt,
    })
    .from(mediaItem)
    .leftJoin(tidalSimilar, eq(tidalSimilar.mediaItemId, mediaItem.id))
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
  return {
    title: target.title.trim(),
    tidalId: tidalId.success ? tidalId.data : null,
    items: items.success ? items.data : [],
    readAt: target.readAt,
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
  if (!target.tidalId)
    throw new ServerError({
      statusCode: 409,
      message: 'Not matched on TIDAL.',
    })
  return SimilarOptionsSchema.parse({
    kind,
    itemId: id,
    tidalId: target.tidalId,
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
 * The suggestions that still need a Spotify search: not in the library, with
 * a valid code, and never searched or missed longer ago than the retry
 * interval. At most one per code.
 */
export async function suggestionsNeedingSpotify(
  database: Reader,
  kind: TidalSimilarKind,
  suggestions: readonly TidalSuggestion[],
  now = new Date(),
) {
  const keyed = suggestions.flatMap((suggestion) => {
    const key = suggestion.code ? codeKey(kind, suggestion.code) : null
    return key && suggestion.code ? [{ key, code: suggestion.code }] : []
  })
  const keys = [...new Set(keyed.map(({ key }) => key))]
  const [library, lookups] = await Promise.all([
    libraryItemsByCode(database, kind, keys),
    spotifyLookups(database, kind, keys),
  ])
  const seen = new Set<string>()
  return keyed.filter(({ key }) => {
    if (seen.has(key) || library.has(key)) return false
    seen.add(key)
    const lookup = lookups.get(key)
    return (
      !lookup ||
      (lookup.spotifyId === null &&
        now.getTime() - lookup.searchedAt.getTime() > SPOTIFY_MISS_RETRY_MS)
    )
  })
}

async function queueSpotifyLookup(
  userId: string | null,
  input: {
    kind: TidalSimilarKind
    itemId: string
    codes: { code: string }[]
  },
) {
  if (!input.codes.length) return null
  try {
    await createTaskJob(SPOTIFY_SIMILAR_LOOKUP_TASK, userId, {
      taskOptions: {
        kind: input.kind,
        itemId: input.itemId,
        codes: input.codes.map(({ code }) => code),
      },
    })
    return `Looking up ${input.codes.length} on Spotify.`
  } catch (error) {
    if (!(error instanceof ServerError)) throw error
    return `Not looked up on Spotify: ${error.message}`
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
    if (!target || target.tidalId !== options.tidalId)
      return {
        outcome: 'complete',
        message: 'Read skipped: the item or its TIDAL match has changed.',
        noProviderRequests: true,
      }
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
        const found = await lookupTidalSimilar(
          createProviderRequest(plugin, context.assertActive, {
            beginResponseCapture: recorder('task'),
          }),
          token,
          lookup,
        )
        recorder.assertStored()
        return found
      },
      context.assertActive,
      'reading similar items',
    )
    if (!(await context.isActive())) return { outcome: 'stopped' }
    const noun = options.kind === 'album' ? 'albums' : 'tracks'
    const spotify = await queueSpotifyLookup(context.requestedByUserId, {
      kind: options.kind,
      itemId: options.itemId,
      codes: await suggestionsNeedingSpotify(db, options.kind, suggestions),
    })
    const readAt = new Date()
    return {
      outcome: 'complete',
      message: [
        `Read ${suggestions.length} similar ${noun} from TIDAL.`,
        spotify,
      ]
        .filter(Boolean)
        .join(' '),
      options: { count: suggestions.length },
      persist: async (tx) => {
        const [item] = await tx
          .select({ id: mediaItem.id })
          .from(mediaItem)
          .where(eq(mediaItem.id, options.itemId))
        if (!item) return
        const values = {
          kind: options.kind,
          items: StoredItemsSchema.parse(suggestions),
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

/** The latest job of a similar task for one item; the partial index's order. */
async function latestSimilarJob(
  database: Pick<typeof db, 'select'>,
  task: typeof TIDAL_SIMILAR_TASK | typeof SPOTIFY_SIMILAR_LOOKUP_TASK,
  id: string,
) {
  const [job] = await database
    .select(jobColumns)
    .from(scrapeJob)
    .where(
      and(
        sql`${scrapeJob.options}->>'task' = ${sql.raw(`'${task}'`)}`,
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

function stateOf(
  library: SimilarLibraryItem | undefined,
  lookup: typeof spotifyCodeLookup.$inferSelect | undefined,
): TidalSimilarItem['state'] {
  if (library) return 'library'
  if (!lookup) return 'unsearched'
  return lookup.spotifyId ? 'spotify' : 'none'
}

/** The stored suggestions with what each maps to now. */
async function mapSuggestions(
  database: Reader,
  kind: TidalSimilarKind,
  suggestions: readonly TidalSuggestion[],
): Promise<TidalSimilarItem[]> {
  const keyOf = (suggestion: TidalSuggestion) =>
    suggestion.code ? codeKey(kind, suggestion.code) : null
  const keys = [...new Set(suggestions.flatMap((item) => keyOf(item) ?? []))]
  const [byCode, lookups] = await Promise.all([
    libraryItemsByCode(database, kind, keys),
    spotifyLookups(database, kind, keys),
  ])
  const spotifyIds = [
    ...new Set(
      [...lookups.values()].flatMap(({ spotifyId }) => spotifyId ?? []),
    ),
  ]
  const bySpotifyId = await libraryItemsBySpotifyId(database, kind, spotifyIds)
  return suggestions.map((suggestion) => {
    const key = keyOf(suggestion)
    const lookup = key ? lookups.get(key) : undefined
    const spotify = SpotifyCodeMatchSchema.safeParse(lookup?.result)
    const library =
      (key ? byCode.get(key) : undefined) ??
      (lookup?.spotifyId ? bySpotifyId.get(lookup.spotifyId) : undefined)
    return {
      ...suggestion,
      state: stateOf(library, lookup),
      library: library ?? null,
      spotify: lookup?.spotifyId && spotify.success ? spotify.data : null,
    }
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
    latestSimilarJob(db, TIDAL_SIMILAR_TASK, id),
    latestSimilarJob(db, SPOTIFY_SIMILAR_LOOKUP_TASK, id),
    mapSuggestions(db, kind, target.items),
  ])
  return TidalSimilarSchema.parse({
    kind,
    itemId: id,
    matched: target.tidalId !== null,
    matchJob: summarize(matchJob),
    job: summarize(job),
    lookupJob: summarize(lookupJob),
    readAt: target.readAt?.toISOString() ?? null,
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
        eq(providerReference.referenceType, 'upc'),
        sql`${providerReference.metadata}->>'sourceProvider' = 'spotify'`,
      ),
    )
    .limit(1)
  return row !== undefined
}

/**
 * Queues the TIDAL match of an item not yet matched on TIDAL, or else the
 * read of its similar items, and returns the Similar state.
 */
export async function queueTidalSimilar(
  input: { kind: 'albums' | 'tracks'; id: string },
  userId: string | null,
): Promise<TidalSimilar> {
  const kind = kindOf(input.kind)
  const id = itemId.parse(input.id)
  const target = await similarTarget(db, kind, id)
  if (!target) notFound(kind)
  if (target.tidalId) {
    await createTaskJob(TIDAL_SIMILAR_TASK, userId, {
      taskOptions: { kind, itemId: id },
    })
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
