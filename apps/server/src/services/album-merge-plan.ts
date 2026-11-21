import { sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import type {
  AlbumMergeBlock,
  AlbumMergeCaution,
  AlbumMergePlan,
  AlbumMergePlanRequest,
} from '@repo/schemas/album-merges'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import {
  albumArtistCaution,
  albumTrackCaution,
  albumVersionCaution,
} from '@/lib/album-merge-cautions'
import {
  albumNameKeys,
  readAlbumNames,
  readFollowPlan,
  type AlbumNameState,
  type FollowPlan,
} from './album-names'
import { readKeptSeparate, type SeparatePair } from './keep-separate-effects'
import type { ChangeReader } from './library-change-effect'

const PlanAlbumsSchema = z.array(
  z.object({
    id: z.string(),
    title: z.string(),
    artists: z.array(z.string()),
    release_date: z.string().nullable(),
    date_added: z.string().nullable(),
    edition_of_id: z.string().nullable(),
    hidden: z.boolean(),
    spotify: z.boolean(),
    tracks: z.array(z.string()),
    scrobbles: z.number().int().nonnegative(),
  }),
)
type PlanAlbum = z.infer<typeof PlanAlbumsSchema>[number]

const idList = (ids: string[]) =>
  sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )

async function readAlbums(reader: ChangeReader, scope: SQL, lock: boolean) {
  return PlanAlbumsSchema.parse(
    (
      await reader.execute(sql`
        select al.media_item_id as id, mi.title,
          coalesce((
            select array_agg(a.name order by c.billing_order, a.id)
            from media_credit c join artist a on a.id = c.artist_id
            where c.media_item_id = mi.id and c.role = 'artist'), '{}') as artists,
          to_char(mi.release_date, 'YYYY-MM-DD') as release_date,
          to_char(al.date_added, 'YYYY-MM-DD"T"HH24:MI:SS') as date_added,
          al.edition_of_id,
          coalesce(mi.metadata->>'legacyHidden' = 'true', false) as hidden,
          (al.spotify_url is not null or exists (
            select 1 from provider_reference r where r.media_item_id = mi.id
              and (r.reference_type = 'spotify'
                or (r.provider = 'spotify' and r.reference_type = 'album'))))
            as spotify,
          coalesce((
            select array_agg(t.title order by t.position) from track t
            where t.album_media_item_id = al.media_item_id), '{}') as tracks,
          (select count(*)::int from lastfm_scrobble s
            where s.album_media_item_id = al.media_item_id) as scrobbles
        from album al join media_item mi on mi.id = al.media_item_id
        where ${scope}
        order by al.media_item_id
        ${lock ? sql`for update of al` : sql``}`)
    ).rows,
  )
}

// Sorts an album without an added date after every other.
const LAST = '\uffff'

/** The chosen album, else one with a Spotify album ID, then the most tracks, then the earliest added. */
function chooseTarget(albums: PlanAlbum[], targetId?: string) {
  const [first] = [...albums].sort(
    (left, right) =>
      Number(right.spotify) - Number(left.spotify) ||
      right.tracks.length - left.tracks.length ||
      (left.date_added ?? LAST).localeCompare(right.date_added ?? LAST) ||
      left.id.localeCompare(right.id),
  )
  return albums.find((album) => album.id === targetId) ?? first
}

function elsewhereCaution(follow: FollowPlan | null): AlbumMergeCaution[] {
  return follow?.elsewhere.length
    ? [
        {
          code: 'elsewhere',
          count: follow.elsewhere.length,
          names: follow.elsewhere.slice(0, 5),
        },
      ]
    : []
}

function separateCaution(kept: SeparatePair[]): AlbumMergeCaution[] {
  return kept.length
    ? [
        {
          code: 'separate',
          albumIds: [
            ...new Set(kept.flatMap((pair) => [pair.lowId, pair.highId])),
          ],
        },
      ]
    : []
}

/** What a merge would do, with the records it reads, for `mergeAlbums`. */
export type AlbumMergeReading = {
  plan: AlbumMergePlan
  names: AlbumNameState[]
  follow: FollowPlan | null
}

/**
 * What merging the selected albums, and bringing the given album names, would
 * do. Two or more albums make one record: the others, and their editions,
 * become editions of the album to keep, which is the first album of its
 * record. A single album keeps its place and only receives the names.
 * `account` is the Last.fm account the names belong to. `lock` holds the
 * albums for the rest of the caller's transaction.
 */
export async function readAlbumMerge(
  reader: ChangeReader,
  account: string | null,
  { albumIds, targetId, names: refs, follow }: AlbumMergePlanRequest,
  lock = false,
): Promise<AlbumMergeReading> {
  const selected = await readAlbums(
    reader,
    sql`al.media_item_id in (${idList(albumIds)})`,
    lock,
  )
  const chosen = chooseTarget(selected, targetId)
  if (!chosen || selected.length !== albumIds.length)
    throw new ServerError({ statusCode: 404, message: 'Album not found.' })
  const joining = albumIds.length > 1
  const targetAlbumId = joining
    ? (chosen.edition_of_id ?? chosen.id)
    : chosen.id
  const roots = [
    ...new Set([
      targetAlbumId,
      ...selected.map((album) => album.edition_of_id ?? album.id),
    ]),
  ]
  const members = joining
    ? await readAlbums(
        reader,
        sql`(al.media_item_id in (${idList(roots)})
          or al.edition_of_id in (${idList(roots)}))`,
        lock,
      )
    : selected
  const target = members.find((album) => album.id === targetAlbumId)
  if (!target)
    throw new ServerError({ statusCode: 404, message: 'Album not found.' })
  const editions = joining
    ? members.filter(
        (album) => album.id !== target.id && album.edition_of_id !== target.id,
      )
    : []
  const recordIds = joining
    ? members.map((album) => album.id)
    : [
        target.id,
        ...(
          await readAlbums(reader, sql`al.edition_of_id = ${target.id}`, false)
        ).map((album) => album.id),
      ]

  if (refs.length && !account)
    throw new ServerError({
      statusCode: 422,
      message:
        'Add a Last.fm API key and username in Providers before moving album names.',
    })
  const names = account ? await readAlbumNames(reader, account, refs) : []
  const followed =
    account && follow && names.length
      ? await readFollowPlan(
          reader,
          account,
          refs.map(albumNameKeys),
          target.id,
          recordIds,
        )
      : null

  const record = new Set(recordIds)
  const counted = (album: PlanAlbum) =>
    album.id === target.id || album.edition_of_id === target.id
  const targetScrobbles = members
    .filter(counted)
    .reduce((total, album) => total + album.scrobbles, 0)
  const added =
    editions.reduce((total, album) => total + album.scrobbles, 0) +
    names
      .filter((name) => name.albumId === null || !record.has(name.albumId))
      .reduce((total, name) => total + name.scrobbles, 0)
  const others = selected.filter((album) => album.id !== target.id)
  const kept = await readKeptSeparate(reader, 'album', albumIds)
  const hidden = members.some((album) => album.hidden)
  const blocked: AlbumMergeBlock | null = hidden
    ? 'hidden'
    : joining && !editions.length && !names.length
      ? 'same-record'
      : null

  const ordered = [
    target,
    ...others,
    ...members.filter((album) => album !== target && !others.includes(album)),
  ]
  return {
    names,
    follow: followed,
    plan: {
      targetId: target.id,
      albums: ordered.map((album) => ({
        id: album.id,
        title: album.title,
        by: album.artists.join(', '),
        releaseDate: album.release_date,
        trackCount: album.tracks.length,
        scrobbles: album.scrobbles,
        spotify: album.spotify,
        editionOfId: album.edition_of_id,
        selected: albumIds.includes(album.id),
      })),
      editions: editions.map((album) => ({
        albumId: album.id,
        fromId: album.edition_of_id,
      })),
      names: names.map((name) => ({
        artistName: name.artistName,
        albumName: name.albumName,
        scrobbles: name.scrobbles,
        albumId: name.albumId,
      })),
      also: (followed?.also ?? []).map((name) => ({
        artistName: name.artistName,
        trackName: name.trackName,
        scrobbles: name.scrobbles,
        fromTrackId: name.fromTrackId,
        toTrackId: name.toTrackId,
        toTitle: name.toTitle,
      })),
      unmatched: followed?.unmatched ?? [],
      scrobbles: {
        target: targetScrobbles,
        added,
        total: targetScrobbles + added,
      },
      cautions: [
        ...albumVersionCaution([
          target.title,
          ...others.map((album) => album.title),
          ...names.map((name) => name.albumName),
        ]),
        ...albumArtistCaution(target, [
          ...others.map((album) => album.artists),
          ...names.map((name) => [name.artistName]),
        ]),
        ...albumTrackCaution(target, others),
        ...elsewhereCaution(followed),
        ...separateCaution(kept),
      ],
      blocked,
    },
  }
}

/** The plan the Merge button reads before it merges or opens a review. */
export async function readAlbumMergePlan(
  account: string | null,
  input: AlbumMergePlanRequest,
): Promise<AlbumMergePlan> {
  return (await readAlbumMerge(db, account, input)).plan
}
