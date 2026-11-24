import {
  and,
  asc,
  count,
  eq,
  inArray,
  isNull,
  sql,
  type SQL,
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
  type ArtistMixQuery,
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
} from '@/schemas/db'
import {
  countArtistProfileHistory,
  listArtistProfileHistory,
  listCurrentArtistProfiles,
} from './artist-profiles'
import { queryBrowseIds } from './browse'
import {
  artistPlaylistMembership,
  artistArtwork,
  artistPlaylistCount,
} from './artist-library'
import { listArtistBrowsePage, countArtistBrowse } from './artist-browse'
import { listAlbums, listFilms } from './media'
import { loadTracks } from './tracks'
import { listArtistIdentifiers } from './artist-provider-evidence'
import { visibleArtist } from './entity-relationships'
import { currentArtistId, listKeptArtistNames } from './artist-names'
import {
  artistFreshnessConditions,
  loadArtistMetadata,
} from './artist-metadata'
import {
  countMixesNamingArtist,
  listMixesNamingArtist,
} from './subscription-library'

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

/** A merged artist is a name another artist keeps, not a creator of its own. */
function creatorFilter(q: string | undefined, id: string | undefined) {
  const pattern = q ? namePattern(q) : undefined
  return and(
    isNull(artist.mergedIntoId),
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

function artistDirectory(id?: string) {
  return db
    .select({
      ...identityColumns,
      inLibrary: sql<boolean>`bool_or(${mediaItem.inLibrary})`.as('in_library'),
      albumCount: sql<number>`count(*) filter (where ${isAlbum} and ${mediaItem.inLibrary})::int`.as(
        'album_count',
      ),
      trackCount: sql<number>`count(*) filter (where ${isTrack} and ${mediaItem.inLibrary})::int`.as(
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
        creatorFilter(undefined, id),
        eq(mediaCredit.role, 'artist'),
        visible,
        id === undefined ? eq(mediaItem.inLibrary, true) : undefined,
        sql`(${isAlbum} or ${isTrack})`,
      ),
    )
    .groupBy(artist.id)
}

export async function listArtists(query: ArtistQuery | ArtistMetadataQuery) {
  const [result, total] = await Promise.all([
    listArtistBrowsePage(query),
    countArtistBrowse(query),
  ])
  return ArtistPageSchema.parse(page(query, total.totalCount, result.items))
}

export async function listArtistMetadata(query: ArtistMetadataQuery) {
  const result = await listArtists(query)
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

/** A merged artist's ID reads as the artist it was merged into. */
export async function getArtist(
  requestedId: string,
  query: ArtistDetailQuery = {},
) {
  const id = await currentArtistId(db, requestedId)
  const directory = artistDirectory(id).as('directory')
  const artistId = sql`${id}`
  const [summary] = await db
    .select({
      id: directory.id,
      name: directory.name,
      sortName: directory.sortName,
      createdAt: directory.createdAt,
      inLibrary: directory.inLibrary,
      albumCount: directory.albumCount,
      trackCount: directory.trackCount,
      playlistCount: artistPlaylistCount(artistId),
      artworkUrl: artistArtwork(artistId),
    })
    .from(directory)
  if (!summary)
    throw new ServerError({ statusCode: 404, message: 'Artist not found' })
  const kept = listKeptArtistNames(db, id)
  const [providers, history, mixCount, keptNames] = await Promise.all([
    listCurrentArtistProfiles(id),
    query.includeHistory === 'false' ? [] : listArtistProfileHistory(id, 20),
    kept.then((names) =>
      countMixesNamingArtist(
        summary.name,
        names.map(({ name }) => name),
      ),
    ),
    kept,
  ])
  return ArtistDetailSchema.parse({
    ...summary,
    mixCount,
    identifiers: await listArtistIdentifiers(id, summary.name, providers),
    createdAt: summary.createdAt.toISOString(),
    profile: combineProfiles(providers),
    providers,
    history,
    keptNames,
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
        id === undefined ? eq(mediaItem.inLibrary, true) : undefined,
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

/**
 * An artist must have at least one visible, current library credit. A merged
 * artist's ID reads as the artist it was merged into.
 */
async function requireLibraryArtist(requestedId: string) {
  const [row] = await db
    .select({ id: artist.id, name: artist.name })
    .from(artist)
    .where(
      and(eq(artist.id, await currentArtistId(db, requestedId)), sql`(${visibleArtist} or exists (
        select 1 from media_credit credit join media_item item on item.id = credit.media_item_id
        where credit.artist_id = ${artist.id} and credit.role = 'artist'
          and item.media_type in ('album', 'track') and item.metadata->>'legacyHidden' is distinct from 'true'
      ))`),
    )
  if (!row)
    throw new ServerError({ statusCode: 404, message: 'Artist not found' })
  return row
}

/**
 * Use the same library visibility for directory membership and related pages.
 * Returns the ID to read, which for a merged artist is the artist it was
 * merged into.
 */
export async function requireCreator(id: string, kind: 'artist' | 'person') {
  if (kind === 'artist') return (await requireLibraryArtist(id)).id
  const directory = personDirectory(undefined, undefined, id).as('directory')
  const [row] = await db.select({ id: directory.id }).from(directory)
  if (!row)
    throw new ServerError({ statusCode: 404, message: 'Person not found' })
  return row.id
}

export async function listArtistAlbums(
  requestedId: string,
  query: ArtistAlbumQuery,
) {
  const id = await requireCreator(requestedId, 'artist')
  const data = await listAlbums(
    AlbumQuerySchema.parse({ ...query, creatorId: id }),
    {
      conditions: [sql`${album.mediaItemId} is not null`],
    },
  )
  return { ...queryPage(query), ...data }
}

export async function getArtistHistory(
  requestedId: string,
  query: ArtistHistoryQuery,
) {
  const id = await requireCreator(requestedId, 'artist')
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

export async function listArtistTracks(
  requestedId: string,
  query: ArtistTrackQuery,
) {
  const id = await requireCreator(requestedId, 'artist')
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

/** Stored station mixes naming the artist; station names are matched, not linked. */
export async function listArtistMixes(id: string, query: ArtistMixQuery) {
  const { id: artistId, name } = await requireLibraryArtist(id)
  const kept = await listKeptArtistNames(db, artistId)
  return listMixesNamingArtist(
    name,
    query,
    kept.map((keptName) => keptName.name),
  )
}

export async function listArtistPlaylists(
  requestedId: string,
  query: ArtistPlaylistQuery,
) {
  const id = await requireCreator(requestedId, 'artist')
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
