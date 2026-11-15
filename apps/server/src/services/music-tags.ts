import { sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { artistTagFallbackThreshold } from '@repo/schemas/music-tags'
import { db } from '@/lib/db'
import { normalizedTagSql } from '@/lib/tag-sql'

function canonicalTagRows(name: SQL, mediaType: 'album' | 'film'): SQL {
  return sql`select target.name, target.hidden
    from tag_identity i join tag target on target.id = i.tag_id
    where i.media_type = ${mediaType} and target.media_type = ${mediaType}
      and i.normalized_name = ${name}
    union all
    select target.name, target.hidden from tag original
    left join tag_alias a on a.source_tag_id = original.id
    join tag target on target.id = coalesce(a.target_tag_id, original.id)
    where original.media_type = ${mediaType} and target.media_type = ${mediaType}
      and ${normalizedTagSql(sql`original.name`)} = ${name}`
}

/** Explicit filters still resolve stored aliases, including hidden groups. */
export function matchingTagNames(
  name: string,
  mediaType: 'album' | 'film',
): SQL {
  return sql`select ${name}::text union
    select ${normalizedTagSql(sql`canonical.name`)} from (${canonicalTagRows(sql`${name}`, mediaType)}) canonical`
}

const currentArtistProfiles = sql`select state.artist_id, state.latest_snapshot_id
  from artist_provider_current_state state`

/** Read artist evidence once per provider profile and resolve aliases once per label. */
function projectedArtistTags(profiles: SQL, includeHidden: boolean): SQL {
  return sql`with artist_labels as materialized (
    select p.artist_id, provider_tag.name, ${normalizedTagSql(sql`provider_tag.name`)} as normalized_name
    from (${profiles}) p
    join artist_provider_snapshot s on s.id = p.latest_snapshot_id
    cross join lateral jsonb_array_elements_text(s.normalized_data->'tags') provider_tag(name)
  ), album_labels as (
    select l.normalized_name, min(canonical.name) as name, bool_or(canonical.hidden) as hidden
    from (select distinct normalized_name from artist_labels where normalized_name <> '') l
    left join lateral (${canonicalTagRows(sql`l.normalized_name`, 'album')}) canonical on true
    group by l.normalized_name
  )
  select a.artist_id, coalesce(l.name, a.name) as name
  from artist_labels a join album_labels l using (normalized_name)
  ${includeHidden ? sql`` : sql`where not coalesce(l.hidden, false)`}`
}

/** Artist evidence remains on its snapshot. Library reads apply album tag management. */
function artistTagRows(mediaId: SQL): SQL {
  const profiles = sql`${currentArtistProfiles}
    join media_credit c on c.artist_id = state.artist_id and c.role = 'artist'
    where c.media_item_id = ${mediaId}`
  return sql`select min(v.name) as name from (${projectedArtistTags(profiles, false)}) v
    group by ${normalizedTagSql(sql`v.name`)}`
}

export function artistTagMemberships(includeHidden = false): SQL {
  return sql`select c.media_item_id, artist_tag.name
    from (${projectedArtistTags(currentArtistProfiles, includeHidden)}) artist_tag
    join media_credit c on c.artist_id = artist_tag.artist_id and c.role = 'artist'`
}

export function artistTagsExpression(mediaId: SQL): SQL {
  return sql`coalesce((select jsonb_agg(a.name order by a.name) from (${artistTagRows(mediaId)}) a), '[]'::jsonb)`
}

function albumTagRows(albumId: SQL): SQL {
  return sql`select min(t.name) as name from media_item_tag mt join tag t on t.id = mt.tag_id
    where mt.media_item_id = ${albumId} and t.media_type = 'album' and not t.hidden
      and ${normalizedTagSql(sql`t.name`)} <> ''
    group by ${normalizedTagSql(sql`t.name`)}`
}

export function sparseAlbumTags(albumId: SQL): SQL {
  return sql`(select count(*) from (
    ${albumTagRows(albumId)} limit ${artistTagFallbackThreshold}
  ) release_tags) < ${artistTagFallbackThreshold}`
}

function musicTagRows(mediaId: SQL, albumId: SQL): SQL {
  return sql`select r.name from (${albumTagRows(albumId)}) r
    union all select a.name from (${artistTagRows(mediaId)}) a where ${sparseAlbumTags(albumId)}
      and not exists (select 1 from (${albumTagRows(albumId)}) r
        where ${normalizedTagSql(sql`r.name`)} = ${normalizedTagSql(sql`a.name`)})`
}

export function musicTagsExpression(mediaId: SQL, albumId: SQL): SQL {
  return sql`coalesce((select jsonb_agg(t.name order by t.name) from (${musicTagRows(mediaId, albumId)}) t), '[]'::jsonb)`
}

const MusicTagRowsSchema = z.array(
  z.object({ id: z.string(), tags: z.array(z.string()) }),
)

export async function loadArtistTags(
  mediaIds: string[],
): Promise<Map<string, string[]>> {
  if (!mediaIds.length) return new Map()
  const rows = MusicTagRowsSchema.parse(
    (
      await db.execute(sql`
    select m.id, ${artistTagsExpression(sql`m.id`)} as tags from media_item m
    where m.id in (${sql.join(
      mediaIds.map((id) => sql`${id}`),
      sql`, `,
    )})
  `)
    ).rows,
  )
  return new Map(rows.map((row) => [row.id, row.tags]))
}
