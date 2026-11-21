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
import { standaloneLastfmTrackId } from '@/lib/track-matching'
import { lastfmTrackSource } from '@/schemas/db'
import { refreshTrackAddedDates } from './spotify-playlists'
import { refreshArtistListeningTotals } from './artist-listening'
import {
  lockLibraryTrackWrites,
  removeOrphanTracks,
} from './album-library-tracks'
import { standaloneTracksEntry } from './automatic-match-effects'
import { readKeptSeparateTest } from './keep-separate-effects'
import {
  ScrobbledRowsSchema,
  scrobbledAlbumId,
  scrobbledColumns,
  writeStandaloneTracks,
  type ScrobbledName,
} from './lastfm-standalone-tracks'
import { recordNameMoves, type RecordedNameMove } from './library-changes'
import { readRejectionTest } from './library-match-rejections'
import { refreshTrackListeningTotals } from './track-links'
import { archiveTracks, type ArchivedTrack } from './track-archive'

const WRITE_BATCH = 500
const ARCHIVE_BATCH = 5000
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
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
const MovedNamesSchema = z.array(
  z.object({
    username: z.string(),
    artist_key: z.string(),
    track_key: z.string(),
    from_id: z.string(),
    to_id: z.string(),
  }),
)
const OwnerRowsSchema = z.array(
  z.object({
    artist_key: z.string(),
    track_key: z.string(),
    track_id: z.string(),
    manual: z.boolean(),
  }),
)
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

/**
 * Imports stored history only; uncertain recording identities remain
 * separate. The matches it makes are recorded as automatic changes of the run.
 */
export async function importLastfmLibraryTracks(
  account: string,
  batchId: string | null = null,
) {
  await db.transaction((tx) =>
    importLastfmTrackSources(tx, account, undefined, { batchId }),
  )
}

/** The archives of the given tracks, read in batches. */
async function archiveTracksInBatches(tx: Transaction, ids: string[]) {
  const archived: ArchivedTrack[] = []
  for (let start = 0; start < ids.length; start += ARCHIVE_BATCH)
    archived.push(
      ...(await archiveTracks(tx, ids.slice(start, start + ARCHIVE_BATCH))),
    )
  return archived
}

/**
 * Whether two tracks are kept separate, from one read per batch of moves: an
 * automatic rule never merges them.
 */
async function readKeptSeparateMoves(
  tx: Transaction,
  pairs: { fromId: string; toId: string }[],
) {
  const tests: ((left: string, right: string) => boolean)[] = []
  for (let start = 0; start < pairs.length; start += ARCHIVE_BATCH / 2) {
    const ids = pairs
      .slice(start, start + ARCHIVE_BATCH / 2)
      .flatMap((pair) => [pair.fromId, pair.toId])
    tests.push(await readKeptSeparateTest(tx, 'track', ids))
  }
  return (left: string, right: string) =>
    tests.some((kept) => kept(left, right))
}

/** Reconciles safe Last.fm aliases when an album's actual positions are available. */
export async function reconcileLastfmAlbumTrackAliases(
  tx: Transaction,
  {
    albumId,
    dryRun = false,
    batchId = null,
  }: { albumId?: string; dryRun?: boolean; batchId?: string | null } = {},
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
  // A match the owner undid or separated, or a pair kept separate, is left alone.
  const rejected = new Map<
    string,
    Awaited<ReturnType<typeof readRejectionTest>>
  >()
  for (const username of albums.keys())
    rejected.set(username, await readRejectionTest(tx, username))
  const kept = await readKeptSeparateMoves(
    tx,
    proposed.map(({ source, target }) => ({
      fromId: source.source_id,
      toId: target.id,
    })),
  )
  const moves = proposed.flatMap(({ source, target, name }) =>
    exact(name).length ||
    rejected.get(source.username)?.(
      source.artist_key,
      source.track_key,
      target.id,
    ) ||
    kept(source.source_id, target.id)
      ? []
      : [{ ...source, target_id: target.id }],
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
  const archived = await archiveTracksInBatches(tx, [
    ...new Set(moves.map((move) => move.source_id)),
  ])
  const recorded: RecordedNameMove[] = []
  for (let start = 0; start < moves.length; start += WRITE_BATCH) {
    const batch = moves.slice(start, start + WRITE_BATCH)
    const rows = sql`jsonb_to_recordset(${JSON.stringify(batch)}::jsonb)
      as alias(username text, artist_key text, track_key text, source_id text, target_id text)`
    const moved = MovedNamesSchema.parse(
      (
        await tx.execute(sql`
      with moved as (
        update lastfm_track_source s set track_media_item_id = alias.target_id
        from ${rows}
        where s.username = alias.username and s.artist_key = alias.artist_key
          and s.track_key = alias.track_key and s.track_media_item_id = alias.source_id
          and not s.manually_matched
        returning s.username, s.artist_key, s.track_key, s.track_media_item_id,
          alias.source_id
      ), linked as (
        insert into lastfm_track_link (username, artist_key, track_key, track_media_item_id, strategy)
          select username, artist_key, track_key, track_media_item_id, 'exact' from moved
        on conflict (username, artist_key, track_key, track_media_item_id) do update
          set strategy = excluded.strategy
          where lastfm_track_link.strategy is distinct from excluded.strategy
      )
      select username, artist_key, track_key, source_id as from_id,
        track_media_item_id as to_id
      from moved`)
      ).rows,
    )
    recorded.push(
      ...moved.map((name) => ({
        username: name.username,
        artistKey: name.artist_key,
        trackKey: name.track_key,
        fromId: name.from_id,
        fromManual: false,
        toId: name.to_id,
        toManual: false,
      })),
    )
    await removeOrphanTracks(
      tx,
      batch.map((move) => move.source_id),
    )
  }
  await recordNameMoves(tx, {
    moves: recorded,
    rule: 'album-alias',
    batchId,
    archived,
  })
  const targets = [...new Set(moves.map((move) => move.target_id))]
  await refreshTrackAddedDates(tx, targets)
  await refreshTrackListeningTotals(tx, targets)
  await refreshArtistListeningTotals(
    tx,
    creditedArtists.map((row) => row.artist_id),
  )
  return moves.length
}

/** The automatic rule that chose a name's track, as History names it. */
type ImportRule =
  | 'lastfm-accepted-search'
  | 'lastfm-exact-name'
  | 'lastfm-album-alias'

/**
 * Gives every scrobbled name of the account its track: the owner's choice,
 * then an accepted search, an exact name or an album alias, otherwise its own
 * Last.fm-only track. A match the owner undid or separated is not made again,
 * and a name does not move between tracks the owner keeps separate. A full run
 * records each name it placed on another track as an automatic change.
 */
export async function importLastfmTrackSources(
  tx: Transaction,
  account: string,
  scope?: { name: TrackScrobbleNameKey; separate?: boolean },
  { batchId = null }: { batchId?: string | null } = {},
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
  const owners = new Map(
    OwnerRowsSchema.parse(
      (
        await tx.execute(sql`
          select artist_key, track_key, track_media_item_id as track_id,
            manually_matched as manual
          from lastfm_track_source where username = ${account} ${nameFilter}`)
      ).rows,
    ).map((row) => [JSON.stringify([row.artist_key, row.track_key]), row]),
  )
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
  const rejected = await readRejectionTest(tx, account)
  const selected = scope
    ? groups.filter(
        (group) =>
          group.artist_key === scope.name.artistKey &&
          group.track_key === scope.name.trackKey,
      )
    : groups
  const chosen = selected.map((group) => {
    const nameKey = JSON.stringify([group.artist_key, group.track_key])
    const allowed = (id: string | undefined) =>
      id !== undefined && !rejected(group.artist_key, group.track_key, id)
    // A track the owner undid or separated the name from is no candidate.
    const matches = exactMatches(group).filter((candidate) =>
      allowed(candidate.id),
    )
    const matched = matches.length
      ? matches.length === 1
        ? matches[0]
        : undefined
      : albumAlias(group)
    const manualId = manual.get(nameKey)
    const catalogId = previousCatalogMatches.get(nameKey)
    const standaloneId = standaloneLastfmTrackId(account, {
      artistKey: group.artist_key,
      trackKey: group.track_key,
    })
    const choice: { id: string; rule: ImportRule } | undefined =
      scope?.separate || manualId !== undefined
        ? undefined
        : allowed(catalogId) && catalogId !== undefined
          ? { id: catalogId, rule: 'lastfm-accepted-search' }
          : allowed(matched?.id) && matched
            ? {
                id: matched.id,
                rule: matches.length
                  ? 'lastfm-exact-name'
                  : 'lastfm-album-alias',
              }
            : undefined
    return {
      group,
      standaloneId,
      manualId,
      choice,
      owner: owners.get(nameKey),
    }
  })
  const kept = await readKeptSeparateMoves(
    tx,
    chosen.flatMap(({ owner, choice }) =>
      owner && choice && owner.track_id !== choice.id
        ? [{ fromId: owner.track_id, toId: choice.id }]
        : [],
    ),
  )
  const records = chosen.map(
    ({ group, standaloneId, manualId, choice, owner }) => {
      const albumId = scrobbledAlbumId(group)
      if (scope?.separate || manualId !== undefined)
        return {
          group,
          owner,
          standaloneId,
          albumId,
          matched: !scope?.separate,
          id: scope?.separate ? standaloneId : (manualId ?? standaloneId),
          manuallyMatched: true,
          rule: null,
        }
      // A name stays where it is rather than move between tracks the owner
      // keeps separate, or back to its own track after that was undone.
      const stays =
        owner &&
        (choice
          ? owner.track_id !== choice.id && kept(owner.track_id, choice.id)
          : owner.track_id !== standaloneId &&
            rejected(group.artist_key, group.track_key, standaloneId))
      const id = stays ? owner.track_id : (choice?.id ?? standaloneId)
      return {
        group,
        owner,
        standaloneId,
        albumId,
        matched: id !== standaloneId || (!stays && choice !== undefined),
        id,
        manuallyMatched: false,
        rule: stays ? null : (choice?.rule ?? null),
      }
    },
  )
  const moves = scope
    ? []
    : records.flatMap(
        ({ group, owner, standaloneId, id, manuallyMatched, rule }) => {
          // A new name on its own track is where every name starts.
          if (!owner && id === standaloneId) return []
          if (
            owner &&
            owner.track_id === id &&
            owner.manual === manuallyMatched
          )
            return []
          return [
            {
              rule,
              created: !owner,
              move: {
                username: account,
                artistKey: group.artist_key,
                trackKey: group.track_key,
                fromId: owner?.track_id ?? standaloneId,
                fromManual: owner?.manual ?? false,
                toId: id,
                toManual: manuallyMatched,
              },
            },
          ]
        },
      )
  // The tracks names leave can be removed below; keep what an undo needs.
  const archived = await archiveTracksInBatches(tx, [
    ...new Set(
      moves.flatMap(({ created, move }) => (created ? [] : [move.fromId])),
    ),
  ])
  for (let start = 0; start < records.length; start += WRITE_BATCH) {
    const batch = records.slice(start, start + WRITE_BATCH)
    await writeStandaloneTracks(
      tx,
      batch.filter((record) => !record.matched),
    )
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
    await recordImportMoves(tx, account, moves, archived, batchId)
    return
  }
  const standaloneId = standaloneLastfmTrackId(account, scope.name)
  const previous = owners.get(
    JSON.stringify([scope.name.artistKey, scope.name.trackKey]),
  )
  await removeOrphanTracks(tx, [standaloneId])
  await refreshTrackAddedDates(tx, [
    ...new Set([
      ...records.map((record) => record.id),
      ...(previous ? [previous.track_id] : []),
    ]),
  ])
}

/**
 * Records a full import's moves by rule: one change for each track names went
 * to. A name matched before it had a track of its own gets that track back on
 * Undo; a name that went back to its own track is a separation.
 */
async function recordImportMoves(
  tx: Transaction,
  account: string,
  moves: {
    rule: ImportRule | null
    created: boolean
    move: RecordedNameMove
  }[],
  archived: ArchivedTrack[],
  batchId: string | null,
) {
  const created = new Set(
    moves.flatMap(({ created, move }) =>
      created ? [JSON.stringify([move.artistKey, move.trackKey])] : [],
    ),
  )
  const effects = (toId: string, group: RecordedNameMove[]) => {
    const names = group
      .filter((move) =>
        created.has(JSON.stringify([move.artistKey, move.trackKey])),
      )
      .map(({ artistKey, trackKey }) => ({ artistKey, trackKey }))
    return names.length ? [standaloneTracksEntry(account, names, [toId])] : []
  }
  for (const rule of [
    'lastfm-accepted-search',
    'lastfm-exact-name',
    'lastfm-album-alias',
  ] satisfies ImportRule[])
    await recordNameMoves(tx, {
      moves: moves.flatMap((entry) =>
        entry.rule === rule ? [entry.move] : [],
      ),
      rule,
      batchId,
      archived,
      effects,
    })
  await recordNameMoves(tx, {
    moves: moves.flatMap((entry) => (entry.rule === null ? [entry.move] : [])),
    rule: 'lastfm-unmatched',
    action: 'separate',
    batchId,
    archived,
  })
}
