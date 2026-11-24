import { sql } from 'drizzle-orm'
import { z } from 'zod'
import type {
  ArtistMergeCaution,
  ArtistMergePlan,
  ArtistMergePlanRequest,
} from '@repo/schemas/artist-merges'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import { artistKeys } from '@/lib/lastfm-album-matching'
import { readKeptSeparate } from './keep-separate-effects'
import { readArtistFollows, type ArtistFollowedName } from './merge-follows'

type Reader = Pick<typeof db, 'execute'>

/** A plan request. Without `follow`, nothing follows. */
export type ArtistMergeSelection = Omit<ArtistMergePlanRequest, 'follow'> & {
  follow?: boolean
}

/** What an artist merge would do, with the names that follow, for `mergeArtists`. */
export type ArtistMergeReading = {
  plan: ArtistMergePlan
  follows: ArtistFollowedName[]
}

// Last.fm keys an artist profile by its name, so two spellings always differ.
const mbid = z.string().uuid()

const SelectedRowsSchema = z.array(
  z.object({ id: z.string(), current_id: z.string() }),
)
const PlanArtistsSchema = z.array(
  z.object({
    id: z.string(),
    name: z.string(),
    scrobbles: z.number().int().nonnegative(),
    album_count: z.number().int().nonnegative(),
    track_count: z.number().int().nonnegative(),
    credit_count: z.number().int().nonnegative(),
    film_count: z.number().int().nonnegative(),
    in_library: z.boolean(),
    profiles: z.array(
      z.object({ provider: z.string(), externalId: z.string().nullable() }),
    ),
    names: z.array(z.string()),
  }),
)
type PlanArtist = z.infer<typeof PlanArtistsSchema>[number]
const MovesRowsSchema = z
  .array(
    z.object({
      credits: z.number().int().nonnegative(),
      albums: z.number().int().nonnegative(),
      tracks: z.number().int().nonnegative(),
      shared: z.number().int().nonnegative(),
      together: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
    }),
  )
  .length(1)

const idList = (ids: string[]) =>
  sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )

const hasSpotify = (artist: PlanArtist) =>
  artist.profiles.some(
    (profile) => profile.provider === 'spotify' && profile.externalId !== null,
  )

/** The chosen artist, else one with a Spotify profile, else the most credited. */
function chooseTarget(artists: PlanArtist[], targetId?: string) {
  const [first] = [...artists].sort(
    (left, right) =>
      Number(hasSpotify(right)) - Number(hasSpotify(left)) ||
      right.credit_count - left.credit_count ||
      right.scrobbles - left.scrobbles ||
      left.name.localeCompare(right.name) ||
      left.id.localeCompare(right.id),
  )
  return artists.find((artist) => artist.id === targetId) ?? first
}

/**
 * The keys a name is compared by: case, accents, punctuation, "&" and a
 * leading "The" ignored, with each artist of a joint credit. A trailing
 * ", The" counts as a leading one.
 */
export function artistMergeNameKeys(name: string) {
  return new Set(artistKeys(name.replace(/,\s*the\s*$/i, '')))
}

/** The names that share no key with the name kept, after it. */
export function unlikeNames(target: string, others: string[]) {
  const kept = artistMergeNameKeys(target)
  const unlike = others.filter(
    (name) => ![...artistMergeNameKeys(name)].some((key) => kept.has(key)),
  )
  return unlike.length ? [target, ...new Set(unlike)] : []
}

/** Providers on which two of the artists have different profiles. */
export function differentProfiles(
  artists: Pick<PlanArtist, 'profiles'>[],
): string[] {
  const ids = new Map<string, Set<string>>()
  for (const artist of artists)
    for (const { provider, externalId } of artist.profiles) {
      if (
        externalId === null ||
        (provider === 'lastfm' && !mbid.safeParse(externalId).success)
      )
        continue
      const known = ids.get(provider) ?? new Set<string>()
      known.add(externalId)
      ids.set(provider, known)
    }
  return [...ids]
    .filter(([, known]) => known.size > 1)
    .map(([provider]) => provider)
    .sort()
}

/** Artist IDs as they read now: a merged name as the artist it was merged into. */
async function readCurrentIds(reader: Reader, ids: string[]) {
  const rows = SelectedRowsSchema.parse(
    (
      await reader.execute(sql`
        select id, coalesce(merged_into_id, id) as current_id from artist
        where id in (${idList(ids)})`)
    ).rows,
  )
  if (rows.length !== ids.length)
    throw new ServerError({ statusCode: 404, message: 'Artist not found.' })
  return new Map(rows.map((row) => [row.id, row.current_id]))
}

/**
 * What merging the selected artists would do, and with `follow`, the titles
 * that follow. A selected name that was merged before counts as the artist it
 * was merged into. `lock` holds the artists for the rest of the caller's
 * transaction.
 */
export async function readArtistMerge(
  reader: Reader,
  { artistIds, targetId, follow = false }: ArtistMergeSelection,
  lock = false,
): Promise<ArtistMergeReading> {
  const current = await readCurrentIds(reader, artistIds)
  const ids = [...new Set(artistIds.map((id) => current.get(id) ?? id))]
  if (ids.length < 2)
    throw new ServerError({
      statusCode: 409,
      message: 'These artists are already merged.',
    })
  const artists = PlanArtistsSchema.parse(
    (
      await reader.execute(sql`
        select a.id, a.name, a.scrobble_count as scrobbles,
          (select count(distinct c.media_item_id)::int from media_credit c
            join media_item m on m.id = c.media_item_id
            where c.artist_id = a.id and m.media_type = 'album') as album_count,
          (select count(distinct c.media_item_id)::int from media_credit c
            join media_item m on m.id = c.media_item_id
            where c.artist_id = a.id and m.media_type = 'track') as track_count,
          (select count(*)::int from media_credit c
            where c.artist_id = a.id) as credit_count,
          (select count(*)::int from media_credit c
            join media_item m on m.id = c.media_item_id
            where c.artist_id = a.id
              and m.media_type not in ('album', 'track')) as film_count,
          (a.added_to_library or exists (select 1 from artist n
            where n.merged_into_id = a.id and n.added_to_library)
            or exists (select 1 from media_credit c join media_item m on m.id = c.media_item_id
              where c.artist_id = a.id and c.role = 'artist' and m.media_type in ('album','track')
                and m.in_library and m.metadata->>'legacyHidden' is distinct from 'true')) as in_library,
          coalesce((select jsonb_agg(jsonb_build_object('provider', e.provider,
              'externalId', e.external_id) order by e.provider, e.external_id)
            from (
              select n.catalog_provider as provider, n.catalog_external_id as external_id
              from artist n where (n.id = a.id or n.merged_into_id = a.id) and n.catalog_provider is not null
              union
              select s.provider, p.normalized_data->>'externalId'
              from artist n join artist_provider_current_state s on s.artist_id = n.id
              left join artist_provider_snapshot p on p.id = s.latest_snapshot_id
              where n.id = a.id or n.merged_into_id = a.id
            ) e), '[]'::jsonb) as profiles,
          coalesce((select array_agg(n.name order by lower(n.name), n.id)
            from artist n where n.merged_into_id = a.id), '{}') as names
        from artist a where a.id in (${idList(ids)})
        ${lock ? sql`for update of a` : sql``}`)
    ).rows,
  )
  const target = chooseTarget(
    artists,
    targetId === undefined ? undefined : current.get(targetId),
  )
  if (!target || artists.length !== ids.length)
    throw new ServerError({ statusCode: 404, message: 'Artist not found.' })
  const sources = artists.filter((artist) => artist !== target)
  const sourceIds = sources.map((artist) => artist.id)

  const [moves] = MovesRowsSchema.parse(
    (
      await reader.execute(sql`
        with source as (
          select c.*, m.media_type from media_credit c
          join media_item m on m.id = c.media_item_id
          where c.artist_id in (${idList(sourceIds)})
        ), selected as (
          select c.media_item_id, c.artist_id from media_credit c
          where c.artist_id in (${idList(ids)})
        ), credited as (
          select c.media_item_id, m.media_type from media_credit c
          join media_item m on m.id = c.media_item_id
          where c.artist_id in (${idList(ids)}) and c.role = 'artist'
            and m.media_type in ('album', 'track')
            and m.metadata->>'legacyHidden' is distinct from 'true'
        )
        select
          (select count(*)::int from source) as credits,
          (select count(distinct media_item_id)::int from source
            where media_type = 'album') as albums,
          (select count(distinct media_item_id)::int from source
            where media_type = 'track') as tracks,
          (select count(*)::int from source s where exists (
            select 1 from media_credit t where t.artist_id = ${target.id}
              and t.media_item_id = s.media_item_id and t.role = s.role)
          ) as shared,
          (select count(*)::int from (select media_item_id from selected
            group by media_item_id having count(distinct artist_id) > 1) x
          ) as together,
          (select count(*)::int from (
            select s.id from credited c
            join lastfm_scrobble s on s.album_media_item_id = c.media_item_id
            where c.media_type = 'album'
            union
            select s.id from credited c
            join lastfm_track_link l on l.track_media_item_id = c.media_item_id
            join lastfm_scrobble s on s.username = l.username
              and s.artist_key = l.artist_key and s.track_key = l.track_key
            where c.media_type = 'track') linked) as total`)
    ).rows,
  )

  const ordered = [target, ...sources]
  const names = new Map(ordered.map((artist) => [artist.id, artist.name]))
  const separate = await readKeptSeparate(reader, 'artist', ids)
  const separateNames = [
    ...new Set(
      separate.flatMap(({ lowId, highId }) => [
        names.get(lowId) ?? lowId,
        names.get(highId) ?? highId,
      ]),
    ),
  ]
  const providers = differentProfiles(ordered)
  const unlike = unlikeNames(
    target.name,
    sources.map((artist) => artist.name),
  )
  const follows = follow
    ? await readArtistFollows(reader, { targetId: target.id, sourceIds })
    : []
  const cautions: ArtistMergeCaution[] = []
  if (providers.length) cautions.push({ code: 'profiles', providers })
  if (moves?.together)
    cautions.push({ code: 'together', items: moves.together })
  if (unlike.length) cautions.push({ code: 'names', names: unlike })
  if (separateNames.length > 1)
    cautions.push({ code: 'separate', names: separateNames })
  const plan: ArtistMergePlan = {
    targetId: target.id,
    artists: ordered.map((artist) => ({
      id: artist.id,
      name: artist.name,
      scrobbles: artist.scrobbles,
      albumCount: artist.album_count,
      trackCount: artist.track_count,
      creditCount: artist.credit_count,
      spotify: hasSpotify(artist),
      providers: [
        ...new Set(artist.profiles.map((profile) => profile.provider)),
      ],
      profiles: artist.profiles,
      inLibrary: artist.in_library,
      names: artist.names,
      blocked: artist.film_count > 0 ? 'film' : null,
    })),
    moves: {
      credits: moves?.credits ?? 0,
      albums: moves?.albums ?? 0,
      tracks: moves?.tracks ?? 0,
      shared: moves?.shared ?? 0,
      names: [
        ...new Set([
          ...target.names,
          ...sources.flatMap((artist) => [artist.name, ...artist.names]),
        ]),
      ],
    },
    scrobbles: { target: target.scrobbles, total: moves?.total ?? 0 },
    also: follows.map((name) => ({
      artistName: name.artistName,
      trackName: name.trackName,
      scrobbles: name.scrobbles,
      fromTrackId: name.fromTrackId,
      toTrackId: name.toTrackId,
      toTitle: name.toTitle,
    })),
    cautions,
    blocked: ordered.some((artist) => artist.film_count > 0),
  }
  return { plan, follows }
}

/** What merging the selected artists would do. See `readArtistMerge`. */
export async function readArtistMergePlan(
  reader: Reader,
  selection: ArtistMergeSelection,
  lock = false,
): Promise<ArtistMergePlan> {
  return (await readArtistMerge(reader, selection, lock)).plan
}

/** The plan the Merge button reads before it merges or opens a review. */
export async function planArtistMerge(input: ArtistMergePlanRequest) {
  return readArtistMergePlan(db, input)
}
