import { sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { artistTagFallbackThreshold } from '@repo/schemas/music-tags'
import { db } from '@/lib/db'
import { normalizedTagSql } from '@/lib/tag-sql'
import { descendantTagNames, tagAncestorKeys } from './tag-hierarchy'

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

/** Resolve the requested canonical labels back to raw profile keys before reading snapshots. */
export function mediaIdsWithArtistTag(name: string): SQL {
  const names = matchingTagNames(name, 'album')
  return sql`with wanted(key) as (${names}), targets as (
      select id from tag where media_type = 'album' and ${normalizedTagSql(sql`name`)} in (select key from wanted)
    ), candidates(key) as (
      select key from wanted union
      select normalized_name from tag_identity where media_type = 'album' and tag_id in (select id from targets) union
      select ${normalizedTagSql(sql`original.name`)} from tag_alias a join tag original on original.id = a.source_tag_id
      where original.media_type = 'album' and a.target_tag_id in (select id from targets)
    ), raw_keys(key) as (
      select c.key from candidates c where c.key <> '' and coalesce((
        select ${normalizedTagSql(sql`min(name)`)} from (${canonicalTagRows('album', sql`c.key`)}) labels
      ), c.key) in (select key from wanted)
    )
    select c.media_item_id from media_credit c where c.role = 'artist'
      and c.artist_id in (
        select state.artist_id from artist_provider_current_state state
        join artist_provider_snapshot s on s.id = state.latest_snapshot_id
        where artist_profile_tag_keys(s.normalized_data->'tags')
          && array(select key from raw_keys)
      )`
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
function projectedArtistTags(profiles: SQL, pageOnly = false): SQL {
  const canonical = pageOnly
    ? sql`left join lateral (${canonicalTagRows('album', sql`l.normalized_name`)}) canonical on true`
    : sql`left join (${canonicalTagRows('album')}) canonical using (normalized_name)`
  return sql`with artist_labels as materialized (
    select distinct artist_id, name from (${profileTagRows(profiles)}) tags
  ), normalized_labels as materialized (
    select name, ${normalizedTagSql(sql`name`)} as normalized_name
    from (select distinct name from artist_labels) names
  ), album_labels as materialized (
    select l.normalized_name, min(canonical.name) as name,
      ${normalizedTagSql(sql`min(canonical.name)`)} as name_key, bool_or(canonical.hidden) as hidden
    from (select distinct normalized_name from normalized_labels where normalized_name <> '') l
    ${canonical}
    group by l.normalized_name
  )
  select a.artist_id, coalesce(l.name, a.name) as name,
    coalesce(l.name_key, n.normalized_name) as name_key
  from artist_labels a join normalized_labels n using (name)
  join album_labels l on l.normalized_name = n.normalized_name
  where not coalesce(l.hidden, false)`
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

export function artistTagMemberships(mediaType: 'album' | 'track'): SQL {
  return sql`select c.media_item_id, artist_tag.name, artist_tag.name_key
    from (${projectedArtistTags(currentArtistProfiles)}) artist_tag
    join media_credit c on c.artist_id = artist_tag.artist_id and c.role = 'artist'
    join media_item m on m.id = c.media_item_id and m.media_type = ${mediaType}`
}

/** Resolve displayed tag keys and their ancestors before joining media credits. */
export function artistTagFacetKeys(mediaType: 'album' | 'track'): SQL {
  const profiles =
    mediaType === 'album'
      ? sql`${currentArtistProfiles} where state.artist_id in (
          select c.artist_id from media_credit c join media_item m on m.id = c.media_item_id
          where c.role = 'artist' and m.media_type = 'album'
            and m.metadata->>'legacyHidden' is distinct from 'true')`
      : currentArtistProfiles
  return sql`with projected as materialized (${projectedArtistTags(profiles)})
    select artist_id, name_key as value from projected
    union all
    select p.artist_id, a.ancestor_key from projected p
    join (${tagAncestorKeys('album')}) a on a.descendant_key = p.name_key`
}

export function firstArtistTag(mediaId: SQL): SQL {
  return sql`(select min(a.name) from (${artistTagRows(mediaId)}) a)`
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

/** First displayed tag for each item, retaining release labels on a duplicate. */
export function firstMusicTagRows(mediaType: 'album' | 'track'): SQL {
  const releaseRows =
    mediaType === 'track'
      ? sql`select lt.media_item_id, r.name, r.name_key from (${releaseTagMemberships()}) r
          join library_track lt on lt.album_media_item_id = r.media_item_id`
      : releaseTagMemberships()
  return sql`with item_release_tags as materialized (${releaseRows}),
    dense_items as (select media_item_id from item_release_tags group by media_item_id
      having count(*) >= ${artistTagFallbackThreshold})
    select media_item_id, min(name) as name from (
      select media_item_id, name from item_release_tags
      union all
      select a.media_item_id, a.name from (${artistTagMemberships(mediaType)}) a
      where a.media_item_id not in (select media_item_id from dense_items)
        and not exists (select 1 from item_release_tags r
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

/** Page-bounded tag hydration shared by Tracks and Albums. */
export function artistTagsForItems(ids: SQL): SQL {
  const profiles = sql`${currentArtistProfiles} where state.artist_id in (
    select c.artist_id from media_credit c where c.media_item_id = ${ids} and c.role = 'artist'
  )`
  return sql`select media_item_id, jsonb_agg(name order by name) as tags from (
      select c.media_item_id, min(a.name) as name
      from (${projectedArtistTags(profiles, true)}) a
      join media_credit c on c.artist_id = a.artist_id and c.role = 'artist'
      where c.media_item_id = ${ids}
      group by c.media_item_id, a.name_key
    ) labels group by media_item_id`
}

export async function loadArtistTags(
  mediaIds: string[],
): Promise<Map<string, string[]>> {
  if (!mediaIds.length) return new Map()
  const ids = sql`any(${sql.param(mediaIds)}::text[])`
  const rows = MusicTagRowsSchema.parse(
    (
      await db.execute(sql`select m.id, coalesce(t.tags, '[]'::jsonb) as tags
        from media_item m left join (${artistTagsForItems(ids)}) t on t.media_item_id = m.id
        where m.id = ${ids}`)
    ).rows,
  )
  return new Map(rows.map((row) => [row.id, row.tags]))
}
