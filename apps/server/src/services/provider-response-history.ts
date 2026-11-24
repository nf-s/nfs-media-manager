import { and, count, eq, isNull, max } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import type { z } from 'zod'
import type { PaginationQuerySchema } from '@repo/schemas/common'
import {
  MAX_PROVIDER_RESPONSE_BYTES,
  ProviderResponseCaptureSchema,
  type ProviderResponse,
  type ProviderResponseBody,
  type ProviderResponseCapture,
} from '@repo/schemas/provider-response'
import {
  JsonValueSchema,
  type MediaProviderPlugin,
} from '@repo/media-plugin-sdk'
import { getJobTask } from '@repo/schemas/job'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import {
  MAX_RETAINED_BYTES_PER_ATTEMPT,
  createProviderResponseRecorder,
  providerResponseSecretValues,
} from '@/lib/provider-response-history'
import { resolveProviderSecrets } from '@/lib/provider-secrets'
import {
  providerResponse,
  providerSecret,
  scrapeJob,
  scrapeJobItem,
} from '@/schemas/db'
import { observeTmdbFilmResponse } from './film-catalog-observations'
import { projectSubscriptionResponse } from './subscription-catalog-observations'
import {
  observeMusicProviderResponse,
  readRetainedMusicResponse,
} from './music-provider-observations'

type Database = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0]

type CaptureInput = {
  jobId: string
  jobItemId?: string | null
  artistId?: string | null
  provider: string
  /**
   * The job's own provider when a task job stores another provider's
   * response, as a TIDAL similar read does for its Sonovault lookup.
   */
  jobProvider?: string
  attempt: number
  capture: ProviderResponseCapture
}

type AccountSyncJob = {
  jobId?: string
  log(level: 'info' | 'warn', message: string): Promise<void>
}

/**
 * Stores a scheduled account sync's responses on its job. The account's own
 * data is kept whole; token exchanges are not stored, and the provider's
 * configured secrets are removed from what is. Settings named in `readable`
 * (such as a username) are not treated as secrets, so they stay in the data.
 * The first response past the job's byte cap is logged on the job.
 */
export async function recordAccountSyncResponses(
  job: AccountSyncJob,
  plugin: MediaProviderPlugin,
  readable: readonly string[] = [],
) {
  const jobId = job.jobId
  if (jobId === undefined) return undefined
  const provider = plugin.manifest.id
  const rows = await db
    .select()
    .from(providerSecret)
    .where(eq(providerSecret.provider, provider))
  const settings = Object.entries(
    resolveProviderSecrets(provider, rows, plugin.manifest.secrets),
  ).filter(([name]) => !readable.includes(name))
  return createProviderResponseRecorder(
    (capture) =>
      saveProviderResponseCapture({ jobId, provider, attempt: 1, capture }),
    providerResponseSecretValues(Object.fromEntries(settings)),
    undefined,
    undefined,
    undefined,
    {
      accountData: true,
      onCaptureLimit: () =>
        job.log(
          'warn',
          `Saved responses reached this job's ${MAX_RETAINED_BYTES_PER_ATTEMPT / 1024 / 1024} MB limit. Later responses are listed without their content.`,
        ),
    },
  )
}

/**
 * A late callback can add evidence only to its original provider job and item.
 * Any task job keeps its responses, whether or not its task can be replayed.
 */
export async function saveProviderResponseCapture(
  input: CaptureInput,
  database: Database = db,
): Promise<void> {
  const capture = ProviderResponseCaptureSchema.parse(input.capture)
  const jobItemId = input.jobItemId ?? null
  const taskPhase = capture.phase === 'task'

  const jobProvider = input.jobProvider ?? input.provider
  const jobFilter = and(
    eq(scrapeJob.id, input.jobId),
    eq(scrapeJob.provider, jobProvider),
  )
  const [scope] =
    jobItemId === null
      ? await database
          .select({ id: scrapeJob.id, options: scrapeJob.options })
          .from(scrapeJob)
          .where(jobFilter)
      : await database
          .select({
            id: scrapeJob.id,
            options: scrapeJob.options,
            mediaItemId: scrapeJobItem.mediaItemId,
          })
          .from(scrapeJob)
          .innerJoin(
            scrapeJobItem,
            and(
              eq(scrapeJobItem.jobId, scrapeJob.id),
              eq(scrapeJobItem.id, jobItemId),
              eq(scrapeJobItem.provider, input.provider),
              eq(scrapeJobItem.attemptCount, input.attempt),
            ),
          )
          .where(jobFilter)
  if (
    !scope ||
    (jobProvider !== input.provider && !taskPhase) ||
    (taskPhase &&
      (jobItemId !== null ||
        input.artistId != null ||
        input.attempt !== 1 ||
        getJobTask(scope.options) === null))
  )
    throw new Error(
      'Provider response capture scope does not match the job attempt.',
    )

  const { request, response } = capture
  const size =
    response.body.state === 'captured'
      ? Buffer.byteLength(response.body.text)
      : response.body.state === 'local'
        ? response.body.retainedBytes
        : 0
  const body: ProviderResponseBody =
    response.body.state === 'captured' && size > MAX_PROVIDER_RESPONSE_BYTES
      ? { state: 'unavailable', reason: 'byte-limit' }
      : response.body

  const [stored] = await database
    .insert(providerResponse)
    .values({
      id: nanoid(),
      jobId: scope.id,
      jobItemId,
      artistId: input.artistId ?? null,
      provider: input.provider,
      attempt: input.attempt,
      ordinal: capture.ordinal,
      phase: capture.phase,
      method: request.method,
      requestUrl: request.url,
      requestKey: request.key ?? null,
      status: response.status,
      receivedAt:
        response.receivedAt === null ? null : new Date(response.receivedAt),
      contentType: response.contentType,
      retry: response.retry ?? null,
      notFound: response.notFound ?? false,
      bodyState: body.state,
      retainedBytes: body.state === 'unavailable' ? 0 : size,
      body,
    })
    .onConflictDoNothing()
    .returning()

  if (stored && stored.provider === 'tmdb' && jobItemId !== null) {
    const subjectId =
      'mediaItemId' in scope && typeof scope.mediaItemId === 'string'
        ? scope.mediaItemId
        : undefined
    await database.transaction((tx) =>
      projectTmdbResponse(tx, stored, subjectId),
    )
  }
  if (
    stored &&
    taskPhase &&
    ['spotify', 'youtube', 'rinse', 'nts'].includes(stored.provider)
  )
    await database.transaction((tx) => projectSubscriptionResponse(tx, stored))
  if (stored) {
    const artistId =
      input.artistId ??
      (typeof scope.options.artistId === 'string'
        ? scope.options.artistId
        : undefined)
    const discoveries = readRetainedMusicResponse(stored, artistId)
    if (discoveries.length) {
      const albumId =
        'mediaItemId' in scope && typeof scope.mediaItemId === 'string'
          ? scope.mediaItemId
          : undefined
      await database.transaction((tx) =>
        observeMusicProviderResponse(
          tx,
          stored,
          { artistId, albumId },
          discoveries,
        ),
      )
    }
  }
}

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

export async function projectTmdbResponse(
  tx: Transaction,
  row: Pick<
    typeof providerResponse.$inferSelect,
    'id' | 'jobId' | 'requestUrl' | 'status' | 'body' | 'receivedAt'
  >,
  subjectId?: string,
) {
  const endpoint = row.requestUrl?.startsWith(
    'https://api.themoviedb.org/3/find/',
  )
    ? 'find'
    : row.requestUrl?.startsWith('https://api.themoviedb.org/3/search/movie')
      ? 'search'
      : null
  if (
    !endpoint ||
    row.status === null ||
    row.status < 200 ||
    row.status >= 300 ||
    row.body.state !== 'captured'
  )
    return 0
  let value: unknown
  try {
    value = JSON.parse(row.body.text)
  } catch {
    return 0
  }
  const parsed = JsonValueSchema.safeParse(value)
  if (!parsed.success) return 0
  return observeTmdbFilmResponse(tx, parsed.data, endpoint, {
    provider: 'tmdb',
    operation: endpoint === 'find' ? 'tmdb-find' : 'match-search',
    occurrenceKey: row.id,
    subjectKind: subjectId ? 'film' : undefined,
    subjectId,
    jobId: row.jobId,
    responseId: row.id,
    observedAt: row.receivedAt ?? undefined,
  })
}

const summaryColumns = {
  id: providerResponse.id,
  jobId: providerResponse.jobId,
  jobItemId: providerResponse.jobItemId,
  artistId: providerResponse.artistId,
  provider: providerResponse.provider,
  attempt: providerResponse.attempt,
  ordinal: providerResponse.ordinal,
  phase: providerResponse.phase,
  method: providerResponse.method,
  requestUrl: providerResponse.requestUrl,
  status: providerResponse.status,
  receivedAt: providerResponse.receivedAt,
  contentType: providerResponse.contentType,
  retry: providerResponse.retry,
  notFound: providerResponse.notFound,
  bodyState: providerResponse.bodyState,
  retainedBytes: providerResponse.retainedBytes,
}

function formatSummary(
  row: Omit<ProviderResponse, 'body' | 'requestKey' | 'receivedAt'> & {
    receivedAt: Date | null
  },
) {
  return { ...row, receivedAt: row.receivedAt?.toISOString() ?? null }
}

export async function listJobProviderResponses(
  jobId: string,
  query: z.infer<typeof PaginationQuerySchema>,
) {
  const [job] = await db
    .select({ id: scrapeJob.id })
    .from(scrapeJob)
    .where(eq(scrapeJob.id, jobId))
  if (!job) throw new ServerError({ statusCode: 404, message: 'Job not found' })

  const { page, size } = query
  const scope = eq(providerResponse.jobId, jobId)
  const [rows, totals] = await Promise.all([
    db
      .select(summaryColumns)
      .from(providerResponse)
      .where(scope)
      .orderBy(
        providerResponse.attempt,
        providerResponse.ordinal,
        providerResponse.id,
      )
      .limit(size)
      .offset((page - 1) * size),
    db.select({ value: count() }).from(providerResponse).where(scope),
  ])
  const totalCount = totals[0]?.value ?? 0
  return {
    page,
    size,
    totalCount,
    pageCount: Math.ceil(totalCount / size),
    items: rows.map(formatSummary),
  }
}

export async function getJobProviderResponse(
  jobId: string,
  responseId: string,
) {
  const [row] = await db
    .select({
      ...summaryColumns,
      body: providerResponse.body,
      requestKey: providerResponse.requestKey,
    })
    .from(providerResponse)
    .where(
      and(
        eq(providerResponse.jobId, jobId),
        eq(providerResponse.id, responseId),
      ),
    )
  if (!row)
    throw new ServerError({
      statusCode: 404,
      message: 'Provider response not found',
    })

  const { body, requestKey, ...summary } = row
  return { ...formatSummary(summary), body, requestKey }
}

/**
 * The ordinal a task job attempt's next stored response takes: after every
 * response already stored for it, whichever provider answered.
 */
export async function nextTaskResponseOrdinal(
  jobId: string,
  attempt = 1,
  database: Pick<typeof db, 'select'> = db,
) {
  const [row] = await database
    .select({ last: max(providerResponse.ordinal) })
    .from(providerResponse)
    .where(
      and(
        eq(providerResponse.jobId, jobId),
        isNull(providerResponse.jobItemId),
        eq(providerResponse.attempt, attempt),
      ),
    )
  return (row?.last ?? 0) + 1
}

/**
 * Offline replay reads the exact original attempt, with no live request or
 * other fallback. With `provider`, only that provider's responses: a task
 * job's own come first, so they are numbered from 1 without gaps.
 */
export async function readProviderResponseAttempt(
  scope: Pick<CaptureInput, 'jobId' | 'jobItemId' | 'attempt'> & {
    provider?: string
  },
): Promise<
  Array<{ artistId: string | null; capture: ProviderResponseCapture }>
> {
  const item = scope.jobItemId ?? null
  const rows = await db
    .select({
      artistId: providerResponse.artistId,
      ordinal: providerResponse.ordinal,
      phase: providerResponse.phase,
      method: providerResponse.method,
      requestUrl: providerResponse.requestUrl,
      requestKey: providerResponse.requestKey,
      status: providerResponse.status,
      receivedAt: providerResponse.receivedAt,
      contentType: providerResponse.contentType,
      retry: providerResponse.retry,
      notFound: providerResponse.notFound,
      body: providerResponse.body,
    })
    .from(providerResponse)
    .where(
      and(
        eq(providerResponse.jobId, scope.jobId),
        item === null
          ? isNull(providerResponse.jobItemId)
          : eq(providerResponse.jobItemId, item),
        eq(providerResponse.attempt, scope.attempt),
        scope.provider === undefined
          ? undefined
          : eq(providerResponse.provider, scope.provider),
      ),
    )
    .orderBy(providerResponse.ordinal)

  return rows.map((row) => ({
    artistId: row.artistId,
    capture: {
      ordinal: row.ordinal,
      phase: row.phase,
      request: { method: row.method, url: row.requestUrl, key: row.requestKey },
      response: {
        status: row.status,
        receivedAt: row.receivedAt?.toISOString() ?? null,
        contentType: row.contentType,
        ...(row.retry === null ? {} : { retry: row.retry }),
        notFound: row.notFound,
        body: row.body,
      },
    },
  }))
}
