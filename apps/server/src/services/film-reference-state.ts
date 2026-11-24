import { and, eq, or, sql } from 'drizzle-orm'
import {
  ProviderItemAmbiguousError,
  type PluginReference,
} from '@repo/media-plugin-sdk'
import type { db } from '@/lib/db'
import { createStableId } from '@/lib/media-utils'
import { mediaItem, providerReference } from '@/schemas/db'

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

export async function lockFilmReferenceWrites(tx: Transaction) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext('film-file-import'))`,
  )
}

async function reviewMdblistFilmReferences(
  tx: Transaction,
  mediaItemId: string,
  references: PluginReference[],
) {
  const existing = await tx
    .select({
      mediaItemId: providerReference.mediaItemId,
      provider: providerReference.provider,
      referenceType: providerReference.referenceType,
      externalId: providerReference.externalId,
    })
    .from(providerReference)
    .innerJoin(mediaItem, eq(mediaItem.id, providerReference.mediaItemId))
    .where(
      and(
        eq(mediaItem.mediaType, 'film'),
        or(
          eq(mediaItem.id, mediaItemId),
          and(
            sql`${mediaItem.metadata}->>'legacyHidden' is distinct from 'true'`,
            or(
              ...references.map(({ referenceType, externalId }) =>
                and(
                  eq(providerReference.referenceType, referenceType),
                  eq(providerReference.externalId, externalId),
                ),
              ),
            ),
          ),
        ),
      ),
    )
  const hasAnchor = existing.some(
    (row) =>
      row.mediaItemId === mediaItemId &&
      ['imdb', 'tmdb'].includes(row.referenceType) &&
      references.some(
        (reference) =>
          reference.referenceType === row.referenceType &&
          reference.externalId === row.externalId,
      ),
  )
  const hasConflict = existing.some((row) =>
    references.some(
      (reference) =>
        row.referenceType === reference.referenceType &&
        (row.mediaItemId === mediaItemId
          ? row.externalId !== reference.externalId
          : row.externalId === reference.externalId),
    ),
  )
  if (!hasAnchor || hasConflict)
    throw new ProviderItemAmbiguousError(
      'MDBList identities conflict with the current film references. Review the match before refreshing.',
    )

  return references.filter(
    (reference) =>
      !existing.some(
        (row) =>
          row.mediaItemId === mediaItemId &&
          row.provider === 'mdblist' &&
          row.referenceType === reference.referenceType &&
          row.externalId === reference.externalId,
      ),
  )
}

/** Keep corroborating MDBList references traceable to the response that gave them. */
export async function saveMdblistFilmReferences(
  tx: Transaction,
  mediaItemId: string,
  references: PluginReference[],
) {
  const missing = await reviewMdblistFilmReferences(tx, mediaItemId, references)
  return insertMdblistFilmReferences(tx, [{ mediaItemId, missing }])
}

export async function insertMdblistFilmReferences(
  tx: Transaction,
  plans: { mediaItemId: string; missing: PluginReference[] }[],
) {
  const rows = plans.flatMap(({ mediaItemId, missing }) =>
    missing.map((reference) => ({
      ...reference,
      id: createStableId(
        'pref',
        `${mediaItemId}:mdblist:${reference.referenceType}:${reference.externalId}`,
      ),
      mediaItemId,
      provider: 'mdblist',
    })),
  )
  if (!rows.length) return []
  return tx
    .insert(providerReference)
    .values(rows)
    .onConflictDoNothing()
    .returning({ id: providerReference.id })
}
