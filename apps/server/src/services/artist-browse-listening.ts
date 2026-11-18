import { sql, type SQL } from 'drizzle-orm'
import type { ListeningFilter, ListeningPeriod } from '@repo/schemas/listening'
import { listeningCounts } from './browse-listening'

/**
 * Each artist's scrobbles in each period, one column per predicate, in one
 * grouped read: every scrobble linked to a library album or library track
 * credited to the artist, counted once, the count refreshArtistListeningTotals
 * stores for all time. Scrobbles are grouped by scrobbled name and album link
 * first, because every scrobble of a group has the same links; a group linked
 * through both its album and a track still counts once. Artists without
 * linked scrobbles in any period are absent.
 */
function artistListeningCounts(
  entries: { predicate: SQL; alias: string }[],
): SQL {
  const plays = entries.map((_, index) => sql.identifier(`plays_${index}`))
  // Only the group and its counts, so removing duplicates stays narrow.
  const linked = sql`credited.artist_id, plays.id, ${sql.join(
    plays.map((column) => sql`plays.${column}`),
    sql`, `,
  )}`
  return sql`(with plays as materialized (
      select row_number() over () as id, named.* from (
        select username, artist_key, track_key, album_media_item_id, ${sql.join(
          entries.map(
            (entry, index) =>
              sql`count(*) filter (where ${entry.predicate})::int as ${plays[index]}`,
          ),
          sql`, `,
        )}
        from lastfm_scrobble
        where ${sql.join(
          entries.map((entry) => entry.predicate),
          sql` or `,
        )}
        group by username, artist_key, track_key, album_media_item_id
      ) named
    ), credited as materialized (
      select c.media_item_id, c.artist_id, m.media_type
      from media_credit c join media_item m on m.id = c.media_item_id
      where c.role = 'artist' and m.media_type in ('album', 'track')
        and m.metadata->>'legacyHidden' is distinct from 'true'
    )
    select linked.artist_id, ${sql.join(
      entries.map(
        (entry, index) =>
          sql`sum(linked.${plays[index]})::int as ${sql.identifier(entry.alias)}`,
      ),
      sql`, `,
    )}
    from (
      select ${linked}
      from plays join credited
        on credited.media_item_id = plays.album_media_item_id
        and credited.media_type = 'album'
      union
      select ${linked}
      from plays join lastfm_track_link l on l.username = plays.username
        and l.artist_key = plays.artist_key and l.track_key = plays.track_key
      join credited on credited.media_item_id = l.track_media_item_id
        and credited.media_type = 'track'
    ) linked group by linked.artist_id) listening_counts`
}

/**
 * Artist listening rules and sort period. All requested periods share one
 * grouped read, joined to `a.id`; artists without linked scrobbles count as
 * zero.
 */
export function createArtistBrowseListening(
  filter: ListeningFilter | undefined,
  sortPeriod: ListeningPeriod | undefined,
  now = new Date(),
) {
  const requested = listeningCounts(filter, sortPeriod, now)
  if (!requested) return undefined
  return {
    join: sql`left join ${artistListeningCounts(requested.entries)}
      on listening_counts.artist_id = a.id`,
    condition: requested.condition,
    sort: requested.sort,
  }
}

export type ArtistBrowseListening = NonNullable<
  ReturnType<typeof createArtistBrowseListening>
>
