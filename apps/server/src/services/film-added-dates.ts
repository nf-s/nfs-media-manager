import { and, eq, ne, or, isNull, gt, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { film, mediaOverride } from '@/schemas/db'
import { NFO_CREATION_SOURCE, type FilmAddedDate } from '@/lib/film-added-date'

type Database = Pick<typeof db, 'update'>

export async function recordFilmAddedDate(
  database: Database,
  id: string,
  candidate: FilmAddedDate,
) {
  // Old retained snapshots may still contain XML dateadded, which is not a file timestamp.
  if (candidate.dateAddedSource === 'NFO added date') return []
  return database
    .update(film)
    .set({
      dateAdded: new Date(candidate.dateAdded),
      dateAddedSource: candidate.dateAddedSource,
      updatedAt: film.updatedAt,
    })
    .where(
      and(
        eq(film.mediaItemId, id),
        candidate.dateAddedSource === NFO_CREATION_SOURCE
          ? or(
              isNull(film.dateAdded),
              ne(film.dateAdded, new Date(candidate.dateAdded)),
              sql`${film.dateAddedSource} is distinct from ${NFO_CREATION_SOURCE}`,
            )
          : and(
              sql`${film.dateAddedSource} is distinct from ${NFO_CREATION_SOURCE}`,
              or(
                isNull(film.dateAdded),
                gt(film.dateAdded, new Date(candidate.dateAdded)),
              ),
            ),
        sql`not exists (select 1 from ${mediaOverride} where ${mediaOverride.mediaItemId} = ${film.mediaItemId} and ${mediaOverride.field} = 'dateAdded')`,
      ),
    )
    .returning({ id: film.mediaItemId })
}
