import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { nanoid } from 'nanoid'
import { desc, eq, sql } from 'drizzle-orm'
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
import { findWorkspaceRootPath } from '@/lib/load-workspace-env'
import { ServerError } from '@/lib/error'
import {
  importMediaType,
  importMediaTypeExpression,
} from '@/lib/import-media-type'
import { libraryImport, providerSnapshot } from '@/schemas/db'
import { runLegacyImport } from '../../scripts/import-legacy'

const root = findWorkspaceRootPath(process.cwd()) ?? process.cwd()

export async function getImportStatus(
  input: z.input<typeof ImportStatusQuerySchema> = {},
) {
  const query = ImportStatusQuerySchema.parse(input)
  const paths = [
    resolve(root, env.LEGACY_SERVER_DATA_DIR, 'lib-music.json'),
    resolve(root, env.LEGACY_SERVER_DATA_DIR, 'lib.json'),
    resolve(root, 'apps/web/public/data/lib-music.json'),
    resolve(root, 'apps/web/public/data/lib-movie.json'),
  ]
  const sources = await Promise.all(
    paths.map(async (path, index) => {
      const name =
        ['Raw albums', 'Raw films', 'Current albums', 'Current films'][index] ??
        'Library'
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
  const options = StartImportSchema.parse(input)
  if (!(await getImportStatus()).sources.every((source) => source.available))
    throw new ServerError({
      statusCode: 422,
      message: 'One or more library files are missing',
    })
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
      .where(eq(libraryImport.status, 'running'))
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
