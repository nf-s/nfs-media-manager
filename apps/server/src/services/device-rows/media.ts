import { sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { isSpotifyAudioFeatureKey } from '@repo/schemas/audio-features'
import {
  albumBrowseFields,
  filmBrowseFields,
  trackBrowseFields,
  TagLevelsParamSchema,
  type BrowseField,
} from '@repo/schemas/browse'
import {
  DeviceAlbumRowSchema,
  DeviceFilmRowSchema,
  DeviceTagLocationSchema,
  DeviceTrackRowSchema,
} from '@repo/schemas/device'
import { PersonRoleSchema } from '@repo/schemas/common'
import { db } from '@/lib/db'
import { album, film, libraryTrack, mediaItem } from '@/schemas/db'
import { listBrowseFields } from '../browse'
import {
  albumIsEdition,
  browseOrderRows,
  browseSortExpression,
  directSortExpression,
  firstText,
  jsonNumber,
  numericExpression,
  numericOrderRowFields,
  textElements,
  textRows,
  trackNaturalOrderValues,
  trackSortAlbum,
  type BrowseOrderScope,
} from '../browse-expressions'
import { loadAlbums, loadFilms } from '../media'
import {
  artistTagLabels,
  artistTagMemberships,
  creditedArtistProfiles,
  releaseTagMemberships,
} from '../music-tags'
import { recordingGroupKeys } from '../recording-groups'
import { loadTracks } from '../tracks'
import { redundantLastfmTrackIds } from '../track-values'
import {
  anyId,
  epochMicroseconds,
  microseconds,
  readProjection,
  textValues,
  toJson,
  type JsonObject,
  type Projection,
  type ProjectionPart,
  type ProjectionScalar,
} from './projection'
import { scrobbleNameId } from './plays'

/**
 * Track, Album and Film rows: the list item from the loader the list
 * endpoints use, and the projection from the Browse expressions.
 */

export type MediaEntity = 'track' | 'album' | 'film'

const builtinFields: Record<MediaEntity, readonly BrowseField[]> = {
  track: trackBrowseFields,
  album: albumBrowseFields,
  film: filmBrowseFields,
}

// Tags match through `extra` and the tag rows, not through text values.
const tagFields: Record<MediaEntity, ReadonlySet<string>> = {
  track: new Set(['genre', 'trackTag', 'albumTag', 'artistTag']),
  album: new Set(['genre', 'albumTag', 'artistTag']),
  film: new Set(['genre']),
}

const mediaFrom = sql`from ${mediaItem}
  left join ${album} on ${album.mediaItemId} = ${mediaItem.id}
  left join ${film} on ${film.mediaItemId} = ${mediaItem.id}
  left join ${libraryTrack} on ${libraryTrack.mediaItemId} = ${mediaItem.id}
  left join ${mediaItem} as ${trackSortAlbum} on ${trackSortAlbum.id} = ${libraryTrack.albumMediaItemId}`

const subtypeRow: Record<MediaEntity, SQL> = {
  track: sql`${libraryTrack.mediaItemId}`,
  album: sql`${album.mediaItemId}`,
  film: sql`${film.mediaItemId}`,
}

/** The default scope with archived items, which carry a flag. */
function published(entity: MediaEntity): SQL {
  return sql`${mediaItem.mediaType} = ${entity} and ${mediaItem.inLibrary}
    and ${subtypeRow[entity]} is not null`
}

const IdRowsSchema = z.array(z.object({ id: z.string() }))

export async function listMediaIds(
  entity: MediaEntity,
  afterId: string | null,
  limit: number,
) {
  const result = await db.execute(sql`select ${mediaItem.id} as id ${mediaFrom}
    where ${published(entity)}
      ${afterId === null ? sql`` : sql`and ${mediaItem.id} collate "C" > ${afterId}`}
    order by ${mediaItem.id} collate "C" limit ${limit}`)
  return IdRowsSchema.parse(result.rows).map((row) => row.id)
}

const archived = sql`coalesce(${mediaItem.metadata}->>'legacyHidden' = 'true', false)`

const tagLocations = DeviceTagLocationSchema.options.map((location) => ({
  location,
  levels: TagLevelsParamSchema.parse(
    location === 'auto' ? undefined : location,
  ),
}))

function orderValue(key: string, rows: SQL, ids: SQL): SQL {
  const name = numericOrderRowFields.has(key) ? sql`r.name` : sql`lower(r.name)`
  return sql`select r.media_item_id as id, to_jsonb(${name}) as value
    from (${rows}) r where r.media_item_id = ${ids}`
}

function creditedArtistIds(ids: SQL, role = 'artist'): SQL {
  return sql`select c.media_item_id as id,
      jsonb_agg(c.artist_id order by c.billing_order, c.artist_id collate "C") as value
    from media_credit c where c.media_item_id = ${ids} and c.role = ${role}
    group by c.media_item_id`
}

function artistTagKeys(ids: SQL): SQL {
  return textValues(
    sql`select c.media_item_id as id, key as value from media_credit c
      join artist_provider_current_state state on state.artist_id = c.artist_id
      join artist_provider_snapshot s on s.id = state.latest_snapshot_id
      cross join lateral unnest(artist_profile_tag_keys(s.normalized_data->'tags')) key
      where c.role = 'artist' and c.media_item_id = ${ids}`,
    ids,
  )
}

/** Each key of `metadata.browse` that is not a built-in field, per section. */
function storedBrowseParts(
  entity: MediaEntity,
  ids: SQL,
  dateKeys: readonly string[],
): ProjectionPart[] {
  const builtin = builtinFields[entity].map((field) => field.key)
  const entries = (value: SQL) => sql`select m.id, ${value} as value
    from media_item m
    cross join lateral jsonb_each(case when jsonb_typeof(m.metadata->'browse') = 'object'
      then m.metadata->'browse' else '{}'::jsonb end) e(key, value)
    where m.id = ${ids} and not e.key = any(${sql.param(builtin)}::text[])
    group by m.id`
  const texts = sql`(select coalesce(jsonb_agg(d.value order by d.value), '[]'::jsonb)
    from (select distinct v.value collate "C" as value from ${textElements(sql`e.value`)} v(value)
      where v.value is not null) d)`
  const number = jsonNumber(sql`e.value`)
  const keep = (key: string) => !isSpotifyAudioFeatureKey(key)
  return [
    {
      path: 'text.*',
      rows: entries(sql`jsonb_object_agg(e.key, ${texts})`),
      keep,
    },
    {
      path: 'num.*',
      rows: entries(sql`jsonb_object_agg(e.key, case
          when e.key = any(${sql.param([...dateKeys])}::text[]) then ${microseconds(number)}
          else ${number} end) filter (where jsonb_typeof(e.value) = 'number')`),
      keep,
    },
    {
      path: 'sort.*',
      rows: entries(
        sql`jsonb_object_agg(e.key, lower(${firstText(sql`e.value`)})) filter (where jsonb_typeof(e.value) <> 'number')`,
      ),
      keep,
    },
  ]
}

function mediaProjection(
  entity: MediaEntity,
  batch: readonly string[],
  pluginDateKeys: readonly string[],
): Projection {
  const ids = anyId(batch)
  const fields = builtinFields[entity]
  const music = entity === 'film' ? undefined : entity
  const scope: BrowseOrderScope = {
    artistTags: sql`select * from device_artist_tags`,
    albums:
      entity === 'track'
        ? sql`any(array(select lt.album_media_item_id from library_track lt
            where lt.media_item_id = ${ids} and lt.album_media_item_id is not null))`
        : ids,
    tracks: sql`lt.media_item_id = ${ids}`,
  }
  const artistLabels = music
    ? sql`select media_item_id as id, name as value, name_key
        from (${artistTagMemberships(music, scope.artistTags)}) labels`
    : undefined
  const scalars: ProjectionScalar[] = []
  const parts: ProjectionPart[] = []
  for (const field of fields) {
    const { key } = field
    if (field.type !== 'text') {
      const value = numericExpression(key, entity)
      scalars.push([
        `num.${key}`,
        field.type === 'date' ? microseconds(value) : value,
      ])
      continue
    }
    if (!tagFields[entity].has(key))
      parts.push({
        path: `text.${key}`,
        rows: textValues(textRows(key, entity, { includeArchived: true }), ids),
      })
    if (key === 'genre' && entity !== 'film') {
      for (const { location, levels } of tagLocations) {
        const rows = browseOrderRows(entity, key, levels, scope)
        if (rows)
          parts.push({
            path: `sort.genre.${location}`,
            rows: orderValue(key, rows, ids),
          })
      }
      continue
    }
    const rows = browseOrderRows(entity, key, undefined, scope)
    if (rows)
      parts.push({ path: `sort.${key}`, rows: orderValue(key, rows, ids) })
    else scalars.push([`sort.${key}`, browseSortExpression(field, entity)])
  }
  const searchRows = (key: string) =>
    textValues(textRows(key, entity, { includeArchived: true }), ids)
  if (entity === 'track')
    parts.push(
      { path: 'search.trackTag', rows: searchRows('trackTag') },
      { path: 'search.albumTag', rows: searchRows('albumTag') },
    )
  if (entity === 'album')
    parts.push({ path: 'search.albumTag', rows: searchRows('albumTag') })
  if (entity === 'film')
    parts.push({ path: 'search.genre', rows: searchRows('genre') })
  if (artistLabels)
    parts.push(
      { path: 'search.artistTag', rows: textValues(artistLabels, ids) },
      {
        path: 'extra.artistTagLabelKeys',
        rows: textValues(
          sql`select id, name_key as value from (${artistLabels}) labels`,
          ids,
        ),
      },
      { path: 'extra.artistTagKeys', rows: artistTagKeys(ids) },
      { path: 'extra.artistIds', rows: creditedArtistIds(ids) },
    )
  scalars.push(['extra.archived', archived])
  if (entity === 'track') trackExtras(batch, scalars, parts)
  if (entity === 'album') {
    scalars.push(
      ['extra.isEdition', albumIsEdition],
      [
        'extra.releaseTagCount',
        sql`(select count(*)::int from (${releaseTagMemberships(sql`${mediaItem.id}`)}) release_tags)`,
      ],
    )
    parts.push(
      {
        path: 'extra.tagIds',
        rows: textValues(
          sql`select mt.media_item_id as id, mt.tag_id as value from media_item_tag mt`,
          ids,
        ),
      },
      {
        path: 'extra.trackTagIds',
        rows: textValues(
          sql`select lt.album_media_item_id as id, tt.tag_id as value from library_track lt
            join track_tag tt on tt.media_item_id = lt.media_item_id and tt.in_browse`,
          ids,
        ),
      },
    )
  }
  if (entity === 'film') {
    scalars.push(['extra.sourceKind', sql`${film.sourceKind}`])
    parts.push(
      {
        path: 'extra.tagIds',
        rows: textValues(
          sql`select mt.media_item_id as id, mt.tag_id as value from media_item_tag mt`,
          ids,
        ),
      },
      ...PersonRoleSchema.options.map((role) => ({
        path: `extra.creditIds.${role}`,
        rows: creditedArtistIds(ids, role),
      })),
    )
  }
  if (entity !== 'track')
    parts.push(...storedBrowseParts(entity, ids, pluginDateKeys))
  return {
    with: music
      ? sql`device_artist_tags as materialized (${artistTagLabels(creditedArtistProfiles(ids))})`
      : undefined,
    id: sql`${mediaItem.id}`,
    from: mediaFrom,
    where: sql`${mediaItem.id} = ${ids} and ${published(entity)}`,
    scalars,
    parts,
  }
}

function trackExtras(
  batch: readonly string[],
  scalars: ProjectionScalar[],
  parts: ProjectionPart[],
) {
  const ids = anyId(batch)
  const natural = trackNaturalOrderValues()
  const albumId = sql`${libraryTrack.albumMediaItemId}`
  scalars.push(
    [
      'sort.releaseDate',
      epochMicroseconds(
        directSortExpression('releaseDate', 'track') ?? sql`null`,
      ),
    ],
    ['sort.natural.artist', natural.artist],
    ['sort.natural.albumDate', epochMicroseconds(natural.albumDate)],
    ['sort.natural.year', natural.year],
    ['sort.natural.spotifyAlbumId', natural.spotifyAlbumId],
    ['sort.natural.position', natural.position],
    [
      'extra.redundantPlaceholder',
      sql`coalesce(${mediaItem.sourceLabel} = 'lastfm' and exists (
        ${redundantLastfmTrackIds(sql`${mediaItem.id}`)}), false)`,
    ],
    ['extra.albumId', albumId],
    ['extra.hasOwnTags', sql`${libraryTrack.hasOwnTags}`],
    [
      'extra.albumReleaseTagCount',
      sql`case when ${albumId} is not null then (
        select count(*)::int from (${releaseTagMemberships(albumId)}) release_tags) end`,
    ],
    ['extra.recording.shown', sql`${libraryTrack.versionShown}`],
    [
      'extra.recording.playable',
      sql`${libraryTrack.spotifyTrackId} is not null`,
    ],
    ['extra.recording.linked', sql`${albumId} is not null`],
    [
      'extra.recording.releaseDate',
      epochMicroseconds(
        sql`coalesce(${trackSortAlbum.releaseDate}, ${mediaItem.releaseDate})`,
      ),
    ],
  )
  parts.push(
    {
      path: 'extra.ownTagIds',
      rows: textValues(
        sql`select tt.media_item_id as id, tt.tag_id as value from track_tag tt where tt.in_browse`,
        ids,
      ),
    },
    {
      path: 'extra.ownSonovaultTagIds',
      rows: textValues(
        sql`select tt.media_item_id as id, tt.tag_id as value from track_tag tt
          where tt.in_browse and tt.sonovault`,
        ids,
      ),
    },
    {
      path: 'extra.albumTagIds',
      rows: textValues(
        sql`select lt.media_item_id as id, mt.tag_id as value from library_track lt
          join media_item_tag mt on mt.media_item_id = lt.album_media_item_id`,
        ids,
      ),
    },
    {
      path: 'extra.recording.key',
      rows: sql`select keys.id, to_jsonb(keys.group_key) as value
        from (${recordingGroupKeys(sql`select unnest(${sql.param([...batch])}::text[]) as id`)}) keys`,
    },
    {
      path: 'extra.scrobbleNameIds',
      rows: textValues(
        sql`select l.track_media_item_id as id,
            ${scrobbleNameId(sql`l.username`, sql`l.artist_key`, sql`l.track_key`)} as value
          from lastfm_track_link l`,
        ids,
      ),
    },
  )
}

function sectionDefaults(
  keys: readonly string[],
  value: () => JsonObject[string],
): JsonObject {
  return Object.fromEntries(keys.map((key) => [key, value()]))
}

const nullTagSort = () =>
  sectionDefaults(DeviceTagLocationSchema.options, () => null)

function mediaDefaults(entity: MediaEntity): JsonObject {
  const shape = {
    track: DeviceTrackRowSchema.shape,
    album: DeviceAlbumRowSchema.shape,
    film: DeviceFilmRowSchema.shape,
  }[entity]
  const sort = sectionDefaults(Object.keys(shape.sort.shape), () => null)
  const payload: JsonObject = {
    text: sectionDefaults(Object.keys(shape.text.shape), () => []),
    search: sectionDefaults(Object.keys(shape.search.shape), () => []),
    num: sectionDefaults(Object.keys(shape.num.shape), () => null),
    sort,
  }
  if (entity === 'track')
    return {
      ...payload,
      sort: {
        ...sort,
        genre: nullTagSort(),
        natural: {
          artist: null,
          albumDate: null,
          year: null,
          spotifyAlbumId: null,
          position: null,
        },
      },
      extra: {
        archived: false,
        redundantPlaceholder: false,
        albumId: null,
        artistIds: [],
        hasOwnTags: false,
        ownTagIds: [],
        ownSonovaultTagIds: [],
        albumTagIds: [],
        albumReleaseTagCount: null,
        artistTagKeys: [],
        artistTagLabelKeys: [],
        recording: {
          key: null,
          shown: false,
          playable: false,
          linked: false,
          releaseDate: null,
        },
        scrobbleNameIds: [],
      },
    }
  if (entity === 'album')
    return {
      ...payload,
      sort: { ...sort, genre: nullTagSort() },
      extra: {
        archived: false,
        isEdition: false,
        artistIds: [],
        tagIds: [],
        releaseTagCount: 0,
        artistTagKeys: [],
        artistTagLabelKeys: [],
        trackTagIds: [],
      },
    }
  return {
    ...payload,
    extra: {
      archived: false,
      sourceKind: null,
      tagIds: [],
      creditIds: { director: [], actor: [] },
    },
  }
}

async function loadItems(entity: MediaEntity, ids: string[]) {
  if (entity === 'track') return loadTracks(ids)
  if (entity === 'album') return loadAlbums(ids, undefined)
  return loadFilms(ids)
}

/** The unvalidated payload of each published ID: item and projection. */
export async function renderMedia(
  entity: MediaEntity,
  ids: string[],
): Promise<Map<string, JsonObject>> {
  const pluginDateKeys =
    entity === 'track'
      ? []
      : (await listBrowseFields(entity))
          .filter((field) => field.type === 'date')
          .map((field) => field.key)
  const [projections, items] = await Promise.all([
    readProjection(mediaProjection(entity, ids, pluginDateKeys), () =>
      mediaDefaults(entity),
    ),
    loadItems(entity, ids),
  ])
  const payloads = new Map<string, JsonObject>()
  for (const item of items) {
    const projection = projections.get(item.id)
    if (projection) payloads.set(item.id, { ...projection, item: toJson(item) })
  }
  return payloads
}
