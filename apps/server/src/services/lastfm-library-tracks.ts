import { inArray, sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { SPOTIFY_TRACK_SEARCH_TASK } from '@repo/schemas/spotify-track-search'
import type { TrackScrobbleNameKey } from '@repo/schemas/tracks'
import { db } from '@/lib/db'
import {
  createAlbumTrackAliasMatcher,
  splitScrobbleCredit,
} from '@/lib/album-track-aliases'
import { albumNameKey } from '@/lib/album-import-candidates'
import { createStableId, slugifyParts } from '@/lib/media-utils'
import { standaloneLastfmTrackId } from '@/lib/track-matching'
import {
  artist,
  lastfmTrackSource,
  libraryTrack,
  mediaItem,
} from '@/schemas/db'
import { refreshTrackAddedDates } from './spotify-playlists'
import { refreshArtistListeningTotals } from './artist-listening'
import {
  lockLibraryTrackWrites,
  removeOrphanTracks,
} from './album-library-tracks'
import { refreshTrackListeningTotals } from './track-links'

const WRITE_BATCH = 500
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
const ScrobbledRowsSchema = z.array(
  z.object({
    artist_key: z.string(),
    track_key: z.string(),
    artist_name: z.string(),
    track_name: z.string(),
    album_names: z.array(z.string()),
    album_ids: z.array(z.string()),
    has_unlinked_album: z.boolean(),
  }),
)
const CandidateRowsSchema = z.array(
  z.object({
    id: z.string(),
    title: z.string(),
    artists: z.array(z.string()),
    album_name: z.string().nullable(),
    album_id: z.string().nullable(),
    positions: z.array(
      z.object({
        albumId: z.string(),
        title: z.string(),
        position: z.number().int(),
      }),
    ),
    album_only: z.boolean(),
  }),
)
const ManualRowsSchema = z.array(
  z.object({
    artist_key: z.string(),
    track_key: z.string(),
    track_id: z.string(),
  }),
)
const CatalogMatchRowsSchema = z.array(
  ManualRowsSchema.element.extend({ source_id: z.string() }),
)
const PendingAlbumSourcesSchema = z.array(
  z.object({
    username: z.string(),
    artist_key: z.string(),
    track_key: z.string(),
    source_id: z.string(),
    album_id: z.string(),
  }),
)
const AlbumScrobbledNamesSchema = z.array(
  ScrobbledRowsSchema.element.extend({
    username: z.string(),
    manually_matched: z.boolean(),
  }),
)
const ArtistIdsSchema = z.array(z.object({ artist_id: z.string() }))
const scrobbledColumns = sql`
  max(s.artist_name) as artist_name, max(s.track_name) as track_name,
  coalesce(array_agg(distinct s.album_name order by s.album_name)
    filter (where nullif(trim(s.album_name), '') is not null), '{}') as album_names,
  bool_or(nullif(trim(s.album_name), '') is not null and s.album_media_item_id is null) as has_unlinked_album,
  coalesce(array_agg(distinct s.album_media_item_id)
    filter (where s.album_media_item_id is not null), '{}') as album_ids`

type ScrobbledName = z.infer<typeof ScrobbledRowsSchema>[number]
type Recording = z.infer<typeof CandidateRowsSchema>[number]

async function readCandidates(tx: Transaction, filter: SQL = sql``) {
  return CandidateRowsSchema.parse(
    (
      await tx.execute(sql`
      select lt.media_item_id as id, mi.title, coalesce(lt.album_name, am.title) as album_name,
        lt.album_media_item_id as album_id,
        coalesce((select jsonb_agg(jsonb_build_object('albumId', t.album_media_item_id,
          'title', t.title, 'position', t.position)) from track t
          where t.track_media_item_id = lt.media_item_id), '[]'::jsonb) as positions,
        mi.source_label is distinct from 'spotify' and lt.spotify_track_id is null as album_only,
        coalesce((select array_agg(a.name order by c.billing_order, a.id) from media_credit c
          join artist a on a.id = c.artist_id
          where c.media_item_id = mi.id and c.role = 'artist'), '{}') as artists
      from library_track lt join media_item mi on mi.id = lt.media_item_id
      left join media_item am on am.id = lt.album_media_item_id
      where mi.metadata->>'legacyHidden' is distinct from 'true'
        and (lt.spotify_track_id is not null or exists (
          select 1 from track t where t.track_media_item_id = lt.media_item_id))
        ${filter}`)
    ).rows,
  )
}

function findExactMatches(candidates: Recording[]) {
  const byName = new Map<string, Recording[]>()
  const key = (artist: string, title: string) =>
    JSON.stringify([albumNameKey(artist), albumNameKey(title)])
  for (const candidate of candidates) {
    for (const name of new Set(candidate.artists.map(albumNameKey))) {
      const identity = key(name, candidate.title)
      byName.set(identity, [...(byName.get(identity) ?? []), candidate])
    }
  }
  return (group: ScrobbledName) => {
    const named = byName.get(key(group.artist_name, group.track_name)) ?? []
    return named.filter(
      (candidate) =>
        (group.album_names.length === 0 && !candidate.album_only) ||
        (!group.has_unlinked_album &&
          group.album_ids.length === 1 &&
          (group.album_ids[0] === candidate.album_id ||
            candidate.positions.some(
              (entry) => entry.albumId === group.album_ids[0],
            ))) ||
        group.album_names.every(
          (name) =>
            candidate.album_name !== null &&
            albumNameKey(name) === albumNameKey(candidate.album_name),
        ),
    )
  }
}

/** Imports stored history only; uncertain recording identities remain separate. */
export async function importLastfmLibraryTracks(account: string) {
  await db.transaction((tx) => importLastfmTrackSources(tx, account))
}

/** Reconciles safe Last.fm aliases when an album's actual positions are available. */
export async function reconcileLastfmAlbumTrackAliases(
  tx: Transaction,
  { albumId, dryRun = false }: { albumId?: string; dryRun?: boolean } = {},
) {
  if (!dryRun) await lockLibraryTrackWrites(tx)
  const pending = PendingAlbumSourcesSchema.parse(
    (
      await tx.execute(sql`
        select s.username, s.artist_key, s.track_key, s.track_media_item_id as source_id,
          lt.album_media_item_id as album_id
        from library_track lt join media_item mi on mi.id = lt.media_item_id
        join media_item release on release.id = lt.album_media_item_id
        join lastfm_track_source s on s.track_media_item_id = lt.media_item_id
        where lt.album_link_strategy = 'lastfm' and not s.manually_matched
          ${albumId === undefined ? sql`` : sql`and lt.album_media_item_id = ${albumId}`}
          and release.metadata->>'legacyHidden' is distinct from 'true'
          and exists (select 1 from track t where t.album_media_item_id = lt.album_media_item_id)
          and mi.source_label = 'lastfm' and coalesce(mi.metadata, '{}'::jsonb) = '{}'::jsonb
          and mi.release_date is null and mi.artwork_url is null and mi.summary is null
          and mi.original_title is null and lt.spotify_track_id is null and lt.isrc is null
          and lt.spotify_url is null and lt.spotify_album_id is null and lt.duration_sec is null
          and not exists (
            select 1 from lastfm_track_source other where other.track_media_item_id = lt.media_item_id
              and (other.username, other.artist_key, other.track_key) <> (s.username, s.artist_key, s.track_key)
            union all select 1 from lastfm_track_link l where l.track_media_item_id = lt.media_item_id
              and (l.username, l.artist_key, l.track_key) <> (s.username, s.artist_key, s.track_key)
            union all select 1 from lastfm_track_link manual where manual.strategy = 'manual'
              and (manual.username, manual.artist_key, manual.track_key) = (s.username, s.artist_key, s.track_key)
            union all select 1 from track where track_media_item_id = lt.media_item_id
            union all select 1 from playlist_item where media_item_id = mi.id
            union all select 1 from media_credit where media_item_id = mi.id and role <> 'artist'
            union all select 1 from media_item_tag where media_item_id = mi.id
            union all select 1 from tag_occurrence where media_item_id = mi.id
            union all select 1 from external_link where media_item_id = mi.id
            union all select 1 from provider_reference where media_item_id = mi.id
            union all select 1 from provider_snapshot where media_item_id = mi.id
            union all select 1 from provider_current_state where media_item_id = mi.id
            union all select 1 from scrape_job_item where media_item_id = mi.id
            union all select 1 from media_override where media_item_id = mi.id
            union all select 1 from provider_reference_override where media_item_id = mi.id
          )`)
    ).rows,
  ).filter(
    (row) =>
      row.source_id ===
      standaloneLastfmTrackId(row.username, {
        artistKey: row.artist_key,
        trackKey: row.track_key,
      }),
  )
  if (!pending.length) return 0

  const albums = new Map<string, Set<string>>()
  for (const { username, album_id } of pending) {
    const linked = albums.get(username) ?? new Set<string>()
    linked.add(album_id)
    albums.set(username, linked)
  }
  const releases = [...albums].flatMap(([username, ids]) =>
    [...ids].map((album_id) => ({ username, album_id })),
  )
  const albumIds = [...new Set(releases.map((row) => row.album_id))]
  // Corroborating names must come from the same account and release. Check all
  // raw events for those names, including events outside the pending albums.
  const groups = AlbumScrobbledNamesSchema.parse(
    (
      await tx.execute(sql`
        with names as (
          select distinct linked.username, linked.artist_key, linked.track_key
          from jsonb_to_recordset(${JSON.stringify(releases)}::jsonb)
            as r(username text, album_id text)
          join lastfm_scrobble linked on linked.album_media_item_id = r.album_id
            and linked.username = r.username
        )
        select n.username, n.artist_key, n.track_key, ${scrobbledColumns},
          coalesce(source.manually_matched, false) as manually_matched
        from names n join lastfm_scrobble s using (username, artist_key, track_key)
        left join lastfm_track_source source using (username, artist_key, track_key)
        group by n.username, n.artist_key, n.track_key, source.manually_matched`)
    ).rows,
  )
  const candidates = await readCandidates(
    tx,
    sql`and lt.media_item_id in (
    select listed.track_media_item_id from track listed
    where ${inArray(sql`listed.album_media_item_id`, albumIds)})`,
  )
  const identity = (username: string, artist: string, title: string) =>
    JSON.stringify([username, artist, title])
  const pendingNames = new Map(
    pending.map((row) => [
      identity(row.username, row.artist_key, row.track_key),
      row,
    ]),
  )
  const groupsByAccount = new Map<string, typeof groups>()
  for (const group of groups) {
    const names = groupsByAccount.get(group.username) ?? []
    names.push(group)
    groupsByAccount.set(group.username, names)
  }
  const proposed = [...groupsByAccount].flatMap(([username, names]) => {
    const manual = new Map(
      names
        .filter((name) => name.manually_matched)
        .map((name) => [JSON.stringify([name.artist_key, name.track_key]), '']),
    )
    const match = createAlbumTrackAliasMatcher(candidates, names, manual)
    return names.flatMap((name) => {
      const source = pendingNames.get(
        identity(username, name.artist_key, name.track_key),
      )
      const target =
        source?.album_id === name.album_ids[0] ? match(name) : undefined
      return source && target ? [{ source, target, name }] : []
    })
  })
  if (!proposed.length) return 0

  // A direct name takes precedence. Fetch only recordings with the proposed
  // raw titles, using the same title normalization as stored album matching.
  const titles = [...new Set(proposed.map(({ name }) => name.track_key))]
  const exact = findExactMatches(
    await readCandidates(
      tx,
      sql`and lt.media_item_id in (
    select named.id from media_item named
    join jsonb_array_elements_text(${JSON.stringify(titles)}::jsonb) title(key)
      on lower(btrim(regexp_replace(named.title, '[[:space:]]+', ' ', 'g'))) = title.key
    where named.media_type = 'track')`,
    ),
  )
  const moves = proposed.flatMap(({ source, target, name }) =>
    exact(name).length ? [] : [{ ...source, target_id: target.id }],
  )
  if (dryRun || !moves.length) return moves.length

  const affectedIds = [
    ...new Set(moves.flatMap((move) => [move.source_id, move.target_id])),
  ]
  const creditedArtists = ArtistIdsSchema.parse(
    (
      await tx.execute(sql`
    select distinct artist_id from media_credit
    where role = 'artist' and ${inArray(sql`media_item_id`, affectedIds)}`)
    ).rows,
  )
  for (let start = 0; start < moves.length; start += WRITE_BATCH) {
    const batch = moves.slice(start, start + WRITE_BATCH)
    const rows = sql`jsonb_to_recordset(${JSON.stringify(batch)}::jsonb)
      as alias(username text, artist_key text, track_key text, source_id text, target_id text)`
    await tx.execute(sql`
      with moved as (
        update lastfm_track_source s set track_media_item_id = alias.target_id
        from ${rows}
        where s.username = alias.username and s.artist_key = alias.artist_key
          and s.track_key = alias.track_key and s.track_media_item_id = alias.source_id
          and not s.manually_matched
        returning s.username, s.artist_key, s.track_key, s.track_media_item_id
      )
      insert into lastfm_track_link (username, artist_key, track_key, track_media_item_id, strategy)
        select username, artist_key, track_key, track_media_item_id, 'exact' from moved
      on conflict (username, artist_key, track_key, track_media_item_id) do update
        set strategy = excluded.strategy
        where lastfm_track_link.strategy is distinct from excluded.strategy`)
    await removeOrphanTracks(
      tx,
      batch.map((move) => move.source_id),
    )
  }
  const targets = [...new Set(moves.map((move) => move.target_id))]
  await refreshTrackAddedDates(tx, targets)
  await refreshTrackListeningTotals(tx, targets)
  await refreshArtistListeningTotals(
    tx,
    creditedArtists.map((row) => row.artist_id),
  )
  return moves.length
}

export async function importLastfmTrackSources(
  tx: Transaction,
  account: string,
  scope?: { name: TrackScrobbleNameKey; separate?: boolean },
) {
  // Share the playlist writer's lock so cleanup cannot remove new memberships.
  await lockLibraryTrackWrites(tx)
  const nameFilter = scope
    ? sql`and artist_key = ${scope.name.artistKey} and track_key = ${scope.name.trackKey}`
    : sql``
  const relatedArtist =
    scope &&
    (splitScrobbleCredit(scope.name.artistKey)?.primary ?? scope.name.artistKey)
  const relatedNames = scope
    ? sql`and ((artist_key = ${scope.name.artistKey} and track_key = ${scope.name.trackKey}) or artist_key = ${relatedArtist})`
    : sql``
  const previous = scope
    ? ManualRowsSchema.parse(
        (
          await tx.execute(sql`
          select artist_key, track_key, track_media_item_id as track_id
          from lastfm_track_source where username = ${account} ${nameFilter}`)
        ).rows,
      )[0]
    : undefined
  const groups = ScrobbledRowsSchema.parse(
    (
      await tx.execute(sql`
      select artist_key, track_key, ${scrobbledColumns}
      from lastfm_scrobble s where username = ${account} ${relatedNames}
      group by artist_key, track_key`)
    ).rows,
  )
  const candidates = await readCandidates(tx)
  const manual = new Map(
    ManualRowsSchema.parse(
      (
        await tx.execute(sql`
            select artist_key, track_key, track_media_item_id as track_id
            from lastfm_track_source
            where username = ${account} and manually_matched ${relatedNames}`)
      ).rows,
    ).map((row) => [
      JSON.stringify([row.artist_key, row.track_key]),
      row.track_id,
    ]),
  )
  // The accepted search applies only to the original recorded name that still
  // belongs to the accepted Spotify identity. Scoped corrections recompute it.
  const previousCatalogMatches = new Map(
    (scope
      ? []
      : CatalogMatchRowsSchema.parse(
          (
            await tx.execute(sql`
          select s.artist_key, s.track_key, s.track_media_item_id as track_id,
            j.options->>'trackId' as source_id
          from lastfm_track_source s join library_track lt on lt.media_item_id = s.track_media_item_id
          join media_item recording on recording.id = lt.media_item_id
          join scrape_job j on coalesce(j.options->>'acceptedTrackId', j.options->>'trackId') = s.track_media_item_id
            and j.options->>'acceptedSpotifyTrackId' = lt.spotify_track_id
          where s.username = ${account} and not s.manually_matched
            and recording.metadata->>'legacyHidden' is distinct from 'true'
            and j.provider = 'spotify' and j.status = 'succeeded'
            and j.options->>'task' = ${sql.raw(`'${SPOTIFY_TRACK_SEARCH_TASK}'`)}
            and j.options->>'matchMethod' = 'automatic'
            and j.options->>'trackId' is not null`)
          ).rows,
        )
    )
      .filter(
        (row) =>
          row.source_id ===
          standaloneLastfmTrackId(account, {
            artistKey: row.artist_key,
            trackKey: row.track_key,
          }),
      )
      .map((row) => [
        JSON.stringify([row.artist_key, row.track_key]),
        row.track_id,
      ]),
  )
  const exactMatches = findExactMatches(candidates)
  const albumAlias = createAlbumTrackAliasMatcher(candidates, groups, manual)
  const selected = scope
    ? groups.filter(
        (group) =>
          group.artist_key === scope.name.artistKey &&
          group.track_key === scope.name.trackKey,
      )
    : groups
  const records = selected.map((group) => {
    const nameKey = JSON.stringify([group.artist_key, group.track_key])
    const matches = exactMatches(group)
    const matched = matches.length
      ? matches.length === 1
        ? matches[0]
        : undefined
      : albumAlias(group)
    const manualId = manual.get(nameKey)
    const standaloneId = standaloneLastfmTrackId(account, {
      artistKey: group.artist_key,
      trackKey: group.track_key,
    })
    const chosenId = scope?.separate
      ? undefined
      : (manualId ?? previousCatalogMatches.get(nameKey) ?? matched?.id)
    return {
      group,
      albumId:
        !group.has_unlinked_album && group.album_ids.length === 1
          ? group.album_ids[0]
          : null,
      matched: chosenId !== undefined,
      id: chosenId ?? standaloneId,
      manuallyMatched: scope?.separate === true || manualId !== undefined,
    }
  })
  for (let start = 0; start < records.length; start += WRITE_BATCH) {
    const batch = records.slice(start, start + WRITE_BATCH)
    const standalone = batch.filter((record) => !record.matched)
    if (standalone.length) {
      const items: Array<typeof mediaItem.$inferInsert> = standalone.map(
        ({ id, group }) => ({
          id,
          mediaType: 'track',
          slug: slugifyParts(group.track_name, id),
          title: group.track_name,
          sourceLabel: 'lastfm',
        }),
      )
      await tx
        .insert(mediaItem)
        .values(items)
        .onConflictDoUpdate({
          target: mediaItem.id,
          set: { title: sql`excluded.title` },
        })
      await tx
        .insert(libraryTrack)
        .values(
          standalone.map(({ id, group, albumId }) => ({
            mediaItemId: id,
            albumName:
              group.album_names.length === 1 ? group.album_names[0] : null,
            albumMediaItemId: albumId,
            albumLinkStrategy: albumId ? 'lastfm' : null,
          })),
        )
        .onConflictDoUpdate({
          target: libraryTrack.mediaItemId,
          set: {
            albumName: sql`excluded.album_name`,
            albumMediaItemId: sql`excluded.album_media_item_id`,
            albumLinkStrategy: sql`excluded.album_link_strategy`,
          },
        })
      const artists = new Map(
        standalone.map(({ group }) => [
          createStableId('artist', group.artist_name.toLowerCase()),
          group.artist_name,
        ]),
      )
      await tx
        .insert(artist)
        .values(
          [...artists].map(([id, name]) => ({ id, name, sortName: name })),
        )
        .onConflictDoNothing()
      await tx.execute(
        sql`delete from media_credit where role = 'artist' and media_item_id in (${sql.join(
          standalone.map(({ id }) => sql`${id}`),
          sql`, `,
        )})`,
      )
      // Legacy imports can have another artist ID for the same unique name.
      await tx.execute(sql`insert into media_credit (media_item_id, artist_id, role, billing_order)
          select r.id, a.id, 'artist', 0
          from jsonb_to_recordset(${JSON.stringify(
            standalone.map(({ id, group }) => ({
              id,
              artist_id: createStableId(
                'artist',
                group.artist_name.toLowerCase(),
              ),
              artist_name: group.artist_name,
            })),
          )}::jsonb) as r(id text, artist_id text, artist_name text)
          join lateral (select id from artist where id = r.artist_id or name = r.artist_name
            order by case when name = r.artist_name then 0 else 1 end limit 1) a on true
          on conflict do nothing`)
    }
    await tx
      .insert(lastfmTrackSource)
      .values(
        batch.map(({ id, group, manuallyMatched }) => ({
          username: account,
          artistKey: group.artist_key,
          trackKey: group.track_key,
          trackMediaItemId: id,
          manuallyMatched,
        })),
      )
      .onConflictDoUpdate({
        target: [
          lastfmTrackSource.username,
          lastfmTrackSource.artistKey,
          lastfmTrackSource.trackKey,
        ],
        set: {
          trackMediaItemId: sql`excluded.track_media_item_id`,
          manuallyMatched: sql`excluded.manually_matched`,
        },
      })
  }
  await tx.execute(sql`delete from lastfm_track_source l where l.username = ${account} ${nameFilter}
      and not exists (select 1 from lastfm_scrobble s where s.username = l.username
        and s.artist_key = l.artist_key and s.track_key = l.track_key)`)
  if (!scope) {
    await removeOrphanTracks(tx)
    await refreshTrackAddedDates(tx)
    return
  }
  const standaloneId = standaloneLastfmTrackId(account, scope.name)
  await removeOrphanTracks(tx, [standaloneId])
  await refreshTrackAddedDates(tx, [
    ...new Set([
      ...records.map((record) => record.id),
      ...(previous ? [previous.track_id] : []),
    ]),
  ])
}
