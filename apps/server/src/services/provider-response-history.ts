import { and, count, eq, isNull } from 'drizzle-orm'
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
import { getJobTask } from '@repo/schemas/job'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import { providerResponse, scrapeJob, scrapeJobItem } from '@/schemas/db'

type Database = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0]

type CaptureInput = {
  jobId: string
  jobItemId?: string | null
  artistId?: string | null
  provider: string
  attempt: number
  capture: ProviderResponseCapture
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

  const jobFilter = and(
    eq(scrapeJob.id, input.jobId),
    eq(scrapeJob.provider, input.provider),
  )
  const [scope] =
    jobItemId === null
      ? await database
          .select({ id: scrapeJob.id, options: scrapeJob.options })
          .from(scrapeJob)
          .where(jobFilter)
      : await database
          .select({ id: scrapeJob.id, options: scrapeJob.options })
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

  await database
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

/** Offline replay reads the exact original attempt, with no live request or other fallback. */
export async function readProviderResponseAttempt(
  scope: Pick<CaptureInput, 'jobId' | 'jobItemId' | 'attempt'>,
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
