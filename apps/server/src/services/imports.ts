import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { nanoid } from 'nanoid'
import { and, desc, eq, gt, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import {
  ImportRunSchema,
  ImportStatusQuerySchema,
  type ImportRun,
  StartImportSchema,
  normalizeSavedView,
} from '@repo/schemas/imports'
import { JsonValueSchema } from '@repo/media-plugin-sdk'
import { db } from '@/lib/db'
import { env } from '@/env'
import { cloudQueue } from '@/lib/runtime'
import { findWorkspaceRootPath } from '@/lib/load-workspace-env'
import { ServerError } from '@/lib/error'
import {
  importMediaType,
  importMediaTypeExpression,
} from '@/lib/import-media-type'
import {
  filmImportPreview,
  libraryImport,
  providerSnapshot,
  scrapeJob,
  scrapeJobItem,
} from '@/schemas/db'

export function requireLocalImportSource() {
  if (env.RUNTIME_KIND === 'cloudflare')
    throw new ServerError({
      statusCode: 422,
      message:
        'Server-path imports and NFO traversal are unavailable in cloud deployments. Upload a CSV or use the local migration/NFO tooling.',
    })
}

async function legacySources() {
  const names = ['Raw albums', 'Raw films', 'Current albums', 'Current films']
  if (env.RUNTIME_KIND === 'cloudflare')
    return names.map((name) => ({
      name,
      available: false,
      bytes: null,
      updatedAt: null,
    }))
  const root = findWorkspaceRootPath(process.cwd()) ?? process.cwd()
  const paths = [
    resolve(root, env.LEGACY_SERVER_DATA_DIR, 'lib-music.json'),
    resolve(root, env.LEGACY_SERVER_DATA_DIR, 'lib.json'),
    resolve(root, 'apps/web/public/data/lib-music.json'),
    resolve(root, 'apps/web/public/data/lib-movie.json'),
  ]
  return Promise.all(
    paths.map(async (path, index) => {
      const name = names[index] ?? 'Library'
      try {
        const info = await stat(path)
        return {
          name,
          available: info.isFile(),
          bytes: info.size,
          updatedAt: info.mtime.toISOString(),
        }
      } catch {
        return { name, available: false, bytes: null, updatedAt: null }
      }
    }),
  )
}

export async function getImportStatus(
  input: z.input<typeof ImportStatusQuerySchema> = {},
) {
  const query = ImportStatusQuerySchema.parse(input)
  const sources = await legacySources()
  const scope = importMediaTypeExpression(libraryImport.result)
  const records = await db
    .select()
    .from(libraryImport)
    .where(
      query.mediaType
        ? sql`(${scope} is null or ${scope} = ${query.mediaType})`
        : undefined,
    )
    .orderBy(desc(libraryImport.createdAt))
    .limit(20)
  return {
    sources,
    runs: records.map((row) =>
      ImportRunSchema.parse({
        ...row,
        mediaType: importMediaType(row.result),
        createdAt: row.createdAt.toISOString(),
        finishedAt: row.finishedAt?.toISOString() ?? null,
      }),
    ),
  }
}

export async function startLibraryImport(
  input: z.infer<typeof StartImportSchema>,
  userId: string | null,
) {
  requireLocalImportSource()
  const options = StartImportSchema.parse(input)
  if (!(await getImportStatus()).sources.every((source) => source.available))
    throw new ServerError({
      statusCode: 422,
      message: 'One or more library files are missing',
    })
  const { runLegacyImport } = await import('../../scripts/import-legacy')
  return startManagedImport(userId, (onProgress) =>
    runLegacyImport(
      {
        albumLimit: options.fullLibrary ? null : options.albumLimit,
        filmLimit: options.fullLibrary ? null : options.filmLimit,
      },
      onProgress,
      true,
    ),
  )
}

export async function startManagedImport(
  userId: string | null,
  execute: (
    progress: (value: {
      stage: string
      processed: number
      total: number
    }) => Promise<void>,
  ) => Promise<NonNullable<ImportRun['result']>>,
  mediaType: ImportRun['mediaType'] = null,
) {
  requireLocalImportSource()
  const id = nanoid()
  const client = await db.$client.connect()
  const lock = z
    .object({ rows: z.array(z.object({ locked: z.boolean() })) })
    .parse(await client.query('select pg_try_advisory_lock(614103) as locked'))
  if (!lock.rows[0]?.locked) {
    client.release()
    throw new ServerError({
      statusCode: 409,
      message: 'A library import is already running',
    })
  }
  try {
    const initialResult: NonNullable<ImportRun['result']> = {
      albums: 0,
      films: 0,
      mediaType,
    }
    await db
      .update(libraryImport)
      .set({
        status: 'failed',
        stage: 'Interrupted',
        errorMessage:
          'Server stopped during this import. It is safe to run again.',
        finishedAt: new Date(),
      })
      .where(
        and(
          eq(libraryImport.status, 'running'),
          sql`not (coalesce(${libraryImport.result}, '{}'::jsonb) ? 'task')`,
        ),
      )
    await db.insert(libraryImport).values({
      id,
      status: 'running',
      stage: 'Starting',
      result: initialResult,
      requestedByUserId: userId,
    })
  } catch (error) {
    await client.query('select pg_advisory_unlock(614103)')
    client.release()
    throw error
  }
  void execute(async (progress) => {
    await db.update(libraryImport).set(progress).where(eq(libraryImport.id, id))
  })
    .then(async (result) => {
      await db
        .update(libraryImport)
        .set({
          status: result.failed ? 'failed' : 'succeeded',
          stage: result.failed ? 'Completed with errors' : 'Complete',
          errorMessage: result.failed
            ? `${result.failed} records failed; see import warnings.`
            : null,
          result: { ...result, mediaType },
          finishedAt: new Date(),
        })
        .where(eq(libraryImport.id, id))
    })
    .catch(async (error) => {
      console.error('Local library import failed', error)
      await db
        .update(libraryImport)
        .set({
          status: 'failed',
          stage: 'Failed',
          errorMessage:
            'Import failed. Check server logs and source files before retrying.',
          finishedAt: new Date(),
        })
        .where(eq(libraryImport.id, id))
    })
    .finally(async () => {
      await client.query('select pg_advisory_unlock(614103)')
      client.release()
    })
  const status = await getImportStatus()
  return (
    status.runs.find((run) => run.id === id) ??
    ImportRunSchema.parse({
      id,
      mediaType,
      status: 'running',
      stage: 'Starting',
      processed: 0,
      total: 0,
      errorMessage: null,
      result: null,
      createdAt: new Date().toISOString(),
      finishedAt: null,
    })
  )
}

export const QueuedImportTaskSchema = z
  .object({
    version: z.literal(1),
    mediaType: z.enum(['film', 'album']),
    previewId: z.string().min(1),
    rows: z.array(z.number().int().nonnegative()).min(1).max(9999),
    providers: z.array(z.string().min(1)),
    confirmBroadRun: z.boolean(),
  })
  .strict()
export type QueuedImportTask = z.infer<typeof QueuedImportTaskSchema>
export type ImportTransaction = Parameters<
  Parameters<typeof db.transaction>[0]
>[0]

const QueuedImportResultSchema = z.object({
  albums: z.number(),
  films: z.number(),
  mediaType: z.enum(['film', 'album']),
  task: QueuedImportTaskSchema,
  cursor: z.number().int().nonnegative(),
  newIds: z.array(z.string()),
  created: z.number(),
  updated: z.number(),
  unchanged: z.number(),
  failed: z.number(),
  warnings: z.array(z.string()),
  enrichmentCursor: z.number().int().nonnegative().default(0),
  queuedJobs: z.number().int().nonnegative().default(0),
  skippedJobs: z.number().int().nonnegative().default(0),
})

export async function startQueuedImport(
  userId: string | null,
  input: QueuedImportTask,
) {
  const task = QueuedImportTaskSchema.parse(input)
  const queue = cloudQueue()
  if (!queue)
    throw new ServerError({
      statusCode: 503,
      message: 'The durable import queue is unavailable.',
    })
  const id = nanoid()
  const result = {
    albums: 0,
    films: 0,
    mediaType: task.mediaType,
    task,
    cursor: 0,
    newIds: [],
    created: 0,
    updated: 0,
    unchanged: 0,
    failed: 0,
    warnings: [],
  }
  const createdAt = new Date()
  await db.transaction(async (tx) => {
    const [claimed] = await tx
      .update(filmImportPreview)
      .set({ claimed: true })
      .where(
        and(
          eq(filmImportPreview.id, task.previewId),
          eq(filmImportPreview.claimed, false),
          userId === null
            ? sql`${filmImportPreview.requestedByUserId} is null`
            : eq(filmImportPreview.requestedByUserId, userId),
          gt(filmImportPreview.expiresAt, createdAt),
          inArray(
            filmImportPreview.kind,
            task.mediaType === 'film'
              ? ['csv']
              : ['album-csv', 'spotify-saved'],
          ),
        ),
      )
      .returning({ id: filmImportPreview.id })
    if (!claimed)
      throw new ServerError({
        statusCode: 409,
        message: 'Preview already used or expired. Preview again.',
      })
    await tx.insert(libraryImport).values({
      id,
      status: 'queued',
      stage: 'Queued',
      result,
      total: task.rows.length,
      requestedByUserId: userId,
      createdAt,
    })
  })
  // The execution row is the outbox: a failed/ambiguous send must not unclaim it.
  try {
    await queue.send({ type: 'import', importId: id })
  } catch {
    await db
      .update(libraryImport)
      .set({ stage: 'Awaiting queue delivery' })
      .where(and(eq(libraryImport.id, id), eq(libraryImport.status, 'queued')))
  }
  return ImportRunSchema.parse({
    id,
    mediaType: task.mediaType,
    status: 'queued',
    stage: 'Queued',
    processed: 0,
    total: task.rows.length,
    result,
    errorMessage: null,
    createdAt: createdAt.toISOString(),
    finishedAt: null,
  })
}

/** Republishes unfinished durable tasks after an interrupted or ambiguous delivery. */
export async function dispatchQueuedImports() {
  const queue = cloudQueue()
  if (!queue) return
  const pending = await db
    .select({ id: libraryImport.id })
    .from(libraryImport)
    .where(
      and(
        inArray(libraryImport.status, ['queued', 'running']),
        sql`${libraryImport.result} ? 'task'`,
      ),
    )
    .orderBy(libraryImport.createdAt)
    .limit(100)
  for (const row of pending)
    await queue.send({ type: 'import', importId: row.id })
}

/** Each row and checkpoint are atomic; duplicate queue deliveries serialize here. */
export async function executeQueuedImport(importId: string) {
  z.string().min(1).parse(importId)
  const films = await import('./film-imports')
  const albums = await import('./album-imports')
  const { queueMediaEnrichment } = await import('./film-enrichment')
  let preview: typeof filmImportPreview.$inferSelect | undefined
  for (let processed = 0; processed < 20; processed++) {
    const complete = await db.transaction(async (tx) => {
      const [run] = await tx
        .select()
        .from(libraryImport)
        .where(eq(libraryImport.id, importId))
        .for('update')
      if (!run || !['queued', 'running'].includes(run.status)) return true
      const parsed = QueuedImportResultSchema.safeParse(run.result)
      if (!parsed.success) {
        await tx
          .update(libraryImport)
          .set({
            status: 'failed',
            stage: 'Failed',
            errorMessage: 'Stored import task is invalid. Preview again.',
            finishedAt: new Date(),
          })
          .where(eq(libraryImport.id, importId))
        return true
      }
      const state = parsed.data
      const { task } = state
      const row = task.rows[state.cursor]
      if (row !== undefined) {
        if (!preview) {
          const [stored] = await tx
            .select()
            .from(filmImportPreview)
            .where(eq(filmImportPreview.id, task.previewId))
          preview = stored
        }
        if (
          !preview ||
          !preview.claimed ||
          preview.requestedByUserId !== run.requestedByUserId ||
          !(
            task.mediaType === 'film' ? ['csv'] : ['album-csv', 'spotify-saved']
          ).includes(preview.kind)
        ) {
          await tx
            .update(libraryImport)
            .set({
              status: 'failed',
              stage: 'Failed',
              errorMessage: 'Claimed preview unavailable. Preview again.',
              finishedAt: new Date(),
            })
            .where(eq(libraryImport.id, importId))
          return true
        }
        const records = preview.records
        try {
          // Savepoints keep a rejected record from aborting the checkpoint transaction.
          const outcome = await tx.transaction((recordTx) =>
            task.mediaType === 'film'
              ? films.commitQueuedFilmImportRow(records, row, recordTx)
              : albums.commitQueuedAlbumImportRow(records, row, recordTx),
          )
          if (outcome.action === 'new') {
            state.newIds.push(outcome.id)
            state.created++
          } else if (outcome.action === 'update') state.updated++
          else state.unchanged++
        } catch {
          state.failed++
          if (state.warnings.length < 20)
            state.warnings.push(
              `Row ${row + 1}: import failed; preview again and check identifiers`,
            )
        }
        state.cursor++
        state.albums = task.mediaType === 'album' ? state.created : 0
        state.films =
          task.mediaType === 'film' ? state.created + state.updated : 0
        await tx
          .update(libraryImport)
          .set({
            status: 'running',
            stage: `Importing ${task.mediaType}s`,
            processed: state.cursor,
            result: state,
          })
          .where(eq(libraryImport.id, importId))
        return false
      }
      const operations = state.newIds.flatMap((mediaItemId) =>
        task.providers.map((provider) => ({ mediaItemId, provider })),
      )
      const selected = operations.slice(
        state.enrichmentCursor,
        state.enrichmentCursor + 1,
      )
      if (selected.length) {
        // A previous delivery may have created a job before its checkpoint committed.
        // Include finished/failed jobs: replay must never implicitly retry provider work.
        const existing = await tx
          .select({
            mediaItemId: scrapeJobItem.mediaItemId,
            provider: scrapeJobItem.provider,
          })
          .from(scrapeJobItem)
          .innerJoin(scrapeJob, eq(scrapeJob.id, scrapeJobItem.jobId))
          .where(
            and(
              sql`${scrapeJob.options}->>'batchId' = ${task.previewId}`,
              inArray(
                scrapeJobItem.mediaItemId,
                selected.map((pair) => pair.mediaItemId),
              ),
            ),
          )
        const remaining = selected.filter(
          (pair) =>
            !existing.some(
              (job) =>
                job.mediaItemId === pair.mediaItemId &&
                job.provider === pair.provider,
            ),
        )
        let queued = { queued: 0, skipped: 0, warnings: new Array<string>() }
        try {
          if (remaining.length)
            queued = await queueMediaEnrichment(
              remaining,
              run.requestedByUserId,
              {
                batchId: task.previewId,
                missingOnly: true,
                confirmBroadRun: task.confirmBroadRun,
                mediaType: task.mediaType,
              },
            )
        } catch (error) {
          if (!(error instanceof ServerError)) throw error
          queued = {
            queued: 0,
            skipped: remaining.length,
            warnings: [
              'Selected metadata providers are unavailable. Review provider configuration and start metadata jobs explicitly.',
            ],
          }
        }
        state.enrichmentCursor += selected.length
        state.queuedJobs += queued.queued + selected.length - remaining.length
        state.skippedJobs += queued.skipped
        state.warnings = [...state.warnings, ...queued.warnings].slice(0, 20)
        await tx
          .update(libraryImport)
          .set({ stage: 'Queueing selected metadata', result: state })
          .where(eq(libraryImport.id, importId))
        return false
      }
      await tx
        .update(libraryImport)
        .set({
          status: state.failed ? 'failed' : 'succeeded',
          stage: state.failed ? 'Completed with errors' : 'Complete',
          errorMessage: state.failed
            ? `${state.failed} records failed; see import warnings.`
            : null,
          result: {
            ...state,
            skipped: task.mediaType === 'album' ? state.unchanged : 0,
            jobBatchId: task.previewId,
          },
          finishedAt: new Date(),
        })
        .where(eq(libraryImport.id, importId))
      return true
    })
    if (complete) return
  }
  const queue = cloudQueue()
  if (!queue) throw new Error('The durable import queue is unavailable')
  await queue.send({ type: 'import', importId })
}

export async function listSavedViews() {
  const [snapshot] = await db
    .select()
    .from(providerSnapshot)
    .where(eq(providerSnapshot.provider, 'legacy-smart-playlists'))
    .orderBy(desc(providerSnapshot.createdAt))
    .limit(1)
  if (!snapshot) return []
  return z
    .array(JsonValueSchema)
    .parse(snapshot.payload)
    .map(normalizeSavedView)
}
