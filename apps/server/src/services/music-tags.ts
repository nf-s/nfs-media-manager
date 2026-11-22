import { sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import type { TagLevel } from '@repo/schemas/browse'
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

/** Album-library tag IDs a filter on `name` matches: the tag, its aliases and its visible subtags. */
export function matchingTagIds(name: string): SQL {
  return sql`select t.id from tag t where t.media_type = 'album'
    and ${normalizedTagSql(sql`t.name`)} in (${matchingTagNames(name, 'album')})`
}

/**
 * TTAG-20 to TTAG-22: library tracks whose tags at `levels` include the tag
 * or a visible subtag, as one set of track IDs with the tag set resolved once.
 * Without levels (Auto, TTAG-21) a track is judged by its own tags, and by
 * its album's and artists' tags (the artists' when the album has fewer than
 * two) when it has none of its own or no verified Sonovault tag in Browse is
 * in the tag set. `has_own_tags` is stored, so that is never worked out here.
 */
export function trackIdsWithTag(
  name: string,
  levels: readonly TagLevel[] | undefined,
): SQL {
  const own = sql`select tt.media_item_id from track_tag tt
    where tt.in_browse and tt.tag_id = any(array(select id from location_tags))`
  const albums = sql`select mt.media_item_id from media_item_tag mt
    where mt.tag_id = any(array(select id from location_tags))`
  const artists = sql`select media_item_id from (${mediaIdsWithArtistTag(name)}) artist_items`
  const sets: SQL[] = []
  if (!levels) {
    // A track with tags of its own inherits only tags Sonovault does not use.
    const inherits = sql`(not lt.has_own_tags or not exists (
      select 1 from track_tag sonovault_tag where sonovault_tag.in_browse
        and sonovault_tag.sonovault and sonovault_tag.tag_id = any(array(select id from location_tags))))`
    sets.push(
      own,
      sql`select lt.media_item_id from library_track lt
        where lt.album_media_item_id in (${albums}) and ${inherits}`,
      sql`select lt.media_item_id from library_track lt
        where lt.media_item_id in (${artists}) and ${inherits}
          and (lt.album_media_item_id is null
            or lt.album_media_item_id not in (${albumsWithEnoughTags()}))`,
    )
  } else {
    if (levels.includes('track')) sets.push(own)
    if (levels.includes('album'))
      sets.push(sql`select lt.media_item_id from library_track lt
        where lt.album_media_item_id in (${albums})`)
    if (levels.includes('artist')) sets.push(artists)
  }
  // An array of the IDs lets each membership read the tag's index entries.
  return sql`with location_tags as materialized (${matchingTagIds(name)})
    ${sql.join(sets, sql` union all `)}`
}

/**
 * TTAG-23: albums whose tags at `levels` include the tag or a visible subtag.
 * Track is an album with a library track carrying the tag itself.
 */
export function albumIdsWithTag(name: string, levels: readonly TagLevel[]) {
  const sets: SQL[] = []
  if (levels.includes('track'))
    sets.push(sql`select lt.album_media_item_id from library_track lt
      where lt.album_media_item_id is not null and lt.media_item_id in (
        select tt.media_item_id from track_tag tt
        where tt.in_browse and tt.tag_id = any(array(select id from location_tags)))`)
  if (levels.includes('album'))
    sets.push(sql`select mt.media_item_id from media_item_tag mt
      where mt.tag_id = any(array(select id from location_tags))`)
  if (levels.includes('artist'))
    sets.push(
      sql`select media_item_id from (${mediaIdsWithArtistTag(name)}) artist_items`,
    )
  return sql`with location_tags as materialized (${matchingTagIds(name)})
    ${sql.join(sets, sql` union all `)}`
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

function profileTagRows(profiles: SQL, includeEvidence = false): SQL {
  return sql`select p.artist_id, provider_tag.name
    ${
      includeEvidence
        ? sql`, provider_tag.position, s.id as snapshot_id, s.provider,
            s.scrape_job_id, s.normalized_data->>'url' as url,
            s.normalized_data->'tagReleaseSupport' as tag_release_support`
        : sql``
    }
    from (${profiles}) p
    join artist_provider_snapshot s on s.id = p.latest_snapshot_id
    cross join lateral jsonb_array_elements_text(s.normalized_data->'tags')
      ${includeEvidence ? sql`with ordinality provider_tag(name, position)` : sql`provider_tag(name)`}`
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

export function artistTagLabels(): SQL {
  return projectedArtistTags(currentArtistProfiles)
}

export function artistTagMemberships(mediaType: 'album' | 'track'): SQL {
  return sql`select c.media_item_id, artist_tag.name, artist_tag.name_key
    from (${artistTagLabels()}) artist_tag
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

export function releaseTagMemberships(albumId?: SQL): SQL {
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
export function firstMusicTagRows(
  mediaType: 'album' | 'track',
  /** Limits Tracks to the library tracks it holds for (alias `lt`). */
  tracks: SQL = sql`true`,
): SQL {
  // A track's first tag is its album's first, or its artists' first when the
  // album has too few tags. Read each album's first tag once, not per track.
  if (mediaType === 'track')
    return sql`with album_firsts as materialized (
        select media_item_id, min(name) as name, count(*) as tags
        from (${releaseTagMemberships()}) r group by media_item_id
      ), artist_firsts as (
        select a.media_item_id, min(a.name) as name from (${artistTagMemberships('track')}) a
        join library_track lt on lt.media_item_id = a.media_item_id
        where ${tracks} and (lt.album_media_item_id is null or lt.album_media_item_id not in (
          select media_item_id from album_firsts where tags >= ${artistTagFallbackThreshold}))
        group by a.media_item_id
      )
      select lt.media_item_id, least(album.name, artist.name) as name
      from library_track lt
      left join album_firsts album on album.media_item_id = lt.album_media_item_id
      left join artist_firsts artist on artist.media_item_id = lt.media_item_id
      where ${tracks} and (album.name is not null or artist.name is not null)`
  const releaseRows = releaseTagMemberships()
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

const ArtistTagEvidenceSchema = z.object({
  artistId: z.string(),
  artistName: z.string(),
  provider: z.string(),
  rawName: z.string(),
  snapshotId: z.string(),
  jobId: z.string().nullable(),
  url: z.string().nullable(),
  releaseSupport: z.unknown(),
})

export async function loadArtistTagEvidence(
  scope: { artistId: string } | { mediaId: string },
  name: string,
  page: number,
  size: number,
) {
  const directArtist = 'artistId' in scope
  const profiles = directArtist
    ? sql`${currentArtistProfiles} where state.artist_id = ${scope.artistId}`
    : sql`${currentArtistProfiles}
      join media_credit c on c.artist_id = state.artist_id and c.role = 'artist'
      where c.media_item_id = ${scope.mediaId}`
  const rawKey = sql`profile_label.key`
  const displayKey = directArtist
    ? rawKey
    : normalizedTagSql(sql`coalesce(canonical.name, e.name)`)
  const canonical = directArtist
    ? sql``
    : sql`left join lateral (
        select min(name) as name, bool_or(hidden) as hidden
        from (${canonicalTagRows('album', rawKey)}) matching
      ) canonical on true`
  const visible = directArtist
    ? sql``
    : sql`and not coalesce(canonical.hidden, false)`
  const rows = await db.execute(sql`
    with matches as materialized (
      select distinct on (e.artist_id, e.snapshot_id, ${rawKey})
        e.artist_id as "artistId", a.name as "artistName",
        e.provider, e.name as "rawName", e.snapshot_id as "snapshotId",
        e.scrape_job_id as "jobId", e.url, support.tag as "releaseSupport"
      from (${profileTagRows(profiles, true)}) e
      join artist a on a.id = e.artist_id
      cross join lateral (select ${normalizedTagSql(sql`e.name`)} as key) profile_label
      left join lateral (
        select tag
        from jsonb_array_elements(
          case when jsonb_typeof(e.tag_release_support) = 'array'
            then e.tag_release_support else '[]'::jsonb end
        ) support(tag)
        where ${normalizedTagSql(sql`tag->>'name'`)} = ${rawKey}
        limit 1
      ) support on true
      ${canonical}
      where ${displayKey} = ${name} ${visible}
      order by e.artist_id, e.snapshot_id, ${rawKey}, e.position
    )
    select (select count(*)::int from matches) as "totalCount",
      coalesce((select jsonb_agg(e) from (
        select * from matches
        order by provider, "artistName", "artistId", "rawName", "snapshotId"
        limit ${size} offset ${(page - 1) * size}
      ) e), '[]'::jsonb) as items
  `)
  const [evidence] = z
    .tuple([
      z.object({
        totalCount: z.number().int().nonnegative(),
        items: z.array(ArtistTagEvidenceSchema),
      }),
    ])
    .parse(rows.rows)
  return evidence
}
