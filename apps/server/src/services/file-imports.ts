import { lstat, opendir, readFile } from 'node:fs/promises'
import { basename, extname, join, resolve } from 'node:path'
import { and, eq, inArray, sql } from 'drizzle-orm'
import Papa from 'papaparse'
import { z } from 'zod'
import {
  FileImportSchema,
  FileImportFormatSchema,
  type FilmImportPreview,
} from '@repo/schemas/imports'
import { PluginResultSchema } from '@repo/media-plugin-sdk'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import { createStableId, slugifyParts } from '@/lib/media-utils'
import { normalizeImdbCsv, normalizeNfo } from '@/lib/film-file-normalizers'
import { listLoadedScrapePlugins } from '@/plugins/registry'
import { film, mediaItem, providerReference } from '@/schemas/db'
import { applyProviderResultInTransaction } from './provider-state'
import { lockTagWrites } from './tag-state'
import {
  describeFilmImport,
  existingFilmImportResult,
  loadFilmImportState,
} from './film-import-changes'
import { startManagedImport } from './imports'

type FileInput = z.infer<typeof FileImportSchema>
export const FilmImportCandidateSchema = z.object({
  provider: z.string(),
  result: PluginResultSchema,
  source: z.string(),
})
export type FilmImportCandidate = z.infer<typeof FilmImportCandidateSchema>
export function unidentifiedFilmId(candidate: FilmImportCandidate) {
  return createStableId(
    'film',
    `unidentified:${candidate.provider}:${candidate.source}:${candidate.result.normalized.mediaPatch?.title}:${candidate.result.normalized.mediaPatch?.releaseDate ?? ''}`,
  )
}
type FileFormat = z.infer<typeof FileImportFormatSchema> & {
  requiredColumns: string[]
}
const builtins: FileFormat[] = [
  {
    id: 'imdb-ratings',
    label: 'IMDb ratings CSV',
    kind: 'csv',
    requiredColumns: ['Const', 'Title', 'Your Rating', 'Date Rated'],
  },
  {
    id: 'imdb-watchlist',
    label: 'IMDb watchlist CSV',
    kind: 'csv',
    requiredColumns: ['Const', 'Title', 'Created'],
  },
  { id: 'nfo', label: 'Film NFO folder', kind: 'nfo', requiredColumns: [] },
]

export async function listFileImportFormats(): Promise<FileFormat[]> {
  return [
    ...builtins,
    ...(await listLoadedScrapePlugins()).flatMap((plugin) =>
      plugin.importFileRecord
        ? (plugin.manifest.fileImports ?? []).map(
            (format): FileFormat => ({
              id: `${plugin.manifest.id}:${format.id}`,
              label: format.label,
              kind: 'csv',
              requiredColumns: format.requiredColumns,
            }),
          )
        : [],
    ),
  ]
}

export async function* nfoFiles(path: string): AsyncGenerator<string> {
  const rootInfo = await lstat(path)
  if (rootInfo.isSymbolicLink())
    throw new Error('Symlink input is not supported')
  if (rootInfo.isFile()) {
    if (extname(path).toLowerCase() !== '.nfo')
      throw new Error('Expected an NFO file')
    yield path
    return
  }
  if (!rootInfo.isDirectory()) throw new Error('Expected an NFO directory')
  const excluded = [
    '#recycle',
    '.orig.nfo',
    '@eadir',
    ...(process.env['SCAN_EXCLUDE'] ?? '').split(',').filter(Boolean),
  ].map((value) => value.toLowerCase())
  const queue = [{ path, depth: 0 }]
  let inspected = 0
  const started = Date.now()
  while (queue.length) {
    const current = queue.shift()
    if (!current) break
    const directory = await opendir(current.path)
    for await (const entry of directory) {
      if (++inspected > 200000 || Date.now() - started > 120000)
        throw new Error(
          'NFO scan safety limit reached; choose a smaller folder',
        )
      if (
        entry.isSymbolicLink() ||
        entry.name.startsWith('.') ||
        excluded.some((part) => entry.name.toLowerCase().includes(part))
      )
        continue
      const target = join(current.path, entry.name)
      if (entry.isDirectory() && current.depth < 20)
        queue.push({ path: target, depth: current.depth + 1 })
      else if (entry.isFile() && extname(entry.name).toLowerCase() === '.nfo')
        yield target
    }
  }
}

async function readLimited(path: string, limit: number) {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size > limit)
    throw new Error('Unsupported file or size limit exceeded')
  const content = await readFile(path, 'utf8')
  if (Buffer.byteLength(content) > limit)
    throw new Error('File size limit exceeded')
  return content
}

export async function readNfoFile(path: string) {
  const content = await readLimited(path, 2 * 1024 * 1024)
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error('Not a regular NFO file')
  return {
    content,
    result: normalizeNfo(content, {
      path: resolve(path),
      birthtimeMs: info.birthtimeMs,
    }),
  }
}

export async function collectFilmRecords(
  input: FileInput,
  uploadedContent?: string,
) {
  const records: FilmImportCandidate[] = []
  const warnings: string[] = []
  let skipped = 0
  const warning = (message: string) => {
    skipped++
    if (warnings.length < 20) warnings.push(message)
  }
  const maximum = input.fullImport ? 10000 : input.limit
  const format = (await listFileImportFormats()).find(
    (item) => item.id === input.format,
  )
  if (!format)
    throw new ServerError({ statusCode: 422, message: 'Unknown import format' })
  const path =
    uploadedContent === undefined ? resolve(input.path) : basename(input.path)
  try {
    if (format.kind === 'nfo') {
      let bytes = 0
      for await (const file of nfoFiles(path)) {
        try {
          const { content, result } = await readNfoFile(file)
          if (!result.normalized.filmPatch?.dateAdded && warnings.length < 20)
            warnings.push(
              `${basename(file)}: file creation timestamp unavailable; no NFO Added date inferred`,
            )
          bytes += Buffer.byteLength(content)
          if (bytes > 128 * 1024 * 1024)
            throw new ServerError({
              statusCode: 422,
              message:
                'Import exceeds memory safety limit; choose a smaller folder',
            })
          records.push({
            provider: 'nfo',
            result,
            source: file,
          })
        } catch (error) {
          if (error instanceof ServerError) throw error
          warning(`${basename(file)}: invalid movie XML or missing title`)
        }
        if (records.length >= maximum) break
      }
    } else {
      if (extname(path).toLowerCase() !== '.csv')
        throw new Error('Expected CSV file')
      const parsed = Papa.parse<unknown>(
        uploadedContent ?? (await readLimited(path, 20 * 1024 * 1024)),
        {
          header: true,
          skipEmptyLines: 'greedy',
          transformHeader: (header) => header.trim(),
        },
      )
      if (
        format.requiredColumns.some(
          (column) => !parsed.meta.fields?.includes(column),
        )
      )
        throw new ServerError({
          statusCode: 422,
          message: `CSV is missing columns: ${format.requiredColumns.filter((column) => !parsed.meta.fields?.includes(column)).join(', ')}`,
        })
      if (parsed.errors.length)
        throw new ServerError({
          statusCode: 422,
          message:
            'CSV structure is invalid; fix quoting or column counts before importing',
        })
      const [providerId, formatId] = input.format.split(':')
      const plugin = formatId
        ? (await listLoadedScrapePlugins()).find(
            (plugin) => plugin.manifest.id === providerId,
          )
        : null
      for (const [index, raw] of parsed.data.entries()) {
        const row = z.record(z.string(), z.string()).safeParse(raw)
        if (!row.success) {
          warning(`Row ${index + 2}: invalid fields`)
          continue
        }
        const result =
          input.format === 'imdb-ratings' || input.format === 'imdb-watchlist'
            ? normalizeImdbCsv(row.data, input.format)
            : plugin?.importFileRecord && formatId
              ? await plugin.importFileRecord({
                  format: formatId,
                  row: row.data,
                })
              : null
        if (!result) {
          warning(`Row ${index + 2}: unsupported title type or missing title`)
          continue
        }
        records.push({
          provider: plugin?.manifest.id ?? input.format,
          result: PluginResultSchema.parse(result),
          source: path,
        })
        if (records.length >= maximum) break
      }
    }
  } catch (error) {
    if (error instanceof ServerError) throw error
    throw new ServerError({
      statusCode: 422,
      message:
        'Cannot read this import source. Check the path, file format, permissions and mounted volume.',
    })
  }
  if (input.fullImport && records.length >= maximum)
    warnings.push(
      'Stopped at 10,000 records; import a smaller source to process more.',
    )
  return { records, skipped, warnings }
}

export async function previewFileImport(input: FileInput) {
  const result = await collectFilmRecords({
    ...FileImportSchema.parse(input),
    fullImport: false,
  })
  return {
    selected: result.records.length,
    skipped: result.skipped,
    warnings: result.warnings,
    samples: result.records.map((record) => ({
      title: record.result.normalized.mediaPatch?.title ?? 'Untitled',
      identifiers: record.result.normalized.references.map(
        (ref) => `${ref.referenceType}: ${ref.externalId}`,
      ),
      source:
        record.result.normalized.mediaPatch?.sourceLabel ?? record.provider,
    })),
  }
}

export function filmCandidateKeys(candidate: FilmImportCandidate) {
  return candidate.result.normalized.references.map(
    (ref) =>
      `${['imdb', 'tmdb'].includes(ref.referenceType) ? 'shared' : candidate.provider}:${ref.referenceType}:${ref.externalId}`,
  )
}

export async function matchFilmCandidates(
  candidates: FilmImportCandidate[],
  database: Pick<typeof db, 'select'> = db,
) {
  const keys = (candidate: FilmImportCandidate) =>
    candidate.result.normalized.references
  const externalIds = [
    ...new Set(
      candidates.flatMap((candidate) =>
        keys(candidate).map((ref) => ref.externalId),
      ),
    ),
  ]
  const matches = new Map<string, Array<{ id: string; hidden: boolean }>>()
  const fallbackIds = new Set<string>()
  for (let offset = 0; offset < candidates.length; offset += 1000) {
    const rows = await database
      .select({ id: mediaItem.id })
      .from(mediaItem)
      .where(
        inArray(
          mediaItem.id,
          candidates.slice(offset, offset + 1000).map(unidentifiedFilmId),
        ),
      )
    for (const row of rows) fallbackIds.add(row.id)
  }
  for (let offset = 0; offset < externalIds.length; offset += 1000) {
    const rows = await database
      .select({
        id: mediaItem.id,
        metadata: mediaItem.metadata,
        type: providerReference.referenceType,
        provider: providerReference.provider,
        externalId: providerReference.externalId,
      })
      .from(providerReference)
      .innerJoin(mediaItem, eq(mediaItem.id, providerReference.mediaItemId))
      .where(
        and(
          eq(mediaItem.mediaType, 'film'),
          inArray(
            providerReference.externalId,
            externalIds.slice(offset, offset + 1000),
          ),
        ),
      )
    for (const row of rows) {
      const key = `${['imdb', 'tmdb'].includes(row.type) ? 'shared' : row.provider}:${row.type}:${row.externalId}`
      matches.set(key, [
        ...(matches.get(key) ?? []),
        { id: row.id, hidden: row.metadata?.['legacyHidden'] === true },
      ])
    }
  }
  return candidates.map((candidate) => {
    const found = filmCandidateKeys(candidate).flatMap(
      (key) => matches.get(key) ?? [],
    )
    if (fallbackIds.has(unidentifiedFilmId(candidate)))
      found.push({ id: unidentifiedFilmId(candidate), hidden: false })
    const visible = found.filter((row) => !row.hidden)
    const ids = [
      ...new Set((visible.length ? visible : found).map((row) => row.id)),
    ]
    return {
      id: ids[0] ?? null,
      error:
        ids.length > 1
          ? 'Ambiguous film identifiers; resolve duplicates before importing'
          : null,
    }
  })
}

export async function commitFilmImportRecord(
  candidate: FilmImportCandidate,
  options: { newOnly?: boolean; allowCreate?: boolean } = {},
): Promise<{
  id: string
  action: FilmImportPreview['items'][number]['action']
  changes: FilmImportPreview['items'][number]['changes']
}> {
  const { result, provider, source } = candidate
  const refs = result.normalized.references.filter(
    (ref) => ref.referenceType === 'imdb' || ref.referenceType === 'tmdb',
  )
  const primary = refs.find((ref) => ref.referenceType === 'imdb') ?? refs[0]
  const title = result.normalized.mediaPatch?.title ?? 'Untitled'
  return db.transaction(async (tx) => {
    // Recheck and create atomically across file import entry points, including shared IDs.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext('film-file-import'))`,
    )
    if (result.normalized.tags.length > 0) await lockTagWrites(tx)
    const [match] = await matchFilmCandidates([candidate], tx)
    if (match?.error) throw new Error(match.error)
    if (!match?.id && options.allowCreate === false)
      throw new Error(
        'Film disappeared since preview; preview again before creating it',
      )
    const id =
      match?.id ??
      (primary
        ? createStableId(
            'film',
            `file:${primary.referenceType}:${primary.externalId}`,
          )
        : unidentifiedFilmId(candidate))
    const [inserted] = await tx
      .insert(mediaItem)
      .values({ id, mediaType: 'film', title, slug: slugifyParts(title, id) })
      .onConflictDoNothing()
      .returning({ id: mediaItem.id })
    await tx.insert(film).values({ mediaItemId: id }).onConflictDoNothing()
    await tx.execute(sql`select id from media_item where id = ${id} for update`)
    const state = inserted ? undefined : await loadFilmImportState([id], tx)
    const changes = state ? describeFilmImport(candidate, id, state) : []
    if (!inserted && (options.newOnly || changes.length === 0))
      return { id, action: 'unchanged', changes: [] }
    await applyProviderResultInTransaction(
      {
        mediaItemId: id,
        mediaType: 'film',
        provider,
        source: 'file-import',
        payload: { file: source, data: result.payload },
        normalized: state
          ? existingFilmImportResult(candidate, id, state).normalized
          : result.normalized,
      },
      tx,
    )
    return { id, action: inserted ? 'new' : 'update', changes }
  })
}

export async function importFilmRecord(
  candidate: FilmImportCandidate,
): Promise<string> {
  return (await commitFilmImportRecord(candidate)).id
}

export async function startFileImport(input: FileInput, userId: string | null) {
  const options = FileImportSchema.parse(input)
  const prepared = await collectFilmRecords(options)
  if (!prepared.records.length)
    throw new ServerError({
      statusCode: 422,
      message: prepared.warnings[0] ?? 'No film records found',
    })
  return startManagedImport(
    userId,
    async (progress) => {
      let films = 0
      let failed = 0
      for (const [index, candidate] of prepared.records.entries()) {
        try {
          await importFilmRecord(candidate)
          films++
        } catch {
          failed++
          if (prepared.warnings.length < 20)
            prepared.warnings.push(
              `${candidate.result.normalized.mediaPatch?.title ?? 'Film'}: import failed; check identifiers for conflicting matches`,
            )
        }
        await progress({
          stage: `Importing ${options.format}`,
          processed: index + 1,
          total: prepared.records.length,
        })
      }
      return {
        albums: 0,
        films,
        failed,
        skipped: prepared.skipped,
        warnings: prepared.warnings,
      }
    },
    'film',
  )
}
