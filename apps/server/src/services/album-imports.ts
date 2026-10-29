import { nanoid } from 'nanoid'
import { and, eq, gt, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { FileImportFormatSchema } from '@repo/schemas/imports'
import { JsonValueSchema } from '@repo/media-plugin-sdk'
import {
  AlbumCsvPreviewInputSchema,
  AlbumImportPreviewSchema,
  ConfirmAlbumImportSchema,
  type AlbumImportPreview,
} from '@repo/schemas/album-imports'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import { parseOptionalDate, slugifyParts } from '@/lib/media-utils'
import {
  AlbumImportCandidateSchema,
  albumCandidateArtists,
  albumCandidateKeys,
  albumCandidateNameKey,
  albumImportId,
  albumNameKey,
  albumReferenceKey,
  collectAlbumCsv,
  type AlbumImportCandidate,
} from '@/lib/album-import-candidates'
import {
  album,
  artist,
  filmImportPreview,
  mediaCredit,
  mediaItem,
  providerReference,
} from '@/schemas/db'
import { applyProviderResultInTransaction } from './provider-state'
import {
  queueMediaEnrichment,
  requireEnrichmentConfirmation,
  validateMediaProviders,
} from './film-enrichment'
import { startManagedImport } from './imports'

const StoredCandidateSchema = AlbumImportCandidateSchema.extend({
  action: z.enum(['new', 'unchanged']),
})
const StoredPreviewSchema = z
  .object({
    mediaType: z.literal('album'),
    records: z.array(StoredCandidateSchema),
  })
  .strict()

export const albumImportFormats: z.infer<typeof FileImportFormatSchema>[] = [
  {
    id: 'album-csv',
    label: 'Albums (title, artist; optional spotify, upc, date)',
    kind: 'csv',
  },
  {
    id: 'upc-csv',
    label: 'UPC albums (title, artist, upc; optional date)',
    kind: 'csv',
  },
]

export async function matchAlbumCandidates(
  candidates: AlbumImportCandidate[],
  database: Pick<typeof db, 'select'> = db,
) {
  const byReference = new Map<string, Set<string>>()
  const byName = new Map<string, Set<string>>()
  const add = (map: Map<string, Set<string>>, key: string, id: string) => {
    const ids = map.get(key) ?? new Set<string>()
    ids.add(id)
    map.set(key, ids)
  }
  const referenceKeys = [...new Set(candidates.flatMap(albumCandidateKeys))]
  for (let offset = 0; offset < referenceKeys.length; offset += 500) {
    const keys = referenceKeys.slice(offset, offset + 500)
    const rows = await database
      .select({
        id: providerReference.mediaItemId,
        provider: providerReference.provider,
        type: providerReference.referenceType,
        externalId: providerReference.externalId,
      })
      .from(providerReference)
      .innerJoin(mediaItem, eq(mediaItem.id, providerReference.mediaItemId))
      .where(
        and(
          eq(mediaItem.mediaType, 'album'),
          sql`(
        case when ${providerReference.referenceType} = 'spotify' or (${providerReference.provider} = 'spotify' and ${providerReference.referenceType} = 'album') then 'spotify:' || ${providerReference.externalId}
        when ${providerReference.referenceType} in ('upc', 'ean') then 'barcode:' || lpad(${providerReference.externalId}, 14, '0') end
      ) in (${sql.join(
        keys.map((key) => sql`${key}`),
        sql`, `,
      )})`,
        ),
      )
    for (const row of rows) {
      const key = albumReferenceKey(row.provider, row.type, row.externalId)
      if (key) add(byReference, key, row.id)
    }
  }
  const titles = [
    ...new Set(
      candidates.map((record) =>
        albumNameKey(record.result.normalized.mediaPatch?.title ?? ''),
      ),
    ),
  ]
  for (let offset = 0; offset < titles.length; offset += 500) {
    const rows = await database
      .select({ id: mediaItem.id, title: mediaItem.title, artist: artist.name })
      .from(mediaItem)
      .innerJoin(mediaCredit, eq(mediaCredit.mediaItemId, mediaItem.id))
      .innerJoin(artist, eq(artist.id, mediaCredit.artistId))
      .where(
        and(
          eq(mediaItem.mediaType, 'album'),
          eq(mediaCredit.role, 'artist'),
          inArray(
            sql`lower(regexp_replace(trim(${mediaItem.title}), '[[:space:]]+', ' ', 'g'))`,
            titles.slice(offset, offset + 500),
          ),
        ),
      )
    const grouped = new Map<string, { title: string; artists: string[] }>()
    for (const row of rows) {
      const group = grouped.get(row.id) ?? { title: row.title, artists: [] }
      group.artists.push(albumNameKey(row.artist))
      grouped.set(row.id, group)
    }
    for (const [id, group] of grouped)
      add(
        byName,
        JSON.stringify([
          albumNameKey(group.title),
          [...new Set(group.artists)].sort(),
        ]),
        id,
      )
  }
  return candidates.map((candidate) => {
    const identified = new Set(
      albumCandidateKeys(candidate).flatMap((key) => [
        ...(byReference.get(key) ?? []),
      ]),
    )
    const found = identified.size
      ? identified
      : (byName.get(albumCandidateNameKey(candidate)) ?? new Set<string>())
    const ids = [...found]
    return {
      id: ids[0] ?? null,
      error:
        ids.length > 1
          ? 'Ambiguous album identity; resolve duplicates before importing'
          : null,
    }
  })
}

export async function prepareAlbumCandidates(
  collected: {
    records: AlbumImportCandidate[]
    skipped: number
    warnings: string[]
  },
  userId: string,
  options: {
    kind: 'csv' | 'spotify'
    source: string
    discovery?: AlbumImportPreview['discovery']
  },
) {
  if (collected.records.length >= 10000)
    throw new ServerError({
      statusCode: 422,
      message: 'Preview exceeds 9,999 albums',
    })
  const matches = await matchAlbumCandidates(collected.records)
  const records: z.infer<typeof StoredCandidateSchema>[] = []
  const seen = new Set<string>()
  const warnings = [...collected.warnings]
  let skipped = collected.skipped
  let existing = 0
  for (const [index, record] of collected.records.entries()) {
    const match = matches[index]
    const keys = [
      ...albumCandidateKeys(record),
      `name:${albumCandidateNameKey(record)}`,
    ]
    if (match?.id) keys.push(`id:${match.id}`)
    if (match?.error || keys.some((key) => seen.has(key))) {
      skipped++
      if (warnings.length < 20)
        warnings.push(
          `${record.result.normalized.mediaPatch?.title ?? 'Album'}: ${match?.error ?? 'duplicate row'}`,
        )
      continue
    }
    keys.forEach((key) => seen.add(key))
    if (match?.id) existing++
    records.push({ ...record, action: match?.id ? 'unchanged' : 'new' })
  }
  const id = nanoid()
  const expiresAt = new Date(Date.now() + 3600000)
  await db.insert(filmImportPreview).values({
    id,
    requestedByUserId: userId,
    kind: options.kind === 'csv' ? 'album-csv' : 'spotify-saved',
    source: options.source,
    records: JsonValueSchema.parse(
      JSON.parse(JSON.stringify({ mediaType: 'album', records })),
    ),
    expiresAt,
  })
  return AlbumImportPreviewSchema.parse({
    id,
    kind: options.kind,
    source: options.source,
    expiresAt: expiresAt.toISOString(),
    existing,
    skipped,
    warnings,
    discovery: options.discovery,
    items: records.map((record, row) => ({
      row,
      title: record.result.normalized.mediaPatch?.title ?? 'Untitled',
      dateAdded: record.result.normalized.albumPatch?.dateAdded ?? null,
      artists: albumCandidateArtists(record),
      identifiers: record.result.normalized.references.map(
        (ref) => `${ref.referenceType}: ${ref.externalId}`,
      ),
      action: record.action,
      needsIdentification: albumCandidateKeys(record).length === 0,
    })),
  })
}

export async function prepareAlbumCsv(
  input: z.infer<typeof AlbumCsvPreviewInputSchema>,
  userId: string,
) {
  const options = AlbumCsvPreviewInputSchema.parse(input)
  return prepareAlbumCandidates(collectAlbumCsv(options), userId, {
    kind: 'csv',
    source: options.fileName,
  })
}

export async function commitAlbumImportRecord(
  candidate: z.infer<typeof StoredCandidateSchema>,
) {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext('album-file-import'))`,
    )
    const [match] = await matchAlbumCandidates([candidate], tx)
    if (match?.error) throw new Error(match.error)
    if (match?.id) return { id: match.id, created: false }
    if (candidate.action !== 'new')
      throw new Error(
        'Album disappeared since preview; preview again before creating it',
      )
    const id = albumImportId(candidate)
    const patch = candidate.result.normalized.mediaPatch
    const title = patch?.title ?? 'Untitled'
    const [created] = await tx
      .insert(mediaItem)
      .values({
        id,
        mediaType: 'album',
        title,
        slug: slugifyParts(title, id),
        artworkUrl: patch?.artworkUrl,
        releaseDate: parseOptionalDate(patch?.releaseDate),
        sourceLabel: patch?.sourceLabel,
      })
      .onConflictDoNothing()
      .returning({ id: mediaItem.id })
    if (!created) return { id, created: false }
    await tx.insert(album).values({
      mediaItemId: id,
      dateAdded:
        parseOptionalDate(candidate.result.normalized.albumPatch?.dateAdded) ??
        new Date(),
    })
    await applyProviderResultInTransaction(
      {
        mediaItemId: id,
        mediaType: 'album',
        provider: candidate.provider,
        source: 'file-import',
        payload: { source: candidate.source, data: candidate.result.payload },
        normalized: candidate.result.normalized,
      },
      tx,
    )
    return { id, created: true }
  })
}

export async function confirmAlbumImport(
  input: z.infer<typeof ConfirmAlbumImportSchema>,
  userId: string,
) {
  const options = ConfirmAlbumImportSchema.parse(input)
  const [preview] = await db
    .select()
    .from(filmImportPreview)
    .where(
      and(
        eq(filmImportPreview.id, options.previewId),
        eq(filmImportPreview.requestedByUserId, userId),
        inArray(filmImportPreview.kind, ['album-csv', 'spotify-saved']),
        gt(filmImportPreview.expiresAt, new Date()),
      ),
    )
  if (!preview)
    throw new ServerError({
      statusCode: 422,
      message: 'Preview expired or unavailable. Preview again.',
    })
  const all = StoredPreviewSchema.parse(preview.records).records
  const records = [...new Set(options.rows)].map((row) => all[row])
  if (records.some((record) => !record))
    throw new ServerError({
      statusCode: 422,
      message: 'Selection does not match this preview',
    })
  const providers = [...new Set(options.providers)]
  await validateMediaProviders(providers, 'album')
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
        eq(filmImportPreview.requestedByUserId, userId),
        gt(filmImportPreview.expiresAt, new Date()),
      ),
    )
    .returning({ id: filmImportPreview.id })
  if (!claimed)
    throw new ServerError({
      statusCode: 409,
      message: 'Preview already used or expired. Preview again.',
    })
  try {
    return await startManagedImport(
      userId,
      async (progress) => {
        const newIds: string[] = []
        const warnings: string[] = []
        let unchanged = 0
        let failed = 0
        for (const [index, record] of records.entries()) {
          if (!record) continue
          try {
            const outcome = await commitAlbumImportRecord(record)
            if (outcome.created) newIds.push(outcome.id)
            else unchanged++
          } catch {
            failed++
            if (warnings.length < 20)
              warnings.push(
                `${record.result.normalized.mediaPatch?.title ?? 'Album'}: import failed; preview again and check identifiers`,
              )
          }
          await progress({
            stage: 'Importing albums',
            processed: index + 1,
            total: records.length,
          })
        }
        const queued =
          providers.length && newIds.length
            ? await queueMediaEnrichment(
                newIds.flatMap((mediaItemId) =>
                  providers.map((provider) => ({ mediaItemId, provider })),
                ),
                userId,
                {
                  batchId: preview.id,
                  missingOnly: true,
                  confirmBroadRun: options.confirmBroadRun,
                  mediaType: 'album',
                },
              )
            : { queued: 0, skipped: 0, warnings: [] }
        return {
          albums: newIds.length,
          films: 0,
          created: newIds.length,
          updated: 0,
          unchanged,
          skipped: unchanged,
          failed,
          warnings: [...warnings, ...queued.warnings],
          jobBatchId: preview.id,
          queuedJobs: queued.queued,
          skippedJobs: queued.skipped,
        }
      },
      'album',
    )
  } catch (error) {
    await db
      .update(filmImportPreview)
      .set({ claimed: false })
      .where(eq(filmImportPreview.id, preview.id))
    throw error
  }
}
