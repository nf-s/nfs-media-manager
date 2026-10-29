import { lstat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { nanoid } from 'nanoid'
import { and, eq, lt } from 'drizzle-orm'
import { z } from 'zod'
import {
  ConfirmFilmImportSchema,
  FilmImportPreviewSchema,
  FilmPreviewInputSchema,
} from '@repo/schemas/imports'
import { JsonValueSchema } from '@repo/schemas/common'
import { filmIdentificationStatus } from '@repo/schemas/browse'
import { db } from '@/lib/db'
import { env } from '@/env'
import { ServerError } from '@/lib/error'
import { jobErrorDetails, jobLogSecrets } from '@/lib/job-errors'
import { filmImportPreview } from '@/schemas/db'
import {
  collectFilmRecords,
  FilmImportCandidateSchema,
  commitFilmImportRecord,
  filmCandidateKeys,
  matchFilmCandidates,
  unidentifiedFilmId,
} from './file-imports'
import {
  queueFilmEnrichment,
  requireEnrichmentConfirmation,
  validateFilmProviders,
} from './film-enrichment'
import { startManagedImport } from './imports'
import { describeFilmImport, loadFilmImportState } from './film-import-changes'

const StoredCandidateSchema = FilmImportCandidateSchema.extend({
  action: z.enum(['new', 'update', 'unchanged']),
  changes: FilmImportPreviewSchema.shape.items.element.shape.changes,
})

export async function getNfoSource() {
  const path = env.SCAN_DIR?.trim() ? resolve(env.SCAN_DIR) : null
  try {
    const info = path ? await lstat(path) : null
    return { path, available: !!info?.isDirectory() && !info.isSymbolicLink() }
  } catch {
    return { path, available: false }
  }
}

export async function prepareFilmImport(
  input: z.infer<typeof FilmPreviewInputSchema>,
  userId: string | null,
) {
  const options = FilmPreviewInputSchema.parse(input)
  const source = options.kind === 'nfo' ? await getNfoSource() : null
  if (options.kind === 'nfo' && !source?.available)
    throw new ServerError({
      statusCode: 422,
      message:
        'The server NFO folder is not configured or available. Check SCAN_DIR and the mounted volume.',
    })
  if (
    options.kind === 'csv' &&
    (options.format === 'nfo' ||
      Buffer.byteLength(options.content) > 20 * 1024 * 1024)
  )
    throw new ServerError({
      statusCode: 422,
      message: 'Choose a CSV format and a file smaller than 20 MB',
    })
  const collected = await collectFilmRecords(
    {
      format: options.kind === 'nfo' ? 'nfo' : options.format,
      path: options.kind === 'nfo' ? (source?.path ?? '') : options.fileName,
      fullImport: true,
      limit: 3,
    },
    options.kind === 'csv' ? options.content : undefined,
  )
  if (collected.records.length >= 10000)
    throw new ServerError({
      statusCode: 422,
      message:
        'Preview exceeds 10,000 films. Use a smaller source; nothing was imported.',
    })
  const matches = await matchFilmCandidates(collected.records)
  const state = await loadFilmImportState([
    ...new Set(
      matches.flatMap((match) => (match.id && !match.error ? [match.id] : [])),
    ),
  ])
  const records: z.infer<typeof StoredCandidateSchema>[] = []
  const seen = new Set<string>()
  let existing = 0
  let skipped = collected.skipped
  const warnings = [...collected.warnings]
  for (const [index, record] of collected.records.entries()) {
    const match = matches[index]
    const identifiers = filmCandidateKeys(record)
    if (match?.id) identifiers.push(`film:${match.id}`)
    if (!identifiers.length) identifiers.push(unidentifiedFilmId(record))
    if (match?.error || identifiers.some((key) => seen.has(key))) {
      skipped++
      if (warnings.length < 20)
        warnings.push(
          `${record.result.normalized.mediaPatch?.title ?? 'Film'}: ${match?.error ?? 'duplicate row'}`,
        )
      continue
    }
    for (const key of identifiers) seen.add(key)
    if (match?.id) existing++
    if (options.kind === 'nfo' && match?.id) continue
    const changes = match?.id ? describeFilmImport(record, match.id, state) : []
    records.push({
      ...record,
      action: match?.id ? (changes.length ? 'update' : 'unchanged') : 'new',
      changes,
    })
  }
  const id = nanoid()
  const expiresAt = new Date(Date.now() + 3600000)
  await db
    .delete(filmImportPreview)
    .where(lt(filmImportPreview.expiresAt, new Date()))
  await db.insert(filmImportPreview).values({
    id,
    requestedByUserId: userId,
    kind: options.kind,
    source: options.kind === 'csv' ? options.fileName : (source?.path ?? ''),
    records: JsonValueSchema.parse(JSON.parse(JSON.stringify(records))),
    expiresAt,
  })
  return FilmImportPreviewSchema.parse({
    id,
    kind: options.kind,
    source: options.kind === 'csv' ? options.fileName : source?.path,
    expiresAt: expiresAt.toISOString(),
    existing,
    skipped,
    warnings,
    items: records.map((record, row) => ({
      row,
      action: record.action,
      changes: record.changes,
      needsIdentification:
        filmIdentificationStatus(record.result.normalized.references) ===
        'Needs ID',
      title: record.result.normalized.mediaPatch?.title ?? 'Untitled',
      identifiers: record.result.normalized.references.map(
        (ref) => `${ref.referenceType}: ${ref.externalId}`,
      ),
    })),
  })
}

export async function confirmFilmImport(
  input: z.infer<typeof ConfirmFilmImportSchema>,
  userId: string | null,
) {
  const options = ConfirmFilmImportSchema.parse(input)
  const [preview] = await db
    .select()
    .from(filmImportPreview)
    .where(eq(filmImportPreview.id, options.previewId))
  if (
    !preview ||
    preview.requestedByUserId !== userId ||
    preview.expiresAt < new Date()
  )
    throw new ServerError({
      statusCode: 422,
      message: 'Preview expired or unavailable. Preview the source again.',
    })
  const allRecords = z.array(StoredCandidateSchema).parse(preview.records)
  const rows = [...new Set(options.rows)]
  const records = rows.map((row) => allRecords[row])
  if (records.some((record) => !record))
    throw new ServerError({
      statusCode: 422,
      message: 'Selection does not match this preview',
    })
  const providers = [...new Set(options.providers)]
  await validateFilmProviders(providers)
  requireEnrichmentConfirmation(
    records.filter((record) => record?.action === 'new').length *
      providers.length,
    options.confirmBroadRun,
  )
  const [claimed] = await db
    .update(filmImportPreview)
    .set({ claimed: true })
    .where(
      and(
        eq(filmImportPreview.id, preview.id),
        eq(filmImportPreview.claimed, false),
      ),
    )
    .returning({ id: filmImportPreview.id })
  if (!claimed)
    throw new ServerError({
      statusCode: 409,
      message:
        'This preview has already been imported. Preview again for a new import.',
    })
  try {
    return await startManagedImport(
      userId,
      async (progress) => {
        const newIds: string[] = []
        const warnings: string[] = []
        let failed = 0
        let skipped = 0
        let updated = 0
        let unchanged = 0
        for (const [index, record] of records.entries()) {
          if (!record) continue
          try {
            const outcome = await commitFilmImportRecord(record, {
              newOnly: preview.kind === 'nfo',
              allowCreate: record.action === 'new',
            })
            if (outcome.action === 'new') newIds.push(outcome.id)
            else if (outcome.action === 'update') updated++
            else {
              unchanged++
              if (preview.kind === 'nfo') skipped++
            }
          } catch (error) {
            failed++
            if (warnings.length < 20)
              warnings.push(
                `${record.result.normalized.mediaPatch?.title ?? 'Film'}: ${jobErrorDetails(error, jobLogSecrets({})).message}`,
              )
          }
          await progress({
            stage: 'Importing films',
            processed: index + 1,
            total: records.length,
          })
        }
        const queued = await queueFilmEnrichment(
          newIds.flatMap((mediaItemId) =>
            providers.map((provider) => ({ mediaItemId, provider })),
          ),
          userId,
          {
            batchId: preview.id,
            missingOnly: true,
            confirmBroadRun: options.confirmBroadRun,
          },
          async (_queued, processed, total) =>
            progress({ stage: 'Queueing metadata', processed, total }),
        )
        return {
          albums: 0,
          films: newIds.length + updated,
          created: newIds.length,
          updated,
          unchanged,
          failed,
          skipped,
          warnings: [...warnings, ...queued.warnings],
          jobBatchId: preview.id,
          queuedJobs: queued.queued,
          skippedJobs: queued.skipped,
        }
      },
      'film',
    )
  } catch (error) {
    await db
      .update(filmImportPreview)
      .set({ claimed: false })
      .where(eq(filmImportPreview.id, preview.id))
    throw error
  }
}
