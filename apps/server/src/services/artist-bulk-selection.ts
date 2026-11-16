import { and, asc, eq, gt, inArray, lte, sql } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import type {
  ArtistSelectionSnapshot,
  ArtistSelectionSnapshotPage,
  ArtistSelectionSnapshotPageQuery,
} from '@repo/schemas/artist-selection'
import type { ArtistMetadataQuery } from '@repo/schemas/creators'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import { artistSelectionMember, artistSelectionSnapshot } from '@/schemas/db'
import { artistBrowseIdsQuery } from './artist-browse'

export async function createArtistSelectionSnapshot(
  query: ArtistMetadataQuery,
  userId: string,
): Promise<ArtistSelectionSnapshot> {
  const id = nanoid()
  const now = new Date()
  const expiresAt = new Date(now.getTime() + 3600000)
  return db.transaction(async (tx) => {
    await tx
      .delete(artistSelectionSnapshot)
      .where(
        and(
          eq(artistSelectionSnapshot.requestedByUserId, userId),
          lte(artistSelectionSnapshot.expiresAt, now),
        ),
      )
    await tx.insert(artistSelectionSnapshot).values({
      id,
      requestedByUserId: userId,
      expiresAt,
    })
    const inserted = await tx.execute(sql`
      insert into ${artistSelectionMember} (selection_id, artist_id)
      select ${id}, matched.id from (${artistBrowseIdsQuery(query)}) matched
    `)
    const totalCount = inserted.rowCount ?? 0
    await tx
      .update(artistSelectionSnapshot)
      .set({ totalCount })
      .where(eq(artistSelectionSnapshot.id, id))
    return { id, totalCount, expiresAt: expiresAt.toISOString() }
  })
}

export async function listArtistSelectionSnapshotPage(
  selectionId: string,
  { after, size, ids: requestedIds }: ArtistSelectionSnapshotPageQuery,
  userId: string,
): Promise<ArtistSelectionSnapshotPage> {
  const members = db
    .select({ artistId: artistSelectionMember.artistId })
    .from(artistSelectionMember)
    .where(
      and(
        eq(artistSelectionMember.selectionId, artistSelectionSnapshot.id),
        after === undefined
          ? undefined
          : gt(artistSelectionMember.artistId, after),
        requestedIds === undefined
          ? undefined
          : inArray(artistSelectionMember.artistId, requestedIds),
      ),
    )
    .orderBy(asc(artistSelectionMember.artistId))
    .limit(requestedIds?.length ?? size + 1)
    .as('members')
  const rows = await db
    .select({
      totalCount: artistSelectionSnapshot.totalCount,
      expiresAt: artistSelectionSnapshot.expiresAt,
      artistId: members.artistId,
    })
    .from(artistSelectionSnapshot)
    .leftJoinLateral(members, sql`true`)
    .where(
      and(
        eq(artistSelectionSnapshot.id, selectionId),
        eq(artistSelectionSnapshot.requestedByUserId, userId),
        gt(artistSelectionSnapshot.expiresAt, new Date()),
      ),
    )
    .orderBy(asc(members.artistId))
  const snapshot = rows[0]
  if (!snapshot)
    throw new ServerError({
      statusCode: 404,
      message: 'Artist selection expired or unavailable. Select artists again.',
    })

  const ids = rows.flatMap(({ artistId }) =>
    artistId === null ? [] : [artistId],
  )
  const page = requestedIds ? ids : ids.slice(0, size)
  return {
    ids: page,
    nextCursor:
      !requestedIds && ids.length > size ? (page.at(-1) ?? null) : null,
    totalCount: snapshot.totalCount,
    expiresAt: snapshot.expiresAt.toISOString(),
  }
}
