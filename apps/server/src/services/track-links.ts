import { inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import {
  TrackAlbumLinkStrategySchema,
  TrackScrobbleLinkStrategySchema,
  type TrackScrobbleNameKey,
} from '@repo/schemas/tracks'
import { db } from '@/lib/db'
import { refreshArtistListeningTotals } from './artist-listening'
import { importLastfmLibraryTracks } from './lastfm-library-tracks'
import {
  lockLibraryTrackWrites,
  reconcileSpotifyAlbumRecordings,
} from './album-library-tracks'
import { closeChangeBatch, openChangeBatch } from './library-changes'
import { readRejectionTest } from './library-match-rejections'
import { spotifyAlbumId } from '@/lib/spotify-api'
import {
  createScrobbleTrackMatcher,
  createTrackAlbumMatcher,
} from '@/lib/track-matching'

const WRITE_BATCH = 1000
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

const AlbumRowsSchema = z.array(
  z.object({
    id: z.string(),
    title: z.string(),
    release_date: z.string().nullable(),
    spotify_url: z.string().nullable(),
    artists: z.array(z.string()),
    spotify_album_ids: z.array(z.string()),
    tracks: z.array(
      z.object({ title: z.string(), externalId: z.string().nullable() }),
    ),
  }),
)
const TrackRowsSchema = z.array(
  z.object({
    id: z.string(),
    title: z.string(),
    spotify_track_id: z.string().nullable(),
    source_label: z.string().nullable(),
    spotify_album_id: z.string().nullable(),
    album_name: z.string().nullable(),
    album_id: z.string().nullable(),
    listed_album_ids: z.array(z.string()),
    strategy: TrackAlbumLinkStrategySchema.nullable(),
    artists: z.array(z.string()),
  }),
)
const ScrobbledRowsSchema = z.array(
  z.object({
    artist_key: z.string(),
    track_key: z.string(),
    artist_name: z.string(),
    track_name: z.string(),
    album_ids: z.array(z.string()),
  }),
)
const LinkRowsSchema = z.array(
  z.object({
    artist_key: z.string(),
    track_key: z.string(),
    track_id: z.string(),
    strategy: TrackScrobbleLinkStrategySchema,
  }),
)

async function libraryTracks(database: Transaction) {
  return TrackRowsSchema.parse(
    (
      await database.execute(sql`
        select lt.media_item_id as id, mi.title, mi.source_label, lt.spotify_track_id,
          lt.spotify_album_id, lt.album_name,
          lt.album_media_item_id as album_id,
          array(select distinct t.album_media_item_id from track t
            where t.track_media_item_id = lt.media_item_id order by t.album_media_item_id) as listed_album_ids,
          lt.album_link_strategy as strategy,
          coalesce((
            select array_agg(a.name order by c.billing_order)
            from media_credit c join artist a on a.id = c.artist_id
            where c.media_item_id = lt.media_item_id and c.role = 'artist'), '{}') as artists
        from library_track lt join media_item mi on mi.id = lt.media_item_id`)
    ).rows,
  )
}

/**
 * Recomputes the library album of every track from the albums' Spotify IDs,
 * titles, credited artists and track lists. Albums added later pick up their
 * tracks; a track whose album left the library is unlinked.
 */
export async function linkTracksToAlbums(batchId: string | null = null) {
  await db.transaction(async (tx) => {
    await lockLibraryTrackWrites(tx)
    await reconcileSpotifyAlbumRecordings(tx, undefined, batchId)
    const tracks = await libraryTracks(tx)
    if (!tracks.length) return
    const albums = AlbumRowsSchema.parse(
      (
        await tx.execute(sql`
        select mi.id, mi.title,
          to_char(mi.release_date, 'YYYY-MM-DD') as release_date,
          al.spotify_url,
          coalesce((
            select array_agg(a.name order by c.billing_order)
            from media_credit c join artist a on a.id = c.artist_id
            where c.media_item_id = mi.id and c.role = 'artist'), '{}') as artists,
          coalesce((
            select array_agg(r.external_id) from provider_reference r
            where r.media_item_id = mi.id and (r.reference_type = 'spotify'
              or (r.provider = 'spotify' and r.reference_type = 'album'))), '{}') as spotify_album_ids,
          coalesce((
            select jsonb_agg(jsonb_build_object(
              'title', t.title, 'externalId', t.external_id))
            from track t where t.album_media_item_id = mi.id), '[]'::jsonb) as tracks
        from media_item mi join album al on al.media_item_id = mi.id
        where mi.media_type = 'album'
          and mi.metadata->>'legacyHidden' is distinct from 'true'`)
      ).rows,
    )
    const match = createTrackAlbumMatcher(
      albums.map((album) => {
        const linked = album.spotify_url
          ? spotifyAlbumId(album.spotify_url)
          : null
        return {
          id: album.id,
          title: album.title,
          releaseDate: album.release_date,
          artists: album.artists,
          spotifyAlbumIds: [
            ...album.spotify_album_ids,
            ...(linked ? [linked] : []),
          ],
          tracks: album.tracks,
        }
      }),
    )
    const changes = tracks
      .filter(
        (track) =>
          track.source_label !== 'lastfm' || track.listed_album_ids.length > 0,
      )
      .flatMap((track) => {
        if (
          track.strategy === 'album-track-list' &&
          track.album_id &&
          track.listed_album_ids.includes(track.album_id)
        ) {
          return []
        }
        const result = match({
          spotifyTrackId: track.spotify_track_id,
          spotifyAlbumId: track.spotify_album_id,
          title: track.title,
          albumName: track.album_name,
          artists: track.artists,
        })
        const listedAlbum = [
          track.album_id,
          result?.albumId,
          ...track.listed_album_ids,
        ].find((id) => id != null && track.listed_album_ids.includes(id))
        const albumId = listedAlbum ?? result?.albumId ?? null
        const strategy = listedAlbum
          ? 'album-track-list'
          : (result?.strategy ?? null)
        return albumId === track.album_id && strategy === track.strategy
          ? []
          : [{ id: track.id, album_id: albumId, strategy }]
      })
    for (let start = 0; start < changes.length; start += WRITE_BATCH) {
      // An album deleted since it was read is skipped; the next relink unlinks it.
      await tx.execute(sql`
      update library_track lt
      set album_media_item_id = r.album_id, album_link_strategy = r.strategy,
        updated_at = now()
      from jsonb_to_recordset(${JSON.stringify(
        changes.slice(start, start + WRITE_BATCH),
      )}::jsonb) as r(id text, album_id text, strategy text)
      where lt.media_item_id = r.id and (r.album_id is null or exists (
        select 1 from album a where a.media_item_id = r.album_id))`)
    }
  })
}

const linkKey = (row: {
  artist_key: string
  track_key: string
  track_id: string
}) => JSON.stringify([row.artist_key, row.track_key, row.track_id])

/**
 * Recomputes which scrobbled artist and track names count towards each
 * library track, then each track's scrobble count and last listen. Only
 * changed links are written.
 */
export async function linkScrobblesToTracks(account: string) {
  await db.transaction((tx) => writeScrobbleTrackLinks(tx, account))
}

export async function writeScrobbleTrackLinks(
  tx: Transaction,
  account: string,
  name?: TrackScrobbleNameKey | TrackScrobbleNameKey[],
) {
  const names = name === undefined || Array.isArray(name) ? name : [name]
  if (names?.length === 0) return
  // Read and write under the identity writer lock so an in-flight relink
  // cannot overwrite a manual merge computed from newer source memberships.
  await lockLibraryTrackWrites(tx)
  const nameFilter = names
    ? sql`and (artist_key, track_key) in (${sql.join(
        names.map(
          ({ artistKey, trackKey }) => sql`(${artistKey}, ${trackKey})`,
        ),
        sql`, `,
      )})`
    : sql``
  const tracks = await libraryTracks(tx)
  const scrobbled = tracks.length
    ? ScrobbledRowsSchema.parse(
        (
          await tx.execute(sql`
            select s.artist_key, s.track_key,
              max(s.artist_name) as artist_name,
              max(s.track_name) as track_name,
              coalesce(array_agg(distinct s.album_media_item_id)
                filter (where s.album_media_item_id is not null), '{}') as album_ids
            from lastfm_scrobble s where s.username = ${account} ${nameFilter}
            group by s.artist_key, s.track_key`)
        ).rows,
      )
    : []
  const match = createScrobbleTrackMatcher(
    tracks
      .filter(
        (track) =>
          track.source_label !== 'lastfm' || track.listed_album_ids.length > 0,
      )
      .flatMap((track) =>
        [...new Set([track.album_id, ...track.listed_album_ids])].map(
          (albumId) => ({
            id: track.id,
            title: track.title,
            artists: track.artists,
            albumId,
          }),
        ),
      ),
  )
  // Manual choices are exclusive for their stored names, even if the chosen
  // Spotify recording's artist, title or album differs from the scrobble.
  const sources = LinkRowsSchema.parse(
    (
      await tx.execute(sql`
    select artist_key, track_key, track_media_item_id as track_id,
      case when manually_matched then 'manual' else 'exact' end as strategy
    from lastfm_track_source where username = ${account} ${nameFilter}`)
    ).rows,
  )
  const manualNames = new Set(
    sources
      .filter((source) => source.strategy === 'manual')
      .map((source) => JSON.stringify([source.artist_key, source.track_key])),
  )
  // A match the owner undid or separated credits no plays.
  const rejected = await readRejectionTest(tx, account)
  const wanted = new Map(
    scrobbled.flatMap((row) => {
      if (manualNames.has(JSON.stringify([row.artist_key, row.track_key])))
        return []
      const result = match({
        artistName: row.artist_name,
        trackName: row.track_name,
        albumIds: row.album_ids,
      })
      return (result?.trackIds ?? [])
        .filter((trackId) => !rejected(row.artist_key, row.track_key, trackId))
        .map((trackId) => {
          const link = {
            artist_key: row.artist_key,
            track_key: row.track_key,
            track_id: trackId,
            strategy: result?.strategy ?? 'exact',
          }
          return [linkKey(link), link]
        })
    }),
  )
  // Imported Last.fm identities always retain their own history, even when
  // broader listening rules also count that name towards Spotify editions.
  for (const source of sources) wanted.set(linkKey(source), source)
  // A name also counts for every other version of its owner's record.
  const records = LinkRowsSchema.parse(
    (
      await tx.execute(sql`
        select s.artist_key, s.track_key, other.media_item_id as track_id,
          'record' as strategy
        from lastfm_track_source s
        join library_track owner on owner.media_item_id = s.track_media_item_id
        join library_track other on other.version_group_id = owner.version_group_id
          and other.media_item_id <> owner.media_item_id
        where s.username = ${account} ${nameFilter}`)
    ).rows,
  )
  for (const record of records)
    if (
      !wanted.has(linkKey(record)) &&
      !rejected(record.artist_key, record.track_key, record.track_id)
    )
      wanted.set(linkKey(record), record)
  const stored = LinkRowsSchema.parse(
    (
      await tx.execute(sql`
        select artist_key, track_key, track_media_item_id as track_id, strategy
        from lastfm_track_link where username = ${account} ${nameFilter}`)
    ).rows,
  )
  const current = new Map(stored.map((row) => [linkKey(row), row]))
  const removed = stored.filter(
    (row) => wanted.get(linkKey(row))?.strategy !== row.strategy,
  )
  const added = [...wanted.values()].filter(
    (row) => current.get(linkKey(row))?.strategy !== row.strategy,
  )
  for (let start = 0; start < removed.length; start += WRITE_BATCH)
    await tx.execute(sql`
        delete from lastfm_track_link l
        using jsonb_to_recordset(${JSON.stringify(
          removed.slice(start, start + WRITE_BATCH),
        )}::jsonb) as r(artist_key text, track_key text, track_id text)
        where l.username = ${account} and l.artist_key = r.artist_key
          and l.track_key = r.track_key and l.track_media_item_id = r.track_id`)
  for (let start = 0; start < added.length; start += WRITE_BATCH)
    // A track removed since it was read is skipped, not a failed relink.
    await tx.execute(sql`
        insert into lastfm_track_link (username, artist_key, track_key,
          track_media_item_id, strategy)
        select ${account}, r.artist_key, r.track_key, r.track_id, r.strategy
        from jsonb_to_recordset(${JSON.stringify(
          added.slice(start, start + WRITE_BATCH),
        )}::jsonb) as r(artist_key text, track_key text, track_id text,
          strategy text)
        where exists (
          select 1 from library_track lt where lt.media_item_id = r.track_id)
        on conflict do nothing`)
  await refreshTrackListeningTotals(
    tx,
    names
      ? [...new Set([...stored, ...wanted.values()].map((row) => row.track_id))]
      : undefined,
  )
}

const NameRowsSchema = z.array(
  z.object({
    username: z.string(),
    artist_key: z.string(),
    track_key: z.string(),
  }),
)

/**
 * Relinks the names of the given tracks' records after their versions
 * changed: the names the tracks and their versions own, and the names that
 * counted for the tracks as another version.
 */
export async function relinkTrackRecords(tx: Transaction, trackIds: string[]) {
  if (!trackIds.length) return
  const given = sql.join(
    trackIds.map((id) => sql`${id}`),
    sql`, `,
  )
  const names = NameRowsSchema.parse(
    (
      await tx.execute(sql`
        select s.username, s.artist_key, s.track_key
        from lastfm_track_source s where s.track_media_item_id in (
          select unnest(array[${given}]::text[])
          union
          select other.media_item_id from library_track lt
          join library_track other on other.version_group_id = lt.version_group_id
          where lt.media_item_id in (${given}))
        union
        select username, artist_key, track_key from lastfm_track_link
        where strategy = 'record' and track_media_item_id in (${given})`)
    ).rows,
  )
  for (const username of new Set(names.map((name) => name.username)))
    await writeScrobbleTrackLinks(
      tx,
      username,
      names
        .filter((name) => name.username === username)
        .map((name) => ({
          artistKey: name.artist_key,
          trackKey: name.track_key,
        })),
    )
}

/** Recount links after an identity change; never add already-counted summaries. */
export async function refreshTrackListeningTotals(
  tx: Transaction,
  trackIds?: string[],
) {
  await tx.execute(sql`
      update library_track lt
      set scrobble_count = coalesce(c.count, 0), last_listened_at = c.last
      from library_track base
      left join (
        select l.track_media_item_id as id, count(*)::int as count,
          max(s.listened_at) as last
        from lastfm_track_link l
        join lastfm_scrobble s on s.username = l.username
          and s.artist_key = l.artist_key and s.track_key = l.track_key
        ${trackIds ? sql`where ${inArray(sql`l.track_media_item_id`, trackIds)}` : sql``}
        group by l.track_media_item_id
      ) c on c.id = base.media_item_id
      where lt.media_item_id = base.media_item_id
        ${trackIds ? sql`and ${inArray(sql`lt.media_item_id`, trackIds)}` : sql``}
        and (lt.scrobble_count <> coalesce(c.count, 0)
          or lt.last_listened_at is distinct from c.last)`)
}

/**
 * Relinks tracks to albums, then scrobbles to tracks, then recounts each
 * artist's scrobbles from the links and credits as they now stand. `account`
 * is the configured Last.fm account, or null to leave track listening
 * untouched. The automatic changes are recorded as one run of `trigger`.
 */
export async function refreshTrackLinks(
  account: string | null,
  trigger = 'relink',
) {
  const batchId = await db.transaction((tx) => openChangeBatch(tx, trigger))
  await linkTracksToAlbums(batchId)
  if (account) {
    await importLastfmLibraryTracks(account, batchId)
    await linkScrobblesToTracks(account)
  }
  await refreshArtistListeningTotals(db)
  await closeChangeBatch(db, batchId)
}
