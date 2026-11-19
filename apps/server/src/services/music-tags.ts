import { sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { artistTagFallbackThreshold } from '@repo/schemas/music-tags'
import { db } from '@/lib/db'
import { normalizedTagSql } from '@/lib/tag-sql'
import { descendantTagNames } from './tag-hierarchy'

function canonicalTagRows(
  mediaType: 'album' | 'film',
  normalizedName?: SQL,
): SQL {
  const originalName = normalizedTagSql(sql`original.name`)
  return sql`select i.normalized_name, target.name, target.hidden
    from tag_identity i join tag target on target.id = i.tag_id
    where i.media_type = ${mediaType} and target.media_type = ${mediaType}
    ${normalizedName ? sql`and i.normalized_name = ${normalizedName}` : sql``}
    union all
    select ${originalName} as normalized_name, target.name, target.hidden from tag original
    left join tag_alias a on a.source_tag_id = original.id
    join tag target on target.id = coalesce(a.target_tag_id, original.id)
    where original.media_type = ${mediaType} and target.media_type = ${mediaType}
    ${normalizedName ? sql`and ${originalName} = ${normalizedName}` : sql``}`
}

/**
 * Explicit filters still resolve stored aliases, including hidden groups, and
 * a tag also matches the visible tags beneath it in the hierarchy.
 */
export function matchingTagNames(
  name: string,
  mediaType: 'album' | 'film',
): SQL {
  return sql`with named(name) as (
      select ${name}::text union
      select ${normalizedTagSql(sql`canonical.name`)} from (${canonicalTagRows(mediaType, sql`${name}`)}) canonical
    )
    select name from named
    union ${descendantTagNames(mediaType, sql`select name from named`)}`
}

const currentArtistProfiles = sql`select state.artist_id, state.latest_snapshot_id
  from artist_provider_current_state state`

function profileTagRows(profiles: SQL): SQL {
  return sql`select p.artist_id, provider_tag.name
    from (${profiles}) p
    join artist_provider_snapshot s on s.id = p.latest_snapshot_id
    cross join lateral jsonb_array_elements_text(s.normalized_data->'tags') provider_tag(name)`
}

/** Read artist evidence once per provider profile and resolve aliases once per label. */
function projectedArtistTags(profiles: SQL, includeHidden: boolean): SQL {
  return sql`with artist_labels as materialized (
    select distinct artist_id, name from (${profileTagRows(profiles)}) tags
  ), normalized_labels as materialized (
    select name, ${normalizedTagSql(sql`name`)} as normalized_name
    from (select distinct name from artist_labels) names
  ), album_labels as materialized (
    select l.normalized_name, min(canonical.name) as name,
      ${normalizedTagSql(sql`min(canonical.name)`)} as name_key, bool_or(canonical.hidden) as hidden
    from (select distinct normalized_name from normalized_labels where normalized_name <> '') l
    left join (${canonicalTagRows('album')}) canonical using (normalized_name)
    group by l.normalized_name
  )
  select a.artist_id, coalesce(l.name, a.name) as name,
    coalesce(l.name_key, n.normalized_name) as name_key
  from artist_labels a join normalized_labels n using (name)
  join album_labels l on l.normalized_name = n.normalized_name
  ${includeHidden ? sql`` : sql`where not coalesce(l.hidden, false)`}`
}

/** Artist evidence remains on its snapshot. Library reads apply album tag management. */
function artistTagRows(mediaId: SQL): SQL {
  const profiles = sql`${currentArtistProfiles}
    join media_credit c on c.artist_id = state.artist_id and c.role = 'artist'
    where c.media_item_id = ${mediaId}`
  const name = sql`coalesce(album_labels.name, artist_labels.name)`
  return sql`with artist_labels as materialized (
    select name, ${normalizedTagSql(sql`name`)} as normalized_name
    from (${profileTagRows(profiles)}) tags
  ), album_labels as (
    select l.normalized_name, min(canonical.name) as name, bool_or(canonical.hidden) as hidden
    from (select distinct normalized_name from artist_labels where normalized_name <> '') l
    left join lateral (${canonicalTagRows('album', sql`l.normalized_name`)}) canonical on true
    group by l.normalized_name
  )
  select min(${name}) as name, ${normalizedTagSql(name)} as name_key
  from artist_labels join album_labels using (normalized_name)
  where not coalesce(album_labels.hidden, false)
  group by name_key`
}

export function artistTagMemberships(
  mediaType: 'album' | 'track',
  includeHidden = false,
): SQL {
  return sql`select c.media_item_id, artist_tag.name, artist_tag.name_key
    from (${projectedArtistTags(currentArtistProfiles, includeHidden)}) artist_tag
    join media_credit c on c.artist_id = artist_tag.artist_id and c.role = 'artist'
    join media_item m on m.id = c.media_item_id and m.media_type = ${mediaType}`
}

export function firstArtistTag(mediaId: SQL): SQL {
  return sql`(select min(a.name) from (${artistTagRows(mediaId)}) a)`
}

export function artistTagsExpression(mediaId: SQL): SQL {
  return sql`coalesce((select jsonb_agg(a.name order by a.name) from (${artistTagRows(mediaId)}) a), '[]'::jsonb)`
}

function releaseTagMemberships(albumId?: SQL): SQL {
  const nameKey = normalizedTagSql(sql`t.name`)
  return sql`select mt.media_item_id, min(t.name) as name, ${nameKey} as name_key
    from media_item_tag mt join tag t on t.id = mt.tag_id
    where t.media_type = 'album' and not t.hidden and ${nameKey} <> ''
    ${albumId ? sql`and mt.media_item_id = ${albumId}` : sql``}
    group by mt.media_item_id, name_key`
}

export function albumsWithEnoughTags(): SQL {
  return sql`select media_item_id from (${releaseTagMemberships()}) release_tags
    group by media_item_id having count(*) >= ${artistTagFallbackThreshold}`
}

export function albumFirstTagRows(): SQL {
  return sql`with release_tags as materialized (${releaseTagMemberships()}), dense_albums as (
      select media_item_id from release_tags group by media_item_id
      having count(*) >= ${artistTagFallbackThreshold}
    ) select media_item_id, min(name) as name from (
      select media_item_id, name from release_tags
      union all
      select a.media_item_id, a.name from (${artistTagMemberships('album')}) a
      where a.media_item_id not in (select media_item_id from dense_albums)
        and not exists (select 1 from release_tags r
          where r.media_item_id = a.media_item_id and r.name_key = a.name_key)
    ) tags group by media_item_id`
}

export function sparseAlbumTags(albumId: SQL): SQL {
  return sql`(select count(*) from (
    ${releaseTagMemberships(albumId)} limit ${artistTagFallbackThreshold}
  ) release_tags) < ${artistTagFallbackThreshold}`
}

export function firstMusicTag(mediaId: SQL, albumId: SQL): SQL {
  return sql`(with release_tags as materialized (${releaseTagMemberships(albumId)})
    select min(t.name) from (
      select r.name from release_tags r
      union all select a.name from (${artistTagRows(mediaId)}) a
        where (select count(*) from release_tags) < ${artistTagFallbackThreshold}
          and not exists (select 1 from release_tags r where r.name_key = a.name_key)
    ) t)`
}

const MusicTagRowsSchema = z.array(
  z.object({ id: z.string(), tags: z.array(z.string()) }),
)

export async function loadArtistTags(
  mediaIds: string[],
): Promise<Map<string, string[]>> {
  if (!mediaIds.length) return new Map()
  const ids = sql`any(${sql.param(mediaIds)}::text[])`
  const profiles = sql`${currentArtistProfiles} where state.artist_id in (
    select c.artist_id from media_credit c where c.media_item_id = ${ids} and c.role = 'artist'
  )`
  const rows = MusicTagRowsSchema.parse(
    (
      await db.execute(sql`
    with item_tags as (
      select c.media_item_id, min(a.name) as name
      from (${projectedArtistTags(profiles, false)}) a
      join media_credit c on c.artist_id = a.artist_id and c.role = 'artist'
      where c.media_item_id = ${ids}
      group by c.media_item_id, a.name_key
    )
    select m.id, coalesce(jsonb_agg(t.name order by t.name)
      filter (where t.name is not null), '[]'::jsonb) as tags
    from media_item m left join item_tags t on t.media_item_id = m.id
    where m.id = ${ids} group by m.id
  `)
    ).rows,
  )
  return new Map(rows.map((row) => [row.id, row.tags]))
}
