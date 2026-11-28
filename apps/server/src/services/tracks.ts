import { eq, sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import {
  selectedBrowseProviders,
  type BrowseFacetQuery,
} from '@repo/schemas/browse'
import { spotifyIdPattern } from '@repo/schemas/playback'
import {
  PlaylistAlbumSchema,
  PlaylistDetailSchema,
  PlaylistRemovalSchema,
  TrackAlbumLinkStrategySchema,
  TrackDetailSchema,
  TrackFactSchema,
  TrackIsrcSchema,
  TrackListItemSchema,
  TrackScrobbleLinkStrategySchema,
  TrackSourceSchema,
  TrackSpotifyAlternateSchema,
  TrackSpotifyMatchSchema,
  TrackTagGroupsSchema,
  type PlaylistAlbum,
  type PlaylistDetail,
  type PlaylistDetailQuery,
  type PlaylistEntry,
  type PlaylistEntrySort,
  type PlaylistSyncSchedule,
  type TrackDetail,
  type TrackListItem,
  type TrackPositionsQuery,
  type TrackQuery,
} from '@repo/schemas/tracks'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import { measureRequestPhase } from '@/lib/request-log'
import { spotifyAlbumId } from '@/lib/spotify-api'
import { albumMatchRejectionField } from './album-match-rejections'
import {
  albumTrackDurationExpression,
  trackProvidersExpression,
  trackSourcesExpression,
  trackSpotifyMatchExpression,
} from './track-values'
import { playlist } from '@/schemas/db'
import {
  listBrowseFacets,
  listedInLibraryBrowse,
  queryBrowseIds,
  queryBrowsePageIds,
  queryBrowsePositions,
  queryTrackRecordingVersions,
} from './browse'
import { trackSpotifyAlternate, type RecordingGroup } from './recording-groups'
import { refreshTrackAddedDates } from './spotify-playlists'
import { getLastfmTrackNames } from './lastfm-track-names'
import {
  lockLibraryTrackWrites,
  removeOrphanTracks,
} from './album-library-tracks'
import { artistTagsForItems } from './music-tags'
import { trackIsrcsExpression } from './track-isrcs'
import {
  TrackBrowseLinkTargetsSchema,
  trackBrowseLinkTargets,
  trackBrowseLinks,
} from './track-browse-links'
import {
  trackFactsExpression,
  verifiedTrackBpm,
  verifiedTrackKey,
} from './track-facts'
import { getPlaylistSummary, playlistAlbumMembers } from './playlist-directory'
import { setPlaylistSyncSchedule } from './spotify-playlist-sync'

const isoTimestamp = (column: SQL) =>
  sql`to_char(${column}, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`

/** The visible tags in Browse of the returned page's tracks, read once (TTAG-14). */
function trackTagsForItems(ids: SQL) {
  return sql`select tt.media_item_id, array_agg(t.name order by t.name) as tags
    from track_tag tt join tag t on t.id = tt.tag_id
    where tt.media_item_id = ${ids} and tt.in_browse and not t.hidden
    group by tt.media_item_id`
}

/**
 * Every visible tag a track carries or once carried, with its state, for
 * track details (TTAG-11). Hidden tags are left out as in Browse.
 */
function trackTagGroupsExpression(id: SQL) {
  const tags = (where: SQL, extra = sql``) =>
    sql`coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name${extra})
        order by lower(t.name), t.id)
      from track_tag tt join tag t on t.id = tt.tag_id
      where tt.media_item_id = ${id} and not t.hidden and ${where}), '[]'::jsonb)`
  return sql`jsonb_build_object(
    'own', ${tags(sql`tt.in_browse`, sql`, 'added', tt.owner is not distinct from 'added', 'sonovault', tt.sonovault`)},
    'unverified', ${tags(sql`tt.sonovault and not tt.verified and tt.owner is null`)},
    'removed', ${tags(sql`tt.owner = 'removed'`)})`
}

const TrackRowsSchema = z.array(
  z.object({
    id: z.string(),
    in_library: z.boolean(),
    title: z.string(),
    artwork_url: z.string().nullable(),
    release_date: z.string().nullable(),
    artist_credits: z.array(z.object({ id: z.string(), name: z.string() })),
    artist_tags: z.array(z.string()),
    album_name: z.string().nullable(),
    album_id: z.string().nullable(),
    album_title: z.string().nullable(),
    album_in_library: z.boolean().nullable(),
    album_link_strategy: TrackAlbumLinkStrategySchema.nullable(),
    track_tags: z.array(z.string()),
    album_tags: z.array(z.string()),
    playlists: z.array(z.object({ id: z.string(), name: z.string() })),
    sources: z.array(TrackSourceSchema),
    duration_sec: z.number().int().nullable(),
    bpm: z.number().nullable(),
    musical_key: z.string().nullable(),
    date_added: z.string().nullable(),
    spotify_track_id: z.string().nullable(),
    spotify_album_id: z.string().nullable(),
    spotify_match: TrackSpotifyMatchSchema,
    providers: z.array(z.string()),
    link_targets: TrackBrowseLinkTargetsSchema,
    spotify_url: z.string().nullable(),
    isrc: z.string().nullable(),
    scrobble_count: z.number().int(),
    last_listened_at: z.string().nullable(),
  }),
)

/** A release observation can supply the header for a shadow recording. */
function observedTrackRelease() {
  const nativeAlbum = sql`coalesce(
    substring(lt.spotify_album_id from '^(?:spotify:album:)?([A-Za-z0-9]{22})$'),
    substring(lt.spotify_album_id from '^https://open[.]spotify[.]com/album/([A-Za-z0-9]{22})/?(?:[?#].*)?$')
  )`
  return sql`(
    select min(candidate.id)
    from (
      select distinct release.media_item_id as id
      from catalog_observation o
      join album release on release.media_item_id = o.media_item_id
      join media_item release_item on release_item.id = release.media_item_id
      where not mi.in_library and lt.album_media_item_id is null
        and o.subject_kind = 'track' and o.subject_id = lt.media_item_id
        and o.target_kind = 'album' and o.relationship_role = 'release'
        and release_item.media_type = 'album'
        and release_item.metadata->>'legacyHidden' is distinct from 'true'
        and (o.response_id is null or exists (
          select 1 from provider_response r
          where r.id = o.response_id and r.provider = o.provider
            and r.status between 200 and 299 and not r.not_found
        ))
        and not exists (
          select 1 from provider_reference r
          where r.media_item_id = release.media_item_id
            and r.reference_type in ('album', 'spotify', 'spotify_album', 'sonovault-release')
            and (r.provider = o.provider or (r.provider = 'spotify' and r.external_id = ${nativeAlbum}))
            and (r.metadata->>'rejected' = 'true' or r.metadata->>'verified' = 'false')
        )
        and not exists (
          select 1 from media_override r
          where r.media_item_id = release.media_item_id and r.field = ${albumMatchRejectionField}
            and r.value->>'referenceType' in ('album', 'spotify', 'spotify_album', 'sonovault-release')
            and (r.value->>'provider' = o.provider
              or (r.value->>'provider' = 'spotify' and r.value->>'identifier' = ${nativeAlbum}))
        )
        and (lt.spotify_album_id is null
          or substring(release.spotify_url from '/album/([A-Za-z0-9]{22})') = ${nativeAlbum}
          or exists (
            select 1 from provider_reference r
            where r.media_item_id = release.media_item_id and r.provider = 'spotify'
              and r.reference_type in ('album', 'spotify', 'spotify_album')
              and r.external_id = ${nativeAlbum}
          ))
      limit 2
    ) candidate
    having count(*) = 1
  )`
}

async function loadTrackItems(
  pageIds: SQL,
  prefix = sql``,
  {
    includeObservedRelease = false,
    providers = [],
  }: {
    includeObservedRelease?: boolean
    providers?: readonly string[]
  } = {},
) {
  const albumId = includeObservedRelease
    ? sql`coalesce(lt.album_media_item_id, ${observedTrackRelease()})`
    : sql`lt.album_media_item_id`
  const rows = TrackRowsSchema.parse(
    (
      await db.execute(sql`
        ${prefix}
        select mi.id, mi.in_library, mi.title, coalesce(mi.artwork_url, am.artwork_url) as artwork_url,
          ${isoTimestamp(sql`coalesce(mi.release_date, am.release_date)`)} as release_date,
          coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name) order by c.billing_order, a.name)
            from media_credit c join artist a on a.id = c.artist_id
            where c.media_item_id = mi.id and c.role = 'artist'), '[]'::jsonb) as artist_credits,
          coalesce(page_tags.tags, '[]'::jsonb) as artist_tags,
          coalesce(lt.album_name, am.title) as album_name, am.id as album_id,
          am.title as album_title, am.in_library as album_in_library, lt.album_link_strategy,
          coalesce(page_track_tags.tags, '{}') as track_tags,
          coalesce((
            select array_agg(distinct t.name order by t.name)
            from media_item_tag mt join tag t on t.id = mt.tag_id
            where mt.media_item_id = lt.album_media_item_id
              and t.media_type = 'album' and not t.hidden), '{}') as album_tags,
          coalesce((
            select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name)
              order by p.name)
            from playlist_item pi join playlist p on p.id = pi.playlist_id
            where pi.media_item_id = mi.id), '[]'::jsonb) as playlists,
          ${trackSourcesExpression(sql`mi.id`, sql`mi.metadata`)} as sources,
          coalesce(lt.duration_sec, ${albumTrackDurationExpression(sql`lt.media_item_id`, sql`lt.album_media_item_id`)}) as duration_sec,
          ${verifiedTrackBpm(sql`lt.media_item_id`)} as bpm,
          ${verifiedTrackKey(sql`lt.media_item_id`)} as musical_key,
          lt.spotify_track_id, lt.spotify_album_id,
          ${trackSpotifyMatchExpression(sql`lt.spotify_track_id`, sql`mi.source_label`)} as spotify_match,
          ${trackProvidersExpression(sql`mi.id`, sql`lt.spotify_track_id`)} as providers,
          ${trackBrowseLinkTargets(sql`mi.id`, providers)} as link_targets,
          ${isoTimestamp(sql`lt.date_added`)} as date_added,
          lt.spotify_url, lt.isrc, lt.scrobble_count,
          ${isoTimestamp(sql`lt.last_listened_at`)} as last_listened_at
        from library_track lt
        join media_item mi on mi.id = lt.media_item_id
        left join media_item am on am.id = ${albumId}
        left join (${artistTagsForItems(pageIds)}) page_tags on page_tags.media_item_id = lt.media_item_id
        left join (${trackTagsForItems(pageIds)}) page_track_tags on page_track_tags.media_item_id = lt.media_item_id
        where lt.media_item_id = ${pageIds}`)
    ).rows,
  )
  return rows.map((row) => {
    const spotifyTrackId = row.spotify_track_id
    const links = trackBrowseLinks(providers, row.link_targets, spotifyTrackId)
    return TrackListItemSchema.parse({
      id: row.id,
      inLibrary: row.in_library,
      mediaType: 'track',
      title: row.title,
      artworkUrl: row.artwork_url,
      releaseDate: row.release_date,
      artists: row.artist_credits.map((credit) => credit.name),
      artistCredits: row.artist_credits,
      artistTags: row.artist_tags,
      albumName: row.album_name,
      album:
        row.album_id && row.album_title !== null
          ? {
              id: row.album_id,
              title: row.album_title,
              ...(row.album_in_library === false ? { inLibrary: false } : {}),
            }
          : null,
      albumLinkStrategy: row.album_link_strategy,
      trackTags: row.track_tags,
      albumTags: row.album_tags,
      playlists: row.playlists,
      sources: row.sources,
      durationSec: row.duration_sec,
      bpm: row.bpm,
      musicalKey: row.musical_key,
      dateAdded: row.in_library ? row.date_added : null,
      spotifyTrackId,
      spotifyAlbumId: row.spotify_album_id
        ? spotifyAlbumId(row.spotify_album_id)
        : null,
      spotifyMatch: row.spotify_match,
      providers: row.providers,
      ...(links?.length ? { links } : {}),
      spotifyUrl:
        row.spotify_url ??
        (spotifyTrackId
          ? `https://open.spotify.com/track/${spotifyTrackId}`
          : null),
      isrc: row.isrc,
      scrobbles: row.scrobble_count,
      lastListenedAt: row.last_listened_at,
    })
  })
}

export async function loadTracks(
  ids: string[],
  providers?: readonly string[],
): Promise<TrackListItem[]> {
  if (!ids.length) return []
  const items = await loadTrackItems(
    sql`any(${sql.param(ids)}::text[])`,
    undefined,
    { providers },
  )
  const byId = new Map(items.map((item) => [item.id, item]))
  return ids.flatMap((id) => {
    const item = byId.get(id)
    return item ? [item] : []
  })
}

/** Browse values: a grouped row's totals and the count in a sort period. */
function trackWithRecordingGroup(
  track: TrackListItem,
  group?: RecordingGroup,
  listeningScrobbles?: number,
): TrackListItem {
  const item =
    listeningScrobbles === undefined ? track : { ...track, listeningScrobbles }
  if (!group || group.version_count === 1) return item
  return {
    ...item,
    scrobbles: group.scrobbles,
    lastListenedAt: group.last_listened_at,
    dateAdded: group.date_added,
    recordingGroup: { versionCount: group.version_count },
  }
}

export async function listTracks(query: TrackQuery) {
  const { ids, totalCount, pageCount, recordingGroups, listeningScrobbles } =
    await queryBrowseIds('track', query)
  return {
    items: (await loadTracks(ids, selectedBrowseProviders(query.filters))).map(
      (track) =>
        trackWithRecordingGroup(
          track,
          recordingGroups?.get(track.id),
          listeningScrobbles?.get(track.id),
        ),
    ),
    totalCount,
    pageCount,
  }
}

export async function listTrackBrowsePage(query: TrackQuery) {
  const { ids, hasMore, recordingGroups, listeningScrobbles } =
    await measureRequestPhase('ids', () => queryBrowsePageIds('track', query))
  return {
    items: (
      await measureRequestPhase('hydrate', () =>
        loadTracks(ids, selectedBrowseProviders(query.filters)),
      )
    ).map((track) =>
      trackWithRecordingGroup(
        track,
        recordingGroups?.get(track.id),
        listeningScrobbles?.get(track.id),
      ),
    ),
    page: query.page,
    size: query.size,
    hasMore,
  }
}

export async function listTrackRecordingVersions(
  id: string,
  query: TrackQuery,
) {
  const { ids, hasMore, listeningScrobbles } =
    await queryTrackRecordingVersions(id, query)
  return {
    items: (await loadTracks(ids, selectedBrowseProviders(query.filters))).map(
      (track) =>
        trackWithRecordingGroup(
          track,
          undefined,
          listeningScrobbles?.get(track.id),
        ),
    ),
    page: query.page,
    size: query.size,
    hasMore,
  }
}

/** The tracks at the given positions of the query's order, in one read. */
export async function listTracksAtPositions(query: TrackPositionsQuery) {
  const rows = await queryBrowsePositions('track', query, query.positions)
  const items = new Map(
    (await loadTracks(rows.map((row) => row.id))).map((item) => [
      item.id,
      item,
    ]),
  )
  return {
    items: rows.flatMap(
      ({ id, position, recordingGroup, listeningScrobbles }) => {
        const item = items.get(id)
        return item
          ? [
              {
                position,
                item: trackWithRecordingGroup(
                  item,
                  recordingGroup,
                  listeningScrobbles,
                ),
              },
            ]
          : []
      },
    ),
  }
}

export const listTrackFilterOptions = (query: Partial<BrowseFacetQuery>) =>
  listBrowseFacets('track', query)

const ListeningDetailSchema = z.object({
  total: z.coerce.number(),
  first: z.number().nullable(),
  last: z.number().nullable(),
  months: z.array(z.object({ month: z.string(), count: z.number() })),
  sources: z.array(
    z.object({
      artist_key: z.string(),
      track_key: z.string(),
      artist_name: z.string(),
      track_name: z.string(),
      count: z.number(),
      strategy: TrackScrobbleLinkStrategySchema,
    }),
  ),
  scrobbled_albums: z.array(
    z.object({ id: z.string(), title: z.string(), scrobbles: z.number() }),
  ),
  isrcs: z.array(TrackIsrcSchema),
  facts: z.array(TrackFactSchema),
  tags: TrackTagGroupsSchema,
  listed: z.boolean(),
})
const isoSeconds = (value: number | null) =>
  value === null ? null : new Date(value * 1000).toISOString()

async function getTrackSpotifyAlternate(id: string) {
  const result = await db.execute(trackSpotifyAlternate(id))
  const [row] = z
    .object({ alternate: TrackSpotifyAlternateSchema })
    .array()
    .parse(result.rows)
  return row?.alternate
}

async function getTrackListeningDetail(id: string) {
  // Share one item-scoped history read across the lifetime, monthly, source
  // and album aggregates.
  const result = await db.execute(sql`
    with linked as materialized (
      select l.artist_key, l.track_key, l.strategy, s.artist_name, s.track_name, s.listened_at,
        s.album_media_item_id
      from lastfm_track_link l join lastfm_scrobble s on s.username = l.username
        and s.artist_key = l.artist_key and s.track_key = l.track_key
      where l.track_media_item_id = ${id}
    ), target as (
      select album_media_item_id, version_group_id, isrc
      from library_track where media_item_id = ${id}
    ), album_counts as (
      select album_media_item_id as id, count(*)::int as scrobbles
      from linked where album_media_item_id is not null
      group by album_media_item_id
    ), scrobbled_albums as (
      -- Albums the scrobbles are linked to that hold neither this track nor
      -- a version of it: a stored version or a recording with the same ISRC.
      select c.id, am.title, c.scrobbles
      from album_counts c join media_item am on am.id = c.id
      where c.id is distinct from (select album_media_item_id from target)
        and not exists (
          select 1 from (
            select media_item_id as member_id from library_track where album_media_item_id = c.id
            union all
            select track_media_item_id from track where album_media_item_id = c.id
          ) members join library_track v on v.media_item_id = members.member_id
          where v.media_item_id = ${id}
            or v.version_group_id = (select version_group_id from target)
            or v.isrc = (select isrc from target))
      order by c.scrobbles desc, am.title, c.id limit 5
    ), months as (
      select to_char(listened_at, 'YYYY-MM') as month, count(*) as count
      from linked group by 1
    ), sources as (
      select artist_key, track_key, max(artist_name) as artist_name, max(track_name) as track_name,
        count(*) as count, max(strategy) as strategy
      from linked group by artist_key, track_key
      order by count desc, artist_key, track_key limit 50
    )
    select count(*) as total,
      extract(epoch from min(listened_at))::float8 as first,
      extract(epoch from max(listened_at))::float8 as last,
      coalesce((select jsonb_agg(months order by month) from months), '[]'::jsonb) as months,
      coalesce((select jsonb_agg(sources order by count desc, artist_key, track_key) from sources), '[]'::jsonb) as sources,
      coalesce((select jsonb_agg(scrobbled_albums order by scrobbles desc, title, id) from scrobbled_albums), '[]'::jsonb) as scrobbled_albums,
      ${trackIsrcsExpression(sql`${id}::text`)} as isrcs,
      ${trackFactsExpression(sql`${id}::text`)} as facts,
      ${trackTagGroupsExpression(sql`${id}::text`)} as tags,
      ${listedInLibraryBrowse('track', sql`${id}::text`)} as listed
    from linked`)
  return ListeningDetailSchema.parse(result.rows[0])
}

export async function getTrackDetail(
  requestedId: string,
): Promise<TrackDetail | null> {
  const [item] = await measureRequestPhase('trackDetailHydrate', () =>
    loadTrackItems(
      sql`(select id from requested_track)`,
      sql`with requested_track as materialized (
        select coalesce(
          (select media_item_id from catalog_media_alias where alias_id = ${requestedId}),
          ${requestedId}::text
        ) as id
      )`,
      { includeObservedRelease: true },
    ),
  )
  if (!item) return null
  const { id } = item
  const [listening, lastfmSources, spotifyAlternate] = await Promise.all([
    measureRequestPhase('trackDetailListening', () =>
      getTrackListeningDetail(id),
    ),
    measureRequestPhase('trackDetailNames', () => getLastfmTrackNames(id)),
    item.spotifyTrackId && spotifyIdPattern.test(item.spotifyTrackId)
      ? undefined
      : measureRequestPhase('trackDetailAlternate', () =>
          getTrackSpotifyAlternate(id),
        ),
  ])
  return TrackDetailSchema.parse({
    ...item,
    ...(spotifyAlternate ? { spotifyAlternate } : {}),
    lastfmSources,
    scrobbledAlbums: listening.scrobbled_albums,
    isrcs: listening.isrcs,
    listedInLibrary: listening.listed,
    facts: listening.facts,
    tags: listening.tags,
    listening: {
      total: listening.total,
      firstListenedAt: isoSeconds(listening.first),
      lastListenedAt: isoSeconds(listening.last),
      months: listening.months,
      sources: listening.sources.map((row) => ({
        artistKey: row.artist_key,
        trackKey: row.track_key,
        artistName: row.artist_name,
        trackName: row.track_name,
        count: row.count,
        strategy: row.strategy,
      })),
    },
  })
}

const EntryRowsSchema = z.array(
  z.object({
    id: z.string(),
    kind: z.enum(['track', 'album']),
    position: z.number().int(),
    added_at: z.string().nullable(),
  }),
)
const CountRowsSchema = z.array(z.object({ count: z.coerce.number() }))
const AlbumEntryRowsSchema = z.array(
  z.object({
    id: z.string(),
    title: z.string(),
    artists: z.array(z.string()),
    artwork_url: z.string().nullable(),
    release_date: z.string().nullable(),
    spotify_url: z.string().nullable(),
  }),
)

async function loadPlaylistAlbums(ids: string[]) {
  if (!ids.length) return new Map<string, PlaylistAlbum>()
  const rows = AlbumEntryRowsSchema.parse(
    (
      await db.execute(sql`
        select mi.id, mi.title, mi.artwork_url,
          to_char(mi.release_date, 'YYYY-MM-DD') as release_date,
          al.spotify_url,
          coalesce((
            select array_agg(a.name order by c.billing_order, a.name)
            from media_credit c join artist a on a.id = c.artist_id
            where c.media_item_id = mi.id and c.role = 'artist'), '{}') as artists
        from media_item mi join album al on al.media_item_id = mi.id
        where mi.id in (${sql.join(
          ids.map((id) => sql`${id}`),
          sql`, `,
        )})`)
    ).rows,
  )
  return new Map(
    rows.map((row) => [
      row.id,
      PlaylistAlbumSchema.parse({
        id: row.id,
        title: row.title,
        artists: row.artists,
        artworkUrl: row.artwork_url,
        releaseDate: row.release_date,
        spotifyUrl: row.spotify_url,
      }),
    ]),
  )
}

const playlistEntryArtistsSort = sql`(select lower(string_agg(artist.name, ', ' order by c.billing_order, artist.name))
  from media_credit c join artist on artist.id = c.artist_id
  where c.media_item_id = mi.id and c.role = 'artist')`

function playlistEntrySearch(pattern: string) {
  return sql`mi.title ilike ${pattern}
    or exists (select 1 from media_credit c join artist on artist.id = c.artist_id
      where c.media_item_id = mi.id and c.role = 'artist' and artist.name ilike ${pattern})`
}

function playlistEntrySortExpression(key: PlaylistEntrySort): SQL {
  switch (key) {
    case 'position':
      return sql`pi.position`
    case 'title':
      return sql`lower(mi.title)`
    case 'artists':
      return playlistEntryArtistsSort
    case 'album':
      return sql`lower(coalesce(lt.album_name, am.title))`
    case 'duration':
      return sql`coalesce(lt.duration_sec, ${albumTrackDurationExpression(sql`lt.media_item_id`, sql`lt.album_media_item_id`)})`
    case 'added':
      return sql`pi.added_at`
    case 'releaseDate':
      return sql`coalesce(mi.release_date, am.release_date)`
    case 'scrobbles':
      return sql`lt.scrobble_count`
    case 'lastListened':
      return sql`lt.last_listened_at`
    case 'source':
      return sql`case when lt.media_item_id is not null then ${trackSourcesExpression(sql`mi.id`, sql`mi.metadata`, true)} end`
    case 'spotifyMatch':
      return sql`case when lt.media_item_id is not null then ${trackSpotifyMatchExpression(sql`lt.spotify_track_id`, sql`mi.source_label`, true)} end`
    case 'kind':
      return sql`case when lt.media_item_id is null then 'album' else 'track' end`
  }
}

function playlistEntriesQuery(
  id: string,
  query: PlaylistDetailQuery,
  pattern: string,
  direction: SQL,
  albumIds: SQL | null,
) {
  const restrict = albumIds
    ? sql`and (a.media_item_id = any(${albumIds})
        or lt.album_media_item_id = any(${albumIds})
        or exists (select 1 from track t
          where t.track_media_item_id = lt.media_item_id
            and t.album_media_item_id = any(${albumIds})))`
    : sql``
  const kinds = query.kinds ?? (query.kind ? [query.kind] : [])
  const kindFilter =
    kinds.length === 1 && kinds.includes('track')
      ? sql`and lt.media_item_id is not null`
      : kinds.length === 1 && kinds.includes('album')
        ? sql`and lt.media_item_id is null and a.media_item_id is not null`
        : sql``
  const searchFilter = query.q
    ? sql`and (${playlistEntrySearch(pattern)} or coalesce(lt.album_name, am.title) ilike ${pattern})`
    : sql``
  const members = sql`from (
    with latest as (
      select details->>'version' as version from catalog_observation
      where target_kind = 'playlist' and target_id = ${id}
        and operation = 'playlist-contents' and details->'complete' = 'true'::jsonb
      order by observed_at desc, id desc limit 1
    )
    select p.playlist_id, p.media_item_id, p.position, p.added_at
    from playlist_item p
    where p.playlist_id = ${id}
      and (not exists (select 1 from latest)
        or not exists (select 1 from library_track lt where lt.media_item_id = p.media_item_id))
    union all
    select o.subject_id, coalesce(o.media_item_id, o.target_id), o.position,
      (o.details->>'addedAt')::timestamptz at time zone 'UTC'
    from latest join catalog_observation o on o.details->>'version' = latest.version
    where o.subject_kind = 'playlist' and o.subject_id = ${id}
      and o.operation = 'playlist-contents' and o.target_kind = 'track'
      and o.relationship_role = 'playlist_entry' and o.position is not null
  ) pi
    join media_item mi on mi.id = pi.media_item_id
    left join library_track lt on lt.media_item_id = pi.media_item_id
    left join album a on a.media_item_id = pi.media_item_id
    left join media_item am on am.id = lt.album_media_item_id
    where pi.playlist_id = ${id}
      and (lt.media_item_id is not null or a.media_item_id is not null)
      ${kindFilter} ${searchFilter} ${restrict}`
  const sort = playlistEntrySortExpression(query.sortBy)
  const entryOrder =
    query.sortBy === 'position'
      ? sql`lt.media_item_id is null, ${sort} ${direction}`
      : sql`${sort} ${direction} nulls last`
  return {
    members,
    columns: sql`pi.media_item_id as id, pi.position,
      case when lt.media_item_id is null then 'album' else 'track' end as kind,
      ${isoTimestamp(sql`pi.added_at`)} as added_at`,
    order: sql`${entryOrder}, lt.media_item_id is null, pi.position, pi.media_item_id`,
  }
}

function groupedPlaylistAlbumSort(key: PlaylistEntrySort): SQL {
  switch (key) {
    case 'album':
    case 'title':
      return sql`lower(mi.title)`
    case 'artists':
      return playlistEntryArtistsSort
    case 'added':
      return sql`pi.added_at`
    case 'releaseDate':
      return sql`mi.release_date`
    default:
      return sql`pi.position`
  }
}

function groupedPlaylistAlbumsQuery(
  id: string,
  query: PlaylistDetailQuery,
  pattern: string,
  direction: SQL,
  albumIds: SQL | null,
) {
  const searchFilter = query.q
    ? sql`and (${playlistEntrySearch(pattern)})`
    : sql``
  const sort = groupedPlaylistAlbumSort(query.sortBy)
  const kinds = query.kinds ?? (query.kind ? [query.kind] : [])
  const includeAlbums = kinds.length === 0 || kinds.includes('album')
  const restrict = albumIds ? sql`and mi.id = any(${albumIds})` : sql``
  return {
    members: sql`from (
      select distinct on (album_id) album_id, position, added_at
      from playlist p
      cross join lateral (${playlistAlbumMembers}) members
      where p.id = ${id}
      order by album_id, position, added_at nulls last
    ) pi
    join media_item mi on mi.id = pi.album_id
    where ${includeAlbums} ${searchFilter} ${restrict}`,
    columns: sql`mi.id, pi.position, 'album' as kind,
      ${isoTimestamp(sql`pi.added_at`)} as added_at`,
    order: sql`${sort} ${direction} nulls last, pi.position, mi.id`,
  }
}

/**
 * One playlist with sync state and a page of entries. The default order is
 * tracks in playlist order, then legacy album entries. Album grouping lists
 * each library album once at its first playlist position. Coverage can limit
 * either view to entries associated with a specific set of library albums.
 */
export async function getPlaylistDetail(
  id: string,
  query: PlaylistDetailQuery,
  restrictToAlbumIds?: string[],
): Promise<PlaylistDetail> {
  const summary = await getPlaylistSummary(id)
  const pattern = `%${(query.q ?? '').replace(/[\\%_]/g, '\\$&')}%`
  const direction = query.direction === 'asc' ? sql`asc` : sql`desc`
  const albumIds = restrictToAlbumIds
    ? sql`${sql.param(restrictToAlbumIds)}::text[]`
    : null
  const { members, columns, order } =
    query.groupBy === 'album'
      ? groupedPlaylistAlbumsQuery(
          summary.id,
          query,
          pattern,
          direction,
          albumIds,
        )
      : playlistEntriesQuery(summary.id, query, pattern, direction, albumIds)
  const [count] = CountRowsSchema.parse(
    (await db.execute(sql`select count(*) as count ${members}`)).rows,
  )
  const totalCount = count?.count ?? 0
  const entries = EntryRowsSchema.parse(
    (
      await db.execute(sql`
        select ${columns} ${members}
        order by ${order}
        limit ${query.size} offset ${(query.page - 1) * query.size}`)
    ).rows,
  )
  const tracks = new Map(
    (
      await loadTracks(
        entries.filter((row) => row.kind === 'track').map((row) => row.id),
      )
    ).map((item) => [item.id, item]),
  )
  const albums = await loadPlaylistAlbums(
    entries.filter((row) => row.kind === 'album').map((row) => row.id),
  )
  return PlaylistDetailSchema.parse({
    ...summary,
    items: {
      page: query.page,
      size: query.size,
      totalCount,
      pageCount: Math.ceil(totalCount / query.size),
      items: entries.flatMap((row): PlaylistEntry[] => {
        const base = { position: row.position, addedAt: row.added_at }
        if (row.kind === 'album') {
          const album = albums.get(row.id)
          return album ? [{ kind: 'album', ...base, album }] : []
        }
        const track = tracks.get(row.id)
        return track ? [{ kind: 'track', ...base, track }] : []
      }),
    },
  })
}

/** Sets a playlist's sync schedule and returns the playlist. */
export async function updatePlaylistSyncSchedule(
  id: string,
  schedule: PlaylistSyncSchedule,
  userId: string,
) {
  await setPlaylistSyncSchedule(id, schedule, userId)
  return getPlaylistSummary(id)
}

/**
 * Removes an imported playlist and tracks with no remaining source.
 * A playlist that also holds albums from the legacy library keeps those.
 */
export async function removeImportedPlaylist(id: string) {
  return db.transaction(async (tx) => {
    // The same lock as imports, which also delete tracks with no remaining source.
    await lockLibraryTrackWrites(tx)
    const [stored] = await tx
      .select({
        source: playlist.source,
        catalogProvider: playlist.catalogProvider,
      })
      .from(playlist)
      .where(eq(playlist.id, id))
      .for('update')
    if (!stored?.source)
      throw new ServerError({
        statusCode: 404,
        message: 'Imported playlist not found',
      })
    await tx.execute(sql`
      delete from playlist_item pi using library_track lt
      where pi.playlist_id = ${id} and lt.media_item_id = pi.media_item_id`)
    const kept = await tx.execute(
      sql`select 1 from playlist_item where playlist_id = ${id} limit 1`,
    )
    if (kept.rows.length || stored.catalogProvider)
      await tx
        .update(playlist)
        .set({
          addedToLibrary: false,
          source: null,
          ...(stored.catalogProvider
            ? {}
            : { spotifyId: null, artworkUrl: null, spotifyUrl: null }),
          ownerName: null,
          description: null,
          snapshotId: null,
          importedAt: null,
          checkedAt: null,
          syncSchedule: 'off',
          syncUserId: null,
          spotifyEditable: false,
        })
        .where(eq(playlist.id, id))
    else await tx.delete(playlist).where(eq(playlist.id, id))
    const removedTracks = await removeOrphanTracks(tx)
    await refreshTrackAddedDates(tx)
    return PlaylistRemovalSchema.parse({ removedTracks })
  })
}
