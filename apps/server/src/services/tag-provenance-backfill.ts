import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm'
import { checksumJson } from '@/lib/media-utils'
import {
  BackfillMembershipSchema,
  BackfillOccurrenceSchema,
  BackfillSnapshotSchema,
  planTagProvenanceBackfill,
} from '@/lib/tag-provenance-backfill'
import {
  mediaItem,
  mediaItemTag,
  externalLink,
  providerReference,
  providerSnapshot,
  tag,
  tagOccurrence,
} from '@/schemas/db'
import {
  lockTagWrites,
  normalizeTagName,
  normalizedTagSql,
  type TagDatabase,
} from '@/services/tag-state'

export type TagBackfillScope = { mediaType: 'album' | 'film'; name?: string }

export async function auditTagProvenance(
  database: TagDatabase,
  scope: TagBackfillScope,
) {
  const report: ReturnType<typeof planTagProvenanceBackfill> = {
    scannedMemberships: 0,
    missingMemberships: 0,
    alreadyPresent: 0,
    additions: [],
    unresolved: [],
  }
  let cursor: string | undefined
  let snapshotsScanned = 0
  for (;;) {
    const media = await database
      .select({ id: mediaItem.id })
      .from(mediaItem)
      .where(
        and(
          eq(mediaItem.mediaType, scope.mediaType),
          cursor ? gt(mediaItem.id, cursor) : undefined,
        ),
      )
      .orderBy(asc(mediaItem.id))
      .limit(100)
    if (!media.length) break
    cursor = media.at(-1)?.id
    const ids = media.map((row) => row.id)
    const memberships = BackfillMembershipSchema.array().parse(
      await database
        .select({
          mediaItemId: mediaItemTag.mediaItemId,
          tagId: tag.id,
          mediaType: tag.mediaType,
          name: tag.name,
          kind: tag.kind,
        })
        .from(mediaItemTag)
        .innerJoin(tag, eq(tag.id, mediaItemTag.tagId))
        .where(
          and(
            inArray(mediaItemTag.mediaItemId, ids),
            eq(tag.mediaType, scope.mediaType),
            scope.name
              ? eq(
                  normalizedTagSql(sql`${tag.name}`),
                  normalizeTagName(scope.name),
                )
              : undefined,
          ),
        )
        .orderBy(asc(mediaItemTag.mediaItemId), asc(tag.id)),
    )
    if (!memberships.length) continue
    const memberIds = [...new Set(memberships.map((row) => row.mediaItemId))]
    const occurrences = BackfillOccurrenceSchema.array().parse(
      await database
        .select()
        .from(tagOccurrence)
        .where(inArray(tagOccurrence.mediaItemId, memberIds))
        .orderBy(asc(tagOccurrence.id)),
    )
    const snapshots = BackfillSnapshotSchema.array().parse(
      await database
        .select({
          id: providerSnapshot.id,
          mediaItemId: providerSnapshot.mediaItemId,
          mediaType: mediaItem.mediaType,
          provider: providerSnapshot.provider,
          checksum: providerSnapshot.checksum,
          source: providerSnapshot.source,
          payload: providerSnapshot.payload,
          normalizedData: providerSnapshot.normalizedData,
        })
        .from(providerSnapshot)
        .innerJoin(mediaItem, eq(mediaItem.id, providerSnapshot.mediaItemId))
        .where(
          and(
            inArray(providerSnapshot.mediaItemId, memberIds),
            eq(mediaItem.mediaType, scope.mediaType),
          ),
        )
        .orderBy(asc(providerSnapshot.id)),
    )
    snapshotsScanned += snapshots.length
    const links = await database
      .select({
        mediaItemId: externalLink.mediaItemId,
        provider: externalLink.provider,
        url: externalLink.url,
      })
      .from(externalLink)
      .where(inArray(externalLink.mediaItemId, memberIds))
      .orderBy(asc(externalLink.id))
    const references = await database
      .select({
        mediaItemId: providerReference.mediaItemId,
        referenceType: providerReference.referenceType,
        externalId: providerReference.externalId,
      })
      .from(providerReference)
      .where(inArray(providerReference.mediaItemId, memberIds))
      .orderBy(asc(providerReference.id))
    const batch = planTagProvenanceBackfill({
      memberships,
      occurrences,
      snapshots,
      links,
      references,
    })
    report.scannedMemberships += batch.scannedMemberships
    report.missingMemberships += batch.missingMemberships
    report.alreadyPresent += batch.alreadyPresent
    report.additions.push(...batch.additions)
    report.unresolved.push(...batch.unresolved)
  }
  return {
    scope,
    snapshotsScanned,
    ...report,
    review: checksumJson({ scope, snapshotsScanned, ...report }),
  }
}

export async function applyTagProvenanceBackfill(
  database: TagDatabase,
  scope: TagBackfillScope,
  review: string,
) {
  await lockTagWrites(database)
  const report = await auditTagProvenance(database, scope)
  if (report.review !== review)
    throw new Error(
      'Dry-run evidence changed; review a fresh dry run before applying.',
    )
  let inserted = 0
  for (const { occurrence } of report.additions) {
    const rows = await database
      .insert(tagOccurrence)
      .values(occurrence)
      .onConflictDoNothing()
      .returning({ id: tagOccurrence.id })
    if (rows.length !== 1)
      throw new Error(
        'Occurrence changed during backfill; transaction must roll back.',
      )
    inserted += rows.length
  }
  return { ...report, inserted }
}
