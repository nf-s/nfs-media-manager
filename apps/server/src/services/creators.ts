import {
  and,
  asc,
  count,
  eq,
  inArray,
  sql,
  type SQL,
  type SQLWrapper,
} from 'drizzle-orm'
import type {
  ArtistProfile,
  ArtistProviderSnapshot,
} from '@repo/schemas/artist-profiles'
import {
  ArtistDetailSchema,
  ArtistHistoryPageSchema,
  ArtistMetadataPageSchema,
  ArtistPageSchema,
  ArtistPlaylistPageSchema,
  PersonPageSchema,
  PersonSummarySchema,
  type ArtistAlbumQuery,
  type ArtistDetailQuery,
  type ArtistHistoryQuery,
  type ArtistMetadataQuery,
  type ArtistPlaylistQuery,
  type ArtistQuery,
  type ArtistTrackQuery,
  type PersonFilmQuery,
  type PersonQuery,
  type PersonRole,
} from '@repo/schemas/creators'
import { AlbumQuerySchema, FilmQuerySchema } from '@repo/schemas/media'
import { uniqueMusicTags } from '@repo/schemas/music-tags'
import { TrackQuerySchema } from '@repo/schemas/tracks'
import type { ProviderFreshnessFilter } from '@repo/schemas/film-selection'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import {
  album,
  artist,
  film,
  libraryTrack,
  mediaCredit,
  mediaItem,
  playlist,
} from '@/schemas/db'
import {
  countArtistProfileHistory,
  listArtistProfileHistory,
  listCurrentArtistProfiles,
} from './artist-profiles'
import { queryBrowseIds } from './browse'
import { listAlbums, listFilms } from './media'
import { loadTracks } from './tracks'
import { listArtistIdentifiers } from './artist-provider-evidence'
import {
  artistFreshnessConditions,
  artistLastScrapedAt,
  loadArtistMetadata,
} from './artist-metadata'

const identityColumns = {
  id: artist.id,
  name: artist.name,
  sortName: artist.sortName,
  createdAt: artist.createdAt,
}

const visible = sql`${mediaItem.metadata}->>'legacyHidden' is distinct from 'true'`
const isAlbum = and(
  eq(mediaItem.mediaType, 'album'),
  eq(album.mediaItemId, mediaItem.id),
)
const isTrack = and(
  eq(mediaItem.mediaType, 'track'),
  eq(libraryTrack.mediaItemId, mediaItem.id),
)
const personRoles: PersonRole[] = ['director', 'actor']

function namePattern(value: string) {
  return `%${value.replace(/[\\%_]/g, '\\$&')}%`
}

function creatorFilter(q: string | undefined, id: string | undefined) {
  const pattern = q ? namePattern(q) : undefined
  return and(
    id === undefined ? undefined : eq(artist.id, id),
    pattern === undefined
      ? undefined
      : sql`(${artist.name} ilike ${pattern} or ${artist.sortName} ilike ${pattern})`,
  )
}

function page<T>(
  query: { page: number; size: number },
  totalCount: number,
  items: T[],
) {
  return {
    ...queryPage(query),
    totalCount,
    pageCount: Math.ceil(totalCount / query.size),
    items,
  }
}

function queryPage({ page, size }: { page: number; size: number }) {
  return { page, size }
}

function order(column: SQL, direction: 'asc' | 'desc') {
  return direction === 'asc' ? sql`${column} asc` : sql`${column} desc`
}

// Match the playlists accessible from the existing playlist workspace.
const visiblePlaylist = sql`${playlist.kind} = 'playlist' and (
  ${playlist.source} is not null or exists (
    select 1 from playlist_item member
    left join album a on a.media_item_id = member.media_item_id
    left join library_track t on t.media_item_id = member.media_item_id
    where member.playlist_id = ${playlist.id}
      and (a.media_item_id is not null or t.album_media_item_id is not null
        or exists (select 1 from track entry where entry.track_media_item_id = member.media_item_id))
  )
)`

function artistPlaylistCredits(artistId?: string | SQLWrapper) {
  const selectedArtist =
    artistId === undefined ? sql`` : sql`and credit.artist_id = ${artistId}`
  return sql`
    select credit.artist_id, member.playlist_id, recording.media_item_id, 'track' as kind
    from media_credit credit
    join library_track recording on recording.media_item_id = credit.media_item_id
    join media_item item on item.id = recording.media_item_id
    join playlist_item member on member.media_item_id = recording.media_item_id
    where credit.role = 'artist' ${selectedArtist}
      and item.media_type = 'track' and item.metadata->>'legacyHidden' is distinct from 'true'
    union all
    select credit.artist_id, member.playlist_id, release.media_item_id, 'album' as kind
    from media_credit credit
    join album release on release.media_item_id = credit.media_item_id
    join media_item item on item.id = release.media_item_id
    cross join lateral (
      select release.media_item_id
      union all
      select recording.media_item_id from library_track recording
      where recording.album_media_item_id = release.media_item_id
      union all
      select entry.track_media_item_id from track entry
      where entry.album_media_item_id = release.media_item_id
    ) related
    join playlist_item member on member.media_item_id = related.media_item_id
    join media_item linked_item on linked_item.id = member.media_item_id
    where credit.role = 'artist' ${selectedArtist}
      and item.media_type = 'album' and item.metadata->>'legacyHidden' is distinct from 'true'
      and linked_item.metadata->>'legacyHidden' is distinct from 'true'`
}

function artistPlaylistMembership(artistId: string | SQLWrapper) {
  return db
    .select({
      id: playlist.id,
      name: playlist.name,
      artworkUrl: playlist.artworkUrl,
      spotifyUrl: playlist.spotifyUrl,
      createdAt: playlist.createdAt,
      albumCount:
        sql<number>`count(distinct memberships.media_item_id) filter (where memberships.kind = 'album')::int`.as(
          'album_count',
        ),
      trackCount:
        sql<number>`count(distinct memberships.media_item_id) filter (where memberships.kind = 'track')::int`.as(
          'track_count',
        ),
    })
    .from(playlist)
    .innerJoin(
      sql`(${artistPlaylistCredits(artistId)}) as memberships`,
      sql`memberships.playlist_id = ${playlist.id}`,
    )
    .where(visiblePlaylist)
    .groupBy(playlist.id)
}

function artistDirectory(q?: string, id?: string, playlistIds: string[] = []) {
  return db
    .select({
      ...identityColumns,
      albumCount: sql<number>`count(*) filter (where ${isAlbum})::int`.as(
        'album_count',
      ),
      trackCount: sql<number>`count(*) filter (where ${isTrack})::int`.as(
        'track_count',
      ),
    })
    .from(artist)
    .innerJoin(mediaCredit, eq(mediaCredit.artistId, artist.id))
    .innerJoin(mediaItem, eq(mediaItem.id, mediaCredit.mediaItemId))
    .leftJoin(album, eq(album.mediaItemId, mediaItem.id))
    .leftJoin(libraryTrack, eq(libraryTrack.mediaItemId, mediaItem.id))
    .where(
      and(
        creatorFilter(q, id),
        eq(mediaCredit.role, 'artist'),
        visible,
        sql`(${isAlbum} or ${isTrack})`,
        playlistIds.length
          ? inArray(
              artist.id,
              db
                .select({ artistId: sql<string>`memberships.artist_id` })
                .from(sql`(${artistPlaylistCredits()}) memberships`)
                .innerJoin(
                  playlist,
                  sql`${playlist.id} = memberships.playlist_id`,
                )
                .where(and(visiblePlaylist, inArray(playlist.id, playlistIds))),
            )
          : undefined,
      ),
    )
    .groupBy(artist.id)
}

function artistArtwork(id: SQLWrapper) {
  return sql<string | null>`(
    select s.normalized_data->>'artworkUrl'
    from artist_provider_current_state state
    join artist_provider_snapshot s on s.id = state.latest_snapshot_id
    where state.artist_id = ${id} and s.normalized_data->>'artworkUrl' is not null
    order by s.created_at desc, s.id desc limit 1
  )`
}

function artistPlaylistCount(id: SQLWrapper) {
  return sql<number>`(select count(*)::int from (${artistPlaylistMembership(id)}) memberships)`
}

/** Sorting by playlist count needs every count, so build them in one pass. */
function artistPlaylistCounts() {
  const artistId = sql<string>`memberships.artist_id`
  return db
    .select({
      artistId: artistId.as('artist_id'),
      count: sql<number>`count(distinct ${playlist.id})::int`.as(
        'playlist_count',
      ),
    })
    .from(sql`(${artistPlaylistCredits()}) memberships`)
    .innerJoin(playlist, sql`${playlist.id} = memberships.playlist_id`)
    .where(visiblePlaylist)
    .groupBy(artistId)
}

type ArtistDirectoryColumns = Record<
  keyof typeof identityColumns | 'albumCount' | 'trackCount',
  SQLWrapper
>

function artistOrder(
  source: ArtistDirectoryColumns,
  query: ArtistQuery | ArtistMetadataQuery,
  playlistCount: SQLWrapper,
) {
  const sortColumns = {
    name: sql`lower(coalesce(${source.sortName}, ${source.name}))`,
    createdAt: source.createdAt,
    albumCount: source.albumCount,
    trackCount: source.trackCount,
    playlistCount,
    lastScrapedAt:
      'provider' in query && query.provider
        ? artistLastScrapedAt(source.id, query.provider)
        : sql`null`,
  }
  return [
    query.sortBy === 'lastScrapedAt'
      ? query.direction === 'asc'
        ? sql`${sortColumns.lastScrapedAt} asc nulls first`
        : sql`${sortColumns.lastScrapedAt} desc nulls last`
      : order(sql`${sortColumns[query.sortBy]}`, query.direction),
    sql`lower(${source.name})`,
    asc(source.id),
  ]
}

async function listArtistDirectory(query: ArtistQuery | ArtistMetadataQuery) {
  const directory = artistDirectory(query.q, undefined, query.playlistIds).as(
    'directory',
  )
  const where =
    'freshness' in query
      ? and(...artistFreshnessConditions(directory.id, query.freshness))
      : undefined
  const countBeforePaging = query.sortBy === 'playlistCount'
  const playlistCounts = artistPlaylistCounts().as('playlist_counts')
  const playlistCount = countBeforePaging
    ? sql<number>`coalesce(${playlistCounts.count}, 0)`
    : sql<number>`0::int`
  const candidates = db
    .select({
      id: directory.id,
      name: directory.name,
      sortName: directory.sortName,
      createdAt: directory.createdAt,
      albumCount: directory.albumCount,
      trackCount: directory.trackCount,
      playlistCount: playlistCount.as('playlist_count'),
    })
    .from(directory)
  // Compute the directory page before loading details that do not affect its order.
  const selected = (
    countBeforePaging
      ? candidates.leftJoin(
          playlistCounts,
          eq(playlistCounts.artistId, directory.id),
        )
      : candidates
  )
    .where(where)
    .orderBy(...artistOrder(directory, query, playlistCount))
    .limit(query.size)
    .offset((query.page - 1) * query.size)
    .as('artist_page')
  // Drizzle unqualifies column chunks for single-table projections. Keep the
  // outer alias in the correlated subqueries, whose tables also have an id.
  const selectedArtistId = sql`"artist_page"."id"`
  const [[total], rows] = await Promise.all([
    db.select({ value: count() }).from(directory).where(where),
    db
      .select({
        id: selected.id,
        name: selected.name,
        sortName: selected.sortName,
        createdAt: selected.createdAt,
        albumCount: selected.albumCount,
        trackCount: selected.trackCount,
        playlistCount: countBeforePaging
          ? selected.playlistCount
          : artistPlaylistCount(selectedArtistId),
        artworkUrl: artistArtwork(selectedArtistId),
      })
      .from(selected)
      .orderBy(...artistOrder(selected, query, selected.playlistCount)),
  ])
  return ArtistPageSchema.parse(
    page(
      query,
      total?.value ?? 0,
      rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
    ),
  )
}

export function listArtists(query: ArtistQuery) {
  return listArtistDirectory(query)
}

export async function listArtistMetadata(query: ArtistMetadataQuery) {
  const result = await listArtistDirectory(query)
  const metadata = await loadArtistMetadata(result.items.map((item) => item.id))
  return ArtistMetadataPageSchema.parse({
    ...result,
    items: result.items.map((item) => ({
      ...item,
      providers: metadata.filter((row) => row.artistId === item.id),
    })),
  })
}

export async function matchingArtistSelection(
  ids: string[],
  freshness: ProviderFreshnessFilter[] = [],
) {
  if (!ids.length) return []
  const directory = artistDirectory().as('directory')
  const rows = await db
    .select({ id: directory.id })
    .from(directory)
    .where(
      and(
        inArray(directory.id, ids),
        ...artistFreshnessConditions(directory.id, freshness),
      ),
    )
  return rows.map((row) => row.id)
}

function combineProfiles(providers: ArtistProviderSnapshot[]): ArtistProfile {
  const profile: ArtistProfile = { tags: [] }
  for (const { profile: source } of providers) {
    profile.name ??= source.name
    profile.summary ??= source.summary
    profile.artworkUrl ??= source.artworkUrl
    profile.country ??= source.country
    profile.type ??= source.type
  }
  profile.tags = uniqueMusicTags(
    providers.flatMap(({ profile }) => profile.tags),
  )
  return profile
}

export async function getArtist(id: string, query: ArtistDetailQuery = {}) {
  const directory = artistDirectory(undefined, id).as('directory')
  const artistId = sql`${id}`
  const [summary] = await db
    .select({
      id: directory.id,
      name: directory.name,
      sortName: directory.sortName,
      createdAt: directory.createdAt,
      albumCount: directory.albumCount,
      trackCount: directory.trackCount,
      playlistCount: artistPlaylistCount(artistId),
      artworkUrl: artistArtwork(artistId),
    })
    .from(directory)
  if (!summary)
    throw new ServerError({ statusCode: 404, message: 'Artist not found' })
  const [providers, history] = await Promise.all([
    listCurrentArtistProfiles(id),
    query.includeHistory === 'false' ? [] : listArtistProfileHistory(id, 20),
  ])
  return ArtistDetailSchema.parse({
    ...summary,
    identifiers: await listArtistIdentifiers(id, summary.name, providers),
    createdAt: summary.createdAt.toISOString(),
    profile: combineProfiles(providers),
    providers,
    history,
  })
}

function personDirectory(q?: string, role?: PersonRole, id?: string) {
  const countRole = (role: PersonRole) =>
    sql<number>`count(distinct ${mediaItem.id}) filter (where ${mediaCredit.role} = ${role})::int`
  return db
    .select({
      ...identityColumns,
      filmCount: sql<number>`count(distinct ${mediaItem.id})::int`.as(
        'film_count',
      ),
      directorCount: countRole('director').as('director_count'),
      actorCount: countRole('actor').as('actor_count'),
    })
    .from(artist)
    .innerJoin(mediaCredit, eq(mediaCredit.artistId, artist.id))
    .innerJoin(mediaItem, eq(mediaItem.id, mediaCredit.mediaItemId))
    .innerJoin(film, eq(film.mediaItemId, mediaItem.id))
    .where(
      and(
        creatorFilter(q, id),
        eq(mediaItem.mediaType, 'film'),
        inArray(mediaCredit.role, personRoles),
        visible,
      ),
    )
    .groupBy(artist.id)
    .having(role ? sql`${countRole(role)} > 0` : undefined)
}

function personSummary(
  row: Awaited<ReturnType<typeof personDirectory>>[number],
) {
  return PersonSummarySchema.parse({
    ...row,
    createdAt: row.createdAt.toISOString(),
    roles: personRoles.filter((role) =>
      role === 'director' ? row.directorCount > 0 : row.actorCount > 0,
    ),
  })
}

export async function listPeople(query: PersonQuery) {
  const directory = personDirectory(query.q, query.role).as('directory')
  const sortColumns = {
    name: sql`lower(coalesce(${directory.sortName}, ${directory.name}))`,
    createdAt: sql`${directory.createdAt}`,
    filmCount: sql`${directory.filmCount}`,
    directorCount: sql`${directory.directorCount}`,
    actorCount: sql`${directory.actorCount}`,
  }
  const [[total], rows] = await Promise.all([
    db.select({ value: count() }).from(directory),
    db
      .select()
      .from(directory)
      .orderBy(
        order(sortColumns[query.sortBy], query.direction),
        sql`lower(${directory.name})`,
        asc(directory.id),
      )
      .limit(query.size)
      .offset((query.page - 1) * query.size),
  ])
  return PersonPageSchema.parse(
    page(query, total?.value ?? 0, rows.map(personSummary)),
  )
}

export async function getPerson(id: string) {
  const [summary] = await personDirectory(undefined, undefined, id)
  if (!summary)
    throw new ServerError({ statusCode: 404, message: 'Person not found' })
  return personSummary(summary)
}

/** Use the same library visibility for directory membership and related pages. */
async function requireCreator(id: string, kind: 'artist' | 'person') {
  const directory =
    kind === 'artist'
      ? artistDirectory(undefined, id).as('directory')
      : personDirectory(undefined, undefined, id).as('directory')
  const [row] = await db.select({ id: directory.id }).from(directory)
  if (!row)
    throw new ServerError({
      statusCode: 404,
      message: kind === 'artist' ? 'Artist not found' : 'Person not found',
    })
}

export async function listArtistAlbums(id: string, query: ArtistAlbumQuery) {
  await requireCreator(id, 'artist')
  const data = await listAlbums(
    AlbumQuerySchema.parse({ ...query, creatorId: id }),
    {
      conditions: [sql`${album.mediaItemId} is not null`],
    },
  )
  return { ...queryPage(query), ...data }
}

export async function getArtistHistory(id: string, query: ArtistHistoryQuery) {
  await requireCreator(id, 'artist')
  const [totalCount, items] = await Promise.all([
    countArtistProfileHistory(id, query.provider),
    listArtistProfileHistory(
      id,
      query.size,
      (query.page - 1) * query.size,
      query.provider,
    ),
  ])
  return ArtistHistoryPageSchema.parse(page(query, totalCount, items))
}

export async function listArtistTracks(id: string, query: ArtistTrackQuery) {
  await requireCreator(id, 'artist')
  const { ids, totalCount, pageCount } = await queryBrowseIds(
    'track',
    TrackQuerySchema.parse({ ...query, creatorId: id }),
  )
  return {
    ...queryPage(query),
    totalCount,
    pageCount,
    items: await loadTracks(ids),
  }
}

export async function listArtistPlaylists(
  id: string,
  query: ArtistPlaylistQuery,
) {
  await requireCreator(id, 'artist')
  const memberships = artistPlaylistMembership(id).as('memberships')
  const where = query.q
    ? sql`${memberships.name} ilike ${namePattern(query.q)}`
    : undefined
  const sortColumns = {
    name: sql`lower(${memberships.name})`,
    createdAt: sql`${memberships.createdAt}`,
    albumCount: sql`${memberships.albumCount}`,
    trackCount: sql`${memberships.trackCount}`,
  }
  const [[total], rows] = await Promise.all([
    db.select({ value: count() }).from(memberships).where(where),
    db
      .select()
      .from(memberships)
      .where(where)
      .orderBy(
        order(sortColumns[query.sortBy], query.direction),
        sql`lower(${memberships.name})`,
        asc(memberships.id),
      )
      .limit(query.size)
      .offset((query.page - 1) * query.size),
  ])
  return ArtistPlaylistPageSchema.parse(
    page(
      query,
      total?.value ?? 0,
      rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
    ),
  )
}

export async function listPersonFilms(id: string, query: PersonFilmQuery) {
  await requireCreator(id, 'person')
  const data = await listFilms(
    FilmQuerySchema.parse({ ...query, creatorId: id, creatorRole: query.role }),
    {
      conditions: [sql`${film.mediaItemId} is not null`],
    },
  )
  return { ...queryPage(query), ...data }
}
