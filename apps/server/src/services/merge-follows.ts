import { sql } from 'drizzle-orm'
import { z } from 'zod'
import type {
  AlbumMergeFollow,
  AlbumMergeUnmatched,
  AlbumNameRef,
} from '@repo/schemas/album-merges'
import { ServerError } from '@/lib/error'
import { albumNameKey } from '@/lib/album-import-candidates'
import {
  createAlbumTrackAliasMatcher,
  parseTrackNumberPrefix,
  titleCredit,
} from '@/lib/album-track-aliases'
import { trackVersionKey } from '@/lib/track-matching'
import { readKeptSeparateTest } from './keep-separate-effects'
import type { AlbumNameKey } from './lastfm-album-links'
import type { ChangeReader } from './library-change-effect'

/*
 * What follows a merge: the names scrobbled under a merged album or artist
 * name, and the album name a merged title was scrobbled under. Read only, so
 * the merge plans can use it without loading the journal.
 */

const NO_SCROBBLES = 'No scrobbles have this artist and album name.'

const idList = (ids: string[]) =>
  sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )
const nameId = (key: AlbumNameKey) =>
  JSON.stringify([key.artistKey, key.albumKey])
const keysInput = (keys: AlbumNameKey[]) =>
  sql`jsonb_to_recordset(${JSON.stringify(
    keys.map(({ artistKey, albumKey }) => ({ artistKey, albumKey })),
  )}::jsonb) as k("artistKey" text, "albumKey" text)`

/** The keys a scrobbled artist and album name is stored under. */
export const albumNameKeys = (name: AlbumNameRef): AlbumNameKey => ({
  artistKey: albumNameKey(name.artistName),
  albumKey: albumNameKey(name.albumName),
})

const NameRowsSchema = z.array(
  z.object({
    artistKey: z.string(),
    albumKey: z.string(),
    artistName: z.string(),
    albumName: z.string(),
    scrobbles: z.number().int().nonnegative(),
    albumId: z.string().nullable(),
  }),
)
/** A scrobbled album name of the account, with the album it is linked to. */
export type AlbumNameState = z.infer<typeof NameRowsSchema>[number]

/**
 * The given scrobbled album names of the account, in the given order, with
 * their scrobbles and linked album. A name without scrobbles is not found.
 */
export async function readAlbumNames(
  reader: ChangeReader,
  account: string,
  names: AlbumNameRef[],
): Promise<AlbumNameState[]> {
  if (!names.length) return []
  const keys = names.map(albumNameKeys)
  const rows = new Map(
    NameRowsSchema.parse(
      (
        await reader.execute(sql`
          select s.artist_key as "artistKey", s.album_key as "albumKey",
            max(s.artist_name) as "artistName", max(s.album_name) as "albumName",
            count(*)::int as scrobbles,
            (select l.album_media_item_id from lastfm_album_link l
              where l.username = s.username and l.artist_key = s.artist_key
                and l.album_key = s.album_key) as "albumId"
          from lastfm_scrobble s join ${keysInput(keys)}
            on s.artist_key = k."artistKey" and s.album_key = k."albumKey"
          where s.username = ${account}
          group by s.username, s.artist_key, s.album_key`)
      ).rows,
    ).map((row) => [nameId(row), row]),
  )
  return [...new Set(keys.map(nameId))].map((id) => {
    const row = rows.get(id)
    if (!row) throw new ServerError({ statusCode: 404, message: NO_SCROBBLES })
    return row
  })
}

/** A scrobbled name that could follow onto a track. */
type FollowCandidate = {
  username: string
  artistKey: string
  trackKey: string
  fromTrackId: string
  toTrackId: string
}

const RejectionRowsSchema = z.array(
  z.object({
    username: z.string(),
    artist_key: z.string(),
    track_key: z.string(),
    record_id: z.string(),
  }),
)

/**
 * Whether each name may follow onto its track: not when the owner keeps the
 * two tracks separate, nor when a remembered rejection keeps the name off
 * that track.
 */
async function readFollowDecisions(
  reader: ChangeReader,
  candidates: FollowCandidate[],
): Promise<(candidate: FollowCandidate) => boolean> {
  if (!candidates.length) return () => true
  const separate = await readKeptSeparateTest(reader, 'track', [
    ...new Set(
      candidates.flatMap(({ fromTrackId, toTrackId }) => [
        fromTrackId,
        toTrackId,
      ]),
    ),
  ])
  const key = (
    username: string,
    artistKey: string,
    trackKey: string,
    recordId: string,
  ) => JSON.stringify([username, artistKey, trackKey, recordId])
  const rejected = new Set(
    RejectionRowsSchema.parse(
      (
        await reader.execute(sql`
          select j.username, j.artist_key, j.track_key, j.record_id
          from library_match_rejection j
          join jsonb_to_recordset(${JSON.stringify(
            candidates.map(({ username, artistKey, trackKey, toTrackId }) => ({
              username,
              artistKey,
              trackKey,
              toTrackId,
            })),
          )}::jsonb) as r(username text, "artistKey" text, "trackKey" text,
            "toTrackId" text)
            on j.username = r.username and j.artist_key = r."artistKey"
              and j.track_key = r."trackKey" and j.record_id = r."toTrackId"`)
      ).rows,
    ).map((row) =>
      key(row.username, row.artist_key, row.track_key, row.record_id),
    ),
  )
  return (candidate) =>
    !separate(candidate.fromTrackId, candidate.toTrackId) &&
    !rejected.has(
      key(
        candidate.username,
        candidate.artistKey,
        candidate.trackKey,
        candidate.toTrackId,
      ),
    )
}

const FollowRowsSchema = z.array(
  z.object({
    artist_key: z.string(),
    track_key: z.string(),
    artist_name: z.string(),
    track_name: z.string(),
    scrobbles: z.number().int().nonnegative(),
    owner_id: z.string(),
    manual: z.boolean(),
    owner_albums: z.array(z.object({ id: z.string(), title: z.string() })),
  }),
)
const RecordingRowsSchema = z.array(
  z.object({
    id: z.string(),
    title: z.string(),
    artists: z.array(z.string()),
    positions: z.array(
      z.object({
        albumId: z.string(),
        title: z.string(),
        position: z.number().int(),
      }),
    ),
  }),
)

type Track = { id: string; title: string }

/** A track name that follows its album name, with its stored keys. */
export type FollowedName = AlbumMergeFollow & {
  artistKey: string
  trackKey: string
}

/** A followed name as the owner reads it. */
export type FollowedNameShown = {
  artistName: string
  trackName: string
}

/** What following the album names onto an album's tracks would move. */
export type FollowPlan = {
  also: FollowedName[]
  unmatched: AlbumMergeUnmatched[]
  /** Followed names now on a track of an album outside the record. */
  elsewhere: (FollowedNameShown & { albumTitle: string })[]
  /** Names that stay because more than one track of the album matches. */
  ambiguous: FollowedNameShown[]
}

/** Who the follow leaves out, for a merge that moves some names itself. */
export type FollowScope = {
  /** Names these tracks own neither follow nor stay: the merge moves them. */
  skipOwners?: string[]
  /** Tracks the merge removes, and the track that takes their positions. */
  retarget?: { from: string[]; to: { id: string; title: string } }
}

/**
 * The track names scrobbled under the album names, matched to the album's
 * track list with the album track alias matcher. A name already on its
 * matching track neither follows nor stays, and a name the owner's decisions
 * keep off its match stays. `recordIds` are the albums of the record once the
 * change is made.
 */
export async function readFollowPlan(
  reader: ChangeReader,
  account: string,
  keys: AlbumNameKey[],
  albumId: string,
  recordIds: string[],
  { skipOwners = [], retarget }: FollowScope = {},
): Promise<FollowPlan> {
  const plan: FollowPlan = {
    also: [],
    unmatched: [],
    elsewhere: [],
    ambiguous: [],
  }
  if (!keys.length) return plan
  const skipped = new Set(skipOwners)
  const names = FollowRowsSchema.parse(
    (
      await reader.execute(sql`
        with named as (
          select distinct s.artist_key, s.track_key
          from lastfm_scrobble s join ${keysInput(keys)}
            on s.artist_key = k."artistKey" and s.album_key = k."albumKey"
          where s.username = ${account})
        select n.artist_key, n.track_key, max(e.artist_name) as artist_name,
          max(e.track_name) as track_name, count(*)::int as scrobbles,
          o.track_media_item_id as owner_id, o.manually_matched as manual,
          coalesce((
            select jsonb_agg(distinct jsonb_build_object('id', t.album_media_item_id,
              'title', am.title))
            from track t join media_item am on am.id = t.album_media_item_id
            where t.track_media_item_id = o.track_media_item_id), '[]'::jsonb)
            as owner_albums
        from named n
        join lastfm_track_source o on o.username = ${account}
          and o.artist_key = n.artist_key and o.track_key = n.track_key
        join lastfm_scrobble e on e.username = o.username
          and e.artist_key = n.artist_key and e.track_key = n.track_key
        group by n.artist_key, n.track_key, o.track_media_item_id,
          o.manually_matched
        order by count(*) desc, max(e.track_name), max(e.artist_name)`)
    ).rows,
  ).filter((name) => !skipped.has(name.owner_id))
  const recordings = RecordingRowsSchema.parse(
    (
      await reader.execute(sql`
        select lt.media_item_id as id, mi.title,
          coalesce((
            select array_agg(a.name order by c.billing_order, a.id)
            from media_credit c join artist a on a.id = c.artist_id
            where c.media_item_id = lt.media_item_id and c.role = 'artist'),
            '{}') as artists,
          jsonb_agg(jsonb_build_object('albumId', t.album_media_item_id,
            'title', t.title, 'position', t.position)) as positions
        from track t
        join library_track lt on lt.media_item_id = t.track_media_item_id
        join media_item mi on mi.id = lt.media_item_id
        where t.album_media_item_id = ${albumId}
        group by lt.media_item_id, mi.title`)
    ).rows,
  )
  const scrobbled = names.map((name) => ({
    artist_key: name.artist_key,
    track_key: name.track_key,
    album_ids: [albumId],
    has_unlinked_album: false,
  }))
  const match = createAlbumTrackAliasMatcher(
    recordings,
    scrobbled,
    new Map(
      names
        .filter((name) => name.manual)
        .map((name) => [JSON.stringify([name.artist_key, name.track_key]), '']),
    ),
  )
  // Positions of the album by title, as the matcher compares them.
  const slots = new Map<string, number>()
  for (const recording of recordings)
    for (const entry of recording.positions) {
      const title = titleCredit(albumNameKey(entry.title)).title
      slots.set(title, (slots.get(title) ?? 0) + 1)
    }
  const ambiguous = (trackKey: string) =>
    !parseTrackNumberPrefix(trackKey) &&
    (slots.get(titleCredit(trackKey).title) ?? 0) > 1
  const removed = new Set(retarget?.from ?? [])
  const matched = names.map((_, index): Track | undefined => {
    const scrobbledName = scrobbled[index]
    const target = scrobbledName ? match(scrobbledName) : undefined
    return target && retarget && removed.has(target.id) ? retarget.to : target
  })
  const allowed = await readFollowDecisions(
    reader,
    names.flatMap((name, index) => {
      const target = matched[index]
      return target && target.id !== name.owner_id
        ? [
            {
              username: account,
              artistKey: name.artist_key,
              trackKey: name.track_key,
              fromTrackId: name.owner_id,
              toTrackId: target.id,
            },
          ]
        : []
    }),
  )
  const record = new Set(recordIds)
  names.forEach((name, index) => {
    const target = matched[index]
    const shown = {
      artistName: name.artist_name,
      trackName: name.track_name,
      scrobbles: name.scrobbles,
    }
    const follows =
      target !== undefined &&
      allowed({
        username: account,
        artistKey: name.artist_key,
        trackKey: name.track_key,
        fromTrackId: name.owner_id,
        toTrackId: target.id,
      })
    if (!target || !follows) {
      plan.unmatched.push({ ...shown, trackId: name.owner_id })
      if (!target && ambiguous(name.track_key))
        plan.ambiguous.push({
          artistName: name.artist_name,
          trackName: name.track_name,
        })
      return
    }
    if (target.id === name.owner_id) return
    plan.also.push({
      ...shown,
      artistKey: name.artist_key,
      trackKey: name.track_key,
      fromTrackId: name.owner_id,
      toTrackId: target.id,
      toTitle: target.title,
    })
    const other = name.owner_albums.find((album) => !record.has(album.id))
    if (other)
      plan.elsewhere.push({
        artistName: name.artist_name,
        trackName: name.track_name,
        albumTitle: other.title,
      })
  })
  return plan
}

const TargetAlbumRowsSchema = z.array(
  z.object({
    id: z.string(),
    title: z.string(),
    track_title: z.string(),
    record_ids: z.array(z.string()),
  }),
)
const CarriedNameRowsSchema = z.array(
  z.object({
    username: z.string(),
    artistKey: z.string(),
    albumKey: z.string(),
    artistName: z.string(),
    albumName: z.string(),
    scrobbles: z.number().int().nonnegative(),
    albumId: z.string().nullable(),
    follows: z.boolean(),
  }),
)

/** An album name that is merged with the titles a track merge merges. */
export type TrackFollow = {
  account: string
  albumId: string
  albumTitle: string
  names: AlbumNameState[]
  follow: FollowPlan
}

/**
 * What follows a track merge: the album names the merged tracks' names were
 * scrobbled under move to the album of the track to keep, with the other
 * titles under them that match a track of that album. Only an album name
 * that is linked to no album follows: a name linked to an album, or decided
 * by the owner, stays where it is. Nothing follows when the track to keep is
 * on no album. One entry per Last.fm account.
 */
export async function readTrackFollows(
  reader: ChangeReader,
  {
    targetId,
    mergedIds,
    selectedIds,
  }: { targetId: string; mergedIds: string[]; selectedIds: string[] },
): Promise<TrackFollow[]> {
  if (!mergedIds.length) return []
  const [album] = TargetAlbumRowsSchema.parse(
    (
      await reader.execute(sql`
        select al.media_item_id as id, mi.title, ti.title as track_title,
          array(select r.media_item_id from album r
            where coalesce(al.edition_of_id, al.media_item_id)
              in (r.media_item_id, r.edition_of_id)
            order by r.media_item_id) as record_ids
        from library_track lt
        join media_item ti on ti.id = lt.media_item_id
        join album al on al.media_item_id = lt.album_media_item_id
        join media_item mi on mi.id = al.media_item_id
        where lt.media_item_id = ${targetId}
          and mi.metadata->>'legacyHidden' is distinct from 'true'`)
    ).rows,
  )
  if (!album) return []
  const carried = CarriedNameRowsSchema.parse(
    (
      await reader.execute(sql`
        with carried as (
          select distinct e.username, e.artist_key, e.album_key
          from lastfm_track_source s
          join lastfm_scrobble e on e.username = s.username
            and e.artist_key = s.artist_key and e.track_key = s.track_key
          where s.track_media_item_id in (${idList(mergedIds)})
            and e.album_key is not null and e.album_key <> '')
        select c.username, c.artist_key as "artistKey",
          c.album_key as "albumKey", max(e.artist_name) as "artistName",
          coalesce(max(e.album_name), c.album_key) as "albumName",
          count(*)::int as scrobbles, l.album_media_item_id as "albumId",
          (l.username is null or (l.source <> 'manual'
            and l.album_media_item_id is null))
            and not exists (select 1 from media_override o
              where o.media_item_id = ${album.id}
                and o.field = 'albumListeningLinkRejection'
                and o.value->>'artistKey' = c.artist_key
                and o.value->>'albumKey' = c.album_key) as follows
        from carried c
        join lastfm_scrobble e on e.username = c.username
          and e.artist_key = c.artist_key and e.album_key = c.album_key
        left join lastfm_album_link l on l.username = c.username
          and l.artist_key = c.artist_key and l.album_key = c.album_key
        group by c.username, c.artist_key, c.album_key, l.username,
          l.album_media_item_id, l.source
        order by count(*) desc, max(e.album_name), c.artist_key, c.album_key`)
    ).rows,
  ).filter((name) => name.follows)
  const follows: TrackFollow[] = []
  for (const account of new Set(carried.map((name) => name.username))) {
    const names = carried
      .filter((name) => name.username === account)
      .map(
        ({
          artistKey,
          albumKey,
          artistName,
          albumName,
          scrobbles,
          albumId,
        }) => ({
          artistKey,
          albumKey,
          artistName,
          albumName,
          scrobbles,
          albumId,
        }),
      )
    follows.push({
      account,
      albumId: album.id,
      albumTitle: album.title,
      names,
      follow: await readFollowPlan(
        reader,
        account,
        names,
        album.id,
        album.record_ids,
        {
          skipOwners: selectedIds,
          retarget: {
            from: mergedIds,
            to: { id: targetId, title: album.track_title },
          },
        },
      ),
    })
  }
  return follows
}

const ArtistTrackRowsSchema = z.array(
  z.object({
    id: z.string(),
    title: z.string(),
    group_id: z.string().nullable(),
    shown: z.boolean(),
    identity: z.boolean(),
  }),
)
type ArtistTrack = z.infer<typeof ArtistTrackRowsSchema>[number]
const ArtistNameRowsSchema = z.array(
  z.object({
    username: z.string(),
    artist_key: z.string(),
    track_key: z.string(),
    artist_name: z.string(),
    track_name: z.string(),
    scrobbles: z.number().int().nonnegative(),
    owner_id: z.string(),
  }),
)

/** A scrobbled name that follows an artist merge, with its account. */
export type ArtistFollowedName = FollowedName & { username: string }

/**
 * What follows an artist merge: the names of the merged artists' Last.fm-only
 * tracks move to the one track of the kept artist with the same title. A
 * track with its own Spotify track, album position or playlist entry stays,
 * and so does a title more than one record of the kept artist has. A record
 * with a Spotify track or another source counts before Last.fm-only tracks.
 */
export async function readArtistFollows(
  reader: ChangeReader,
  { targetId, sourceIds }: { targetId: string; sourceIds: string[] },
): Promise<ArtistFollowedName[]> {
  if (!sourceIds.length) return []
  const visible = sql`mi.media_type = 'track'
    and mi.metadata->>'legacyHidden' is distinct from 'true'`
  const credited = (ids: string[]) => sql`exists (select 1 from media_credit c
    where c.media_item_id = mi.id and c.role = 'artist'
      and c.artist_id in (${idList(ids)}))`
  const from = ArtistTrackRowsSchema.parse(
    (
      await reader.execute(sql`
        select mi.id, mi.title, lt.version_group_id as group_id,
          lt.version_shown as shown,
          (lt.spotify_track_id is not null
            or mi.source_label is distinct from 'lastfm') as identity
        from library_track lt join media_item mi on mi.id = lt.media_item_id
        where ${visible} and lt.spotify_track_id is null
          and mi.source_label is not distinct from 'lastfm'
          and ${credited(sourceIds)}
          and not exists (select 1 from media_credit c
            where c.media_item_id = mi.id and c.artist_id = ${targetId})
          and not exists (select 1 from track t
            where t.track_media_item_id = mi.id)
          and not exists (select 1 from playlist_item p
            where p.media_item_id = mi.id)
        order by mi.id`)
    ).rows,
  )
  if (!from.length) return []
  const kept = ArtistTrackRowsSchema.parse(
    (
      await reader.execute(sql`
        select mi.id, mi.title, lt.version_group_id as group_id,
          lt.version_shown as shown,
          (lt.spotify_track_id is not null
            or mi.source_label is distinct from 'lastfm') as identity
        from library_track lt join media_item mi on mi.id = lt.media_item_id
        where ${visible} and ${credited([targetId])}
        order by mi.id`)
    ).rows,
  )
  // Versions of one record are one match: the version shown, else the first.
  const records = new Map<string, Map<string, ArtistTrack>>()
  for (const track of kept) {
    const title = trackVersionKey(track.title)
    const byRecord = records.get(title) ?? new Map<string, ArtistTrack>()
    const record = track.group_id ?? track.id
    const known = byRecord.get(record)
    if (!known || (track.shown && !known.shown)) byRecord.set(record, track)
    records.set(title, byRecord)
  }
  const targets = new Map(
    from.flatMap((track) => {
      const matches = [
        ...(records.get(trackVersionKey(track.title))?.values() ?? []),
      ]
      const identified = matches.filter((match) => match.identity)
      const [only, other] = identified.length ? identified : matches
      return only && !other ? [[track.id, only]] : []
    }),
  )
  if (!targets.size) return []
  const names = ArtistNameRowsSchema.parse(
    (
      await reader.execute(sql`
        select s.username, s.artist_key, s.track_key,
          coalesce(max(e.artist_name), s.artist_key) as artist_name,
          coalesce(max(e.track_name), s.track_key) as track_name,
          count(e.id)::int as scrobbles, s.track_media_item_id as owner_id
        from lastfm_track_source s
        left join lastfm_scrobble e on e.username = s.username
          and e.artist_key = s.artist_key and e.track_key = s.track_key
        where s.track_media_item_id in (${idList([...targets.keys()])})
        group by s.username, s.artist_key, s.track_key, s.track_media_item_id
        order by count(e.id) desc, max(e.track_name), s.username,
          s.artist_key, s.track_key`)
    ).rows,
  )
  const candidates = names.flatMap((name) => {
    const target = targets.get(name.owner_id)
    return target
      ? [
          {
            username: name.username,
            artistKey: name.artist_key,
            trackKey: name.track_key,
            artistName: name.artist_name,
            trackName: name.track_name,
            scrobbles: name.scrobbles,
            fromTrackId: name.owner_id,
            toTrackId: target.id,
            toTitle: target.title,
          },
        ]
      : []
  })
  const allowed = await readFollowDecisions(reader, candidates)
  return candidates.filter(allowed)
}
