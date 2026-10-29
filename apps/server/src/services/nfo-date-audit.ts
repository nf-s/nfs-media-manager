import { and, eq, inArray, or, sql } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { db } from '@/lib/db'
import { checksumJson } from '@/lib/media-utils'
import { NFO_CREATION_SOURCE } from '@/lib/film-added-date'
import {
  matchNfoFile,
  type NfoAuditFile,
  type NfoRootMapping,
} from '@/lib/nfo-audit-match'
import {
  film,
  mediaItem,
  mediaOverride,
  providerReference,
  providerReferenceOverride,
  providerSnapshot,
} from '@/schemas/db'
import { nfoFiles, readNfoFile } from './file-imports'
import { recordFilmAddedDate } from './film-added-dates'

async function effectiveNfoReferences(
  database: Pick<typeof db, 'select'>,
  id: string,
) {
  const references = await database
    .select()
    .from(providerReference)
    .where(
      and(
        eq(providerReference.mediaItemId, id),
        inArray(providerReference.referenceType, ['imdb', 'tmdb']),
      ),
    )
  const overrides = await database
    .select()
    .from(providerReferenceOverride)
    .where(
      and(
        eq(providerReferenceOverride.mediaItemId, id),
        inArray(providerReferenceOverride.referenceType, ['imdb', 'tmdb']),
      ),
    )
  const values = [
    ...references.filter(
      (ref) =>
        !overrides.some(
          (override) => override.referenceType === ref.referenceType,
        ),
    ),
    ...overrides,
  ]
  return [
    ...new Map(
      values.map(({ referenceType, externalId }) => [
        `${referenceType}:${externalId}`,
        { referenceType, externalId },
      ]),
    ).values(),
  ].sort((a, b) =>
    `${a.referenceType}:${a.externalId}`.localeCompare(
      `${b.referenceType}:${b.externalId}`,
    ),
  )
}

export async function auditNfoDates(root: string, mappings: NfoRootMapping[]) {
  const files: NfoAuditFile[] = []
  const fileErrors: Array<{ path: string; error: string }> = []
  for await (const path of nfoFiles(root)) {
    try {
      const { result } = await readNfoFile(path)
      files.push({
        path,
        createdAt: result.normalized.filmPatch?.dateAdded ?? null,
        references: result.normalized.references,
      })
    } catch (error) {
      fileErrors.push({
        path,
        error: error instanceof Error ? error.message : 'Unreadable NFO',
      })
    }
  }
  const rows = await db
    .select({
      id: mediaItem.id,
      title: mediaItem.title,
      metadata: mediaItem.metadata,
      dateAdded: film.dateAdded,
      dateAddedSource: film.dateAddedSource,
    })
    .from(film)
    .innerJoin(mediaItem, eq(mediaItem.id, film.mediaItemId))
    .where(
      or(
        eq(film.sourceKind, 'file'),
        sql`exists (select 1 from ${providerSnapshot} where ${providerSnapshot.mediaItemId} = ${film.mediaItemId} and (${providerSnapshot.provider} = 'nfo' or ${providerSnapshot.source} like 'legacy-import:%.nfo'))`,
      ),
    )
  const results = []
  for (const row of rows) {
    const snapshots = await db
      .select({
        source: providerSnapshot.source,
        path: sql<string | null>`${providerSnapshot.payload}->>'file'`,
      })
      .from(providerSnapshot)
      .where(
        and(
          eq(providerSnapshot.mediaItemId, row.id),
          inArray(providerSnapshot.provider, ['nfo', 'legacy-record']),
        ),
      )
    const effectiveReferences = await effectiveNfoReferences(db, row.id)
    const manual = await db
      .select({ id: mediaOverride.id })
      .from(mediaOverride)
      .where(
        and(
          eq(mediaOverride.mediaItemId, row.id),
          eq(mediaOverride.field, 'dateAdded'),
        ),
      )
    const nfo = row.metadata?.nfo
    const storedPath =
      nfo &&
      typeof nfo === 'object' &&
      !Array.isArray(nfo) &&
      typeof nfo.path === 'string'
        ? nfo.path
        : undefined
    const paths = [
      ...new Set(
        snapshots
          .flatMap((snapshot) => [
            ...(snapshot.path?.toLowerCase().endsWith('.nfo')
              ? [snapshot.path]
              : []),
            ...(snapshot.source.startsWith('legacy-import:') &&
            snapshot.source.toLowerCase().endsWith('.nfo')
              ? [snapshot.source.slice('legacy-import:'.length)]
              : []),
          ])
          .concat(storedPath ? [storedPath] : []),
      ),
    ]
    const match = matchNfoFile(paths, effectiveReferences, files, mappings)
    const candidate = match.file
    const replaceDate = Boolean(
      candidate?.createdAt &&
      !manual.length &&
      (!row.dateAdded ||
        row.dateAddedSource !== NFO_CREATION_SOURCE ||
        row.dateAdded.toISOString() !== candidate.createdAt),
    )
    const desiredNfo = candidate
      ? { path: candidate.path, createdAt: candidate.createdAt }
      : null
    results.push({
      id: row.id,
      title: row.title,
      paths,
      references: effectiveReferences.map(({ referenceType, externalId }) => ({
        referenceType,
        externalId,
      })),
      previousDate: row.dateAdded?.toISOString() ?? null,
      previousSource: row.dateAddedSource,
      previousNfo: nfo ?? null,
      nfo: desiredNfo,
      replaceDate,
      updatePath: Boolean(
        candidate && checksumJson(nfo ?? null) !== checksumJson(desiredNfo),
      ),
      reason: !candidate
        ? match.reason
        : !candidate.createdAt
          ? 'File creation time unavailable'
          : manual.length
            ? 'Manual date override preserved'
            : match.reason,
    })
  }
  return {
    root,
    mappings,
    filesScanned: files.length + fileErrors.length,
    validFiles: files.length,
    fileErrors,
    results,
  }
}

export type NfoDateAudit = Awaited<ReturnType<typeof auditNfoDates>>

export function summarizeNfoAudit(audit: NfoDateAudit) {
  return {
    filesScanned: audit.filesScanned,
    invalidFiles: audit.fileErrors.length,
    filmsAudited: audit.results.length,
    matched: audit.results.filter((row) => row.nfo).length,
    datesToRepair: audit.results.filter((row) => row.replaceDate).length,
    pathsToRepair: audit.results.filter((row) => row.updatePath).length,
    unresolved: audit.results.filter((row) => !row.nfo || !row.nfo.createdAt)
      .length,
    preservedManualDates: audit.results.filter((row) =>
      row.reason.endsWith('preserved'),
    ).length,
  }
}

// All changes and their before/after snapshots commit together; never queues scraping.
export async function applyNfoDateAudit(audit: NfoDateAudit) {
  for (const row of audit.results.filter(
    (item) => item.replaceDate || item.updatePath,
  )) {
    if (!row.nfo) continue
    const { result } = await readNfoFile(row.nfo.path)
    if (
      (result.normalized.filmPatch?.dateAdded ?? null) !== row.nfo.createdAt ||
      !matchNfoFile(
        [row.nfo.path],
        row.references,
        [
          {
            path: row.nfo.path,
            createdAt: row.nfo.createdAt,
            references: result.normalized.references,
          },
        ],
        [],
      ).file
    )
      throw new Error(`NFO changed since audit: ${row.nfo.path}`)
  }
  return db.transaction(async (tx) => {
    let datesRepaired = 0
    let pathsRepaired = 0
    for (const row of audit.results) {
      if (!row.nfo || (!row.replaceDate && !row.updatePath)) continue
      await tx.execute(
        sql`select id from ${mediaItem} where ${mediaItem.id} = ${row.id} for update`,
      )
      const [current] = await tx
        .select({
          metadata: mediaItem.metadata,
          dateAdded: film.dateAdded,
          dateAddedSource: film.dateAddedSource,
        })
        .from(film)
        .innerJoin(mediaItem, eq(mediaItem.id, film.mediaItemId))
        .where(eq(film.mediaItemId, row.id))
      if (
        !current ||
        (current.dateAdded?.toISOString() ?? null) !== row.previousDate ||
        current.dateAddedSource !== row.previousSource ||
        checksumJson(current.metadata?.nfo ?? null) !==
          checksumJson(row.previousNfo)
      )
        throw new Error(
          `Film changed since audit: ${row.id}; rerun the dry run`,
        )
      if (
        checksumJson(await effectiveNfoReferences(tx, row.id)) !==
        checksumJson(row.references)
      )
        throw new Error(
          `Film identifiers changed since audit: ${row.id}; rerun the dry run`,
        )
      const changed =
        row.replaceDate && row.nfo.createdAt
          ? await recordFilmAddedDate(tx, row.id, {
              dateAdded: row.nfo.createdAt,
              dateAddedSource: NFO_CREATION_SOURCE,
            })
          : []
      datesRepaired += changed.length
      if (row.updatePath) {
        await tx
          .update(mediaItem)
          .set({
            metadata: { ...current.metadata, nfo: row.nfo },
            updatedAt: mediaItem.updatedAt,
          })
          .where(eq(mediaItem.id, row.id))
        pathsRepaired++
      }
      if (changed.length || row.updatePath) {
        const payload = {
          operation: 'nfo-creation-date-repair',
          previous: {
            dateAdded: row.previousDate,
            dateAddedSource: row.previousSource,
            nfo: row.previousNfo,
          },
          next: {
            dateAdded: changed.length ? row.nfo.createdAt : row.previousDate,
            dateAddedSource: changed.length
              ? NFO_CREATION_SOURCE
              : row.previousSource,
            nfo: row.nfo,
          },
          match: row.reason,
        }
        await tx.insert(providerSnapshot).values({
          id: nanoid(),
          mediaItemId: row.id,
          provider: 'nfo',
          source: 'maintenance:nfo-birthtime',
          payload,
          checksum: checksumJson(payload),
        })
      }
    }
    return { datesRepaired, pathsRepaired }
  })
}
