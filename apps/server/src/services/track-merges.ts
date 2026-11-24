import { and, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import type {
  LibraryChange,
  LibraryChangeDetails,
  TrackMergeRequest,
} from '@repo/schemas/library-changes'
import {
  TrackMergeInputSchema,
  type TrackMergeInput,
  type TrackMergeResult,
  type TrackScrobbleMatchInput,
  type TrackScrobbleNameKey,
  type TrackScrobbleRemoveInput,
} from '@repo/schemas/tracks'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import { albumNameKey } from '@/lib/album-import-candidates'
import { lastfmScrobble, lastfmTrackSource, libraryTrack } from '@/schemas/db'
import { refreshTrackAddedDates } from './spotify-playlists'
import {
  lockLibraryTrackWrites,
  removeOrphanTracks,
} from './album-library-tracks'
import { moveAlbumNames, type AlbumNameMove } from './album-names'
import { refreshArtistListeningTotals } from './artist-listening'
import { membershipDetails } from './automatic-match-effects'
import {
  refreshTrackListeningTotals,
  relinkTrackRecords,
  writeScrobbleTrackLinks,
} from './track-links'
import { importLastfmTrackSources } from './lastfm-library-tracks'
import {
  clearRejections,
  storeSeparatedMatches,
} from './library-match-rejections'
import { clearKeptSeparate } from './keep-separate-effects'
import type { ChangeEffectEntry } from './library-change-effect'
import {
  beginTrackChange,
  getLibraryChange,
  readChangeRecords,
  recordTrackChange,
  type TrackChangeDraft,
} from './library-changes'
import type { TrackFollow } from './merge-follows'
import { refreshTrackDuplicates } from './track-duplicate-refresh'
import { readTrackMerge, type TrackMergeSelection } from './track-merge-plan'
import { moveTrackMemberships } from './track-version-effects'
import { joinTrackVersions } from './track-versions'

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

const LockTimeoutSchema = z.object({ code: z.literal('55P03') })

async function lockTrackMerge(tx: Transaction, interactive: boolean) {
  if (!interactive) return lockLibraryTrackWrites(tx)

  // Wait in the same queue as other library writes. Only this wait is bounded.
  await tx.execute(sql`set local lock_timeout = '5s'`)
  try {
    await lockLibraryTrackWrites(tx)
  } catch (error) {
    if (
      !LockTimeoutSchema.safeParse(error).success &&
      !(
        error instanceof Error &&
        LockTimeoutSchema.safeParse(error.cause).success
      )
    )
      throw error
    throw new ServerError({
      statusCode: 503,
      message: 'The library is busy. Try the merge again.',
      data: { reason: 'library-busy' },
    })
  }
  await tx.execute(sql`set local lock_timeout = default`)
}

const MergeTracksSchema = z.array(
  z.object({
    id: z.string(),
    spotify_track_id: z.string().nullable(),
    lastfm_source: z.boolean(),
    imported_spotify: z.boolean(),
  }),
)

const ScrobbleMatchSourcesSchema = z.array(
  z.object({
    username: z.string(),
    recording_id: z.string(),
    standalone: z.boolean(),
    displayed: z.boolean(),
  }),
)
const ChangedRowsSchema = z.array(z.object({ id: z.string() }))
const RecordedNamesSchema = z.array(
  z.object({
    username: z.string(),
    artist_key: z.string(),
    track_key: z.string(),
  }),
)
type RecordedNames = z.infer<typeof RecordedNamesSchema>

async function getScrobbleMatchSource(
  tx: Transaction,
  displayedId: string,
  { artistKey, trackKey }: TrackScrobbleNameKey,
  {
    targetId,
    includeListeningMatches,
  }: {
    targetId?: string
    includeListeningMatches: boolean
  },
) {
  const tracks = ChangedRowsSchema.parse(
    (
      await tx.execute(sql`
          select lt.media_item_id as id
          from library_track lt join media_item mi on mi.id = lt.media_item_id
          where mi.id in (${displayedId}, ${targetId ?? displayedId})
            and mi.media_type = 'track'
            and mi.metadata->>'legacyHidden' is distinct from 'true'
          for update of lt`)
    ).rows,
  )
  if (!tracks.some((row) => row.id === (targetId ?? displayedId)))
    throw new ServerError({ statusCode: 404, message: 'Track not found.' })

  const displayedExists = tracks.some((row) => row.id === displayedId)
  const [source, otherAccount] = ScrobbleMatchSourcesSchema.parse(
    (
      await tx.execute(sql`
          select s.username, s.track_media_item_id as recording_id, selection.displayed,
            (mi.source_label is not distinct from 'lastfm' and lt.spotify_track_id is null) as standalone
          from lastfm_track_source s
          join library_track lt on lt.media_item_id = s.track_media_item_id
          join media_item mi on mi.id = lt.media_item_id
          cross join lateral (
            select ${displayedExists} and (
              s.track_media_item_id = ${displayedId} or (${includeListeningMatches} and exists (
                select 1 from lastfm_track_link l
                where l.username = s.username and l.artist_key = s.artist_key
                  and l.track_key = s.track_key and l.track_media_item_id = ${displayedId}
              ))
            ) as displayed
          ) selection
          where s.artist_key = ${artistKey} and s.track_key = ${trackKey}
            and (selection.displayed or (s.manually_matched and s.track_media_item_id = ${targetId ?? null}))
            and exists (
              select 1 from lastfm_scrobble e where e.username = s.username
                and e.artist_key = s.artist_key and e.track_key = s.track_key
            )
          limit 2
          for update of s`)
    ).rows,
  )
  if (!source)
    throw new ServerError({
      statusCode: 409,
      message:
        'This track no longer shows that Last.fm match. Refresh and try again.',
    })
  if (otherAccount)
    throw new ServerError({
      statusCode: 409,
      message:
        'More than one Last.fm account has this recorded name on the selected tracks.',
    })

  const names = await tx
    .selectDistinct({
      artist: lastfmScrobble.artistName,
      title: lastfmScrobble.trackName,
    })
    .from(lastfmScrobble)
    .where(
      and(
        eq(lastfmScrobble.username, source.username),
        eq(lastfmScrobble.artistKey, artistKey),
        eq(lastfmScrobble.trackKey, trackKey),
      ),
    )
  if (
    !names.length ||
    names.some(
      (name) =>
        albumNameKey(name.artist) !== artistKey ||
        albumNameKey(name.title) !== trackKey,
    )
  )
    throw new ServerError({
      statusCode: 409,
      message: 'The stored Last.fm names for this match are ambiguous.',
    })

  return source
}

async function assignScrobbleNames(
  tx: Transaction,
  names: RecordedNames,
  sourceIds: string[],
  targetId: string,
  standalone: boolean,
  method: 'manual' | 'exact' = 'manual',
) {
  const input = sql`jsonb_to_recordset(${JSON.stringify(names)}::jsonb)
    as r(username text, artist_key text, track_key text)`
  await tx.execute(sql`
    update lastfm_track_source s
    set track_media_item_id = ${targetId}, manually_matched = ${method === 'manual'}
    from ${input}
    where s.username = r.username and s.artist_key = r.artist_key and s.track_key = r.track_key`)
  const removed = ChangedRowsSchema.parse(
    (
      await tx.execute(sql`
        delete from lastfm_track_link l using ${input}
        where ${method === 'manual'} and l.username = r.username and l.artist_key = r.artist_key and l.track_key = r.track_key
          and l.track_media_item_id <> ${targetId}
        returning l.track_media_item_id as id`)
    ).rows,
  )
  await tx.execute(sql`
    insert into lastfm_track_link (username, artist_key, track_key, track_media_item_id, strategy)
    select r.username, r.artist_key, r.track_key, ${targetId}, ${method}
    from ${input}
    on conflict (username, artist_key, track_key, track_media_item_id)
      do update set strategy = excluded.strategy
      where excluded.strategy = 'manual' or lastfm_track_link.strategy <> 'manual'`)
  if (standalone)
    await removeOrphanTracks(
      tx,
      sourceIds.filter((id) => id !== targetId),
    )
  const affected = [
    ...new Set([...sourceIds, targetId, ...removed.map(({ id }) => id)]),
  ]
  await refreshTrackAddedDates(tx, affected)
  await refreshTrackListeningTotals(tx, affected)
  await refreshArtistListeningTotals(tx)
}

async function trackMatchResult(
  tx: Transaction,
  displayedId: string,
  targetId: string,
): Promise<TrackMergeResult> {
  if (displayedId === targetId) return { targetId }
  const [current] = await tx
    .select({ id: libraryTrack.mediaItemId })
    .from(libraryTrack)
    .where(eq(libraryTrack.mediaItemId, displayedId))
  return current ? { targetId } : { targetId, sourceRemoved: true }
}

const withChange = (
  result: TrackMergeResult,
  changeId: string | null,
): TrackMergeResult => (changeId ? { ...result, changeId } : result)

/** Move the original names and rebuild their listening totals in the caller's transaction. */
export async function moveTrackScrobbleNames(
  tx: Transaction,
  sourceId: string,
  targetId: string,
  removeStandalone: boolean,
  transferListening = false,
  method: 'manual' | 'exact' = 'manual',
) {
  const names = RecordedNamesSchema.parse(
    (
      await tx.execute(sql`
    select username, artist_key, track_key from lastfm_track_source
    where track_media_item_id = ${sourceId}`)
    ).rows,
  )
  if (transferListening && sourceId !== targetId) {
    await tx.execute(sql`
      insert into lastfm_track_link (username, artist_key, track_key, track_media_item_id, strategy)
      select username, artist_key, track_key, ${targetId}, strategy
      from lastfm_track_link where track_media_item_id = ${sourceId} on conflict do nothing`)
    await tx.execute(
      sql`delete from lastfm_track_link where track_media_item_id = ${sourceId}`,
    )
  }
  if (names.length || transferListening)
    await assignScrobbleNames(
      tx,
      names,
      [sourceId],
      targetId,
      removeStandalone,
      method,
    )
}

/** Match one recorded Last.fm artist/title group and leave other memberships in place. */
export async function matchScrobbleTrack(
  displayedId: string,
  { artistKey, trackKey, targetId }: TrackScrobbleMatchInput,
): Promise<TrackMergeResult> {
  return db.transaction(async (tx) => {
    await lockLibraryTrackWrites(tx)
    const source = await getScrobbleMatchSource(
      tx,
      displayedId,
      { artistKey, trackKey },
      { targetId, includeListeningMatches: true },
    )
    const names = [
      { username: source.username, artist_key: artistKey, track_key: trackKey },
    ]
    const draft = await beginTrackChange(tx, { names })
    // An identical retry can arrive after the source row stopped showing the match.
    if (source.displayed)
      await assignScrobbleNames(
        tx,
        names,
        [source.recording_id],
        targetId,
        source.standalone,
      )
    return withChange(
      await trackMatchResult(tx, displayedId, targetId),
      await recordTrackChange(tx, draft, { action: 'move' }),
    )
  })
}

/** Keep a recorded name on its own track, or return it to normal matching. */
export async function removeScrobbleTrackMatch(
  displayedId: string,
  { artistKey, trackKey, mode }: TrackScrobbleRemoveInput,
): Promise<TrackMergeResult> {
  const name = { artistKey, trackKey }
  return db.transaction(async (tx) => {
    await lockLibraryTrackWrites(tx)
    const source = await getScrobbleMatchSource(tx, displayedId, name, {
      includeListeningMatches: mode === 'separate',
    })
    const membership = and(
      eq(lastfmTrackSource.username, source.username),
      eq(lastfmTrackSource.artistKey, artistKey),
      eq(lastfmTrackSource.trackKey, trackKey),
    )
    const draft = await beginTrackChange(tx, {
      names: [
        {
          username: source.username,
          artist_key: artistKey,
          track_key: trackKey,
        },
      ],
    })
    const effects: ChangeEffectEntry[] = []
    if (mode === 'automatic') {
      await tx
        .update(lastfmTrackSource)
        .set({ manuallyMatched: false })
        .where(membership)
      // Automatic matching may make the matches the owner undid again.
      const forgotten = await clearRejections(tx, source.username, [name])
      if (forgotten) effects.push(forgotten)
    }
    await importLastfmTrackSources(tx, source.username, {
      name,
      separate: mode === 'separate',
    })
    if (source.standalone) await removeOrphanTracks(tx, [source.recording_id])
    await writeScrobbleTrackLinks(tx, source.username, name)
    await refreshArtistListeningTotals(tx)
    const [result] = await tx
      .select({ targetId: lastfmTrackSource.trackMediaItemId })
      .from(lastfmTrackSource)
      .where(membership)
    if (!result)
      throw new ServerError({
        statusCode: 409,
        message: 'That Last.fm name is no longer available.',
      })
    // Separating a name from a track an automatic rule gave it is remembered.
    const [owner] = draft.before
    const separated =
      mode === 'separate' && owner && !owner.manual
        ? await storeSeparatedMatches(tx, {
            username: source.username,
            ...name,
            recordIds: [
              ...(source.standalone ? [] : [source.recording_id]),
              ...(displayedId === source.recording_id ? [] : [displayedId]),
            ].filter((id) => id !== result.targetId),
          })
        : null
    if (separated) effects.push(separated)
    return withChange(
      await trackMatchResult(tx, displayedId, result.targetId),
      await recordTrackChange(tx, draft, {
        action: mode === 'separate' ? 'separate' : 'rematch',
        effects,
      }),
    )
  })
}

/**
 * Keep release positions and playlist entries when a confirmed recording
 * already exists. Returns the moves with what an undo needs, as effects to
 * record with the change.
 */
export async function transferTrackMemberships(
  tx: Transaction,
  sourceId: string,
  targetId: string,
  moveAlbumPositions: boolean,
): Promise<ChangeEffectEntry[]> {
  return moveTrackMemberships(tx, sourceId, targetId, moveAlbumPositions)
}

/** What a merge moved besides scrobbled names, for the list of changes. */
function mergeDetails(
  effects: ChangeEffectEntry[],
  versionTitles: string[],
): LibraryChangeDetails {
  const counts = { ...membershipDetails(effects)?.counts }
  if (versionTitles.length) counts.version = versionTitles.length
  return { counts, labels: versionTitles.slice(0, 5) }
}

/** Keeps an explicitly chosen imported Spotify identity and its recorded evidence. */
export async function mergeLastfmTrack(
  sourceId: string,
  input: TrackMergeInput,
  { interactive = false } = {},
): Promise<TrackMergeResult> {
  const { targetId, namesOnly } = TrackMergeInputSchema.parse(input)
  if (sourceId === targetId)
    throw new ServerError({
      statusCode: 409,
      message: 'Choose a different track to merge into.',
    })
  return db.transaction(async (tx) => {
    await lockTrackMerge(tx, interactive)
    const records = MergeTracksSchema.parse(
      (
        await tx.execute(sql`
          select lt.media_item_id as id, lt.spotify_track_id,
            (coalesce(mi.source_label, '') in ('spotify', 'spotify-search')) as imported_spotify,
            exists (select 1 from lastfm_track_source s
              where s.track_media_item_id = lt.media_item_id) as lastfm_source
          from library_track lt join media_item mi on mi.id = lt.media_item_id
          where lt.media_item_id in (${sourceId}, ${targetId})
            and mi.media_type = 'track'
            and mi.metadata->>'legacyHidden' is distinct from 'true'
          for update of lt`)
      ).rows,
    )
    const source = records.find((row) => row.id === sourceId)
    const target = records.find((row) => row.id === targetId)
    if (!source || !target)
      throw new ServerError({ statusCode: 404, message: 'Track not found' })
    if (!source.lastfm_source || (!namesOnly && source.imported_spotify))
      throw new ServerError({
        statusCode: 409,
        message: namesOnly
          ? 'Choose a track with imported Last.fm names.'
          : 'Only a Last.fm track without an imported Spotify identity can be merged.',
      })
    const draft = await beginTrackChange(tx, { trackIds: [sourceId] })
    if (namesOnly) {
      await moveTrackScrobbleNames(
        tx,
        sourceId,
        targetId,
        source.spotify_track_id === null,
      )
      const result = await trackMatchResult(tx, sourceId, targetId)
      return withChange(
        result,
        await recordTrackChange(tx, draft, {
          action: result.sourceRemoved ? 'merge' : 'move',
        }),
      )
    }
    if (target.spotify_track_id === null || !target.imported_spotify)
      throw new ServerError({
        statusCode: 409,
        message: 'Choose a track imported from Spotify.',
      })

    await tx.execute(sql`
      update lastfm_track_source
      set track_media_item_id = ${targetId}, manually_matched = true
      where track_media_item_id = ${sourceId}`)

    // A manual identity overrides every automatic listening match for that name.
    // Rebuild these links rather than adding summary counts that may overlap.
    await tx.execute(sql`
      delete from lastfm_track_link l using lastfm_track_source s
      where s.track_media_item_id = ${targetId} and s.manually_matched
        and l.username = s.username and l.artist_key = s.artist_key
        and l.track_key = s.track_key`)
    await tx.execute(sql`
      insert into lastfm_track_link
        (username, artist_key, track_key, track_media_item_id, strategy)
      select username, artist_key, track_key, track_media_item_id, 'manual'
      from lastfm_track_source
      where track_media_item_id = ${targetId} and manually_matched
      on conflict (username, artist_key, track_key, track_media_item_id)
        do update set strategy = excluded.strategy`)
    const effects = await transferTrackMemberships(
      tx,
      sourceId,
      targetId,
      source.spotify_track_id === null,
    )
    await removeOrphanTracks(tx, [sourceId])
    await refreshTrackAddedDates(tx)
    await refreshTrackListeningTotals(tx)
    await relinkTrackRecords(tx, [targetId])
    await refreshArtistListeningTotals(tx)
    return withChange(
      { targetId },
      await recordTrackChange(tx, draft, {
        action: 'merge',
        details: mergeDetails(effects, []),
        effects,
      }),
    )
  })
}

/** One draft of the names that moved, from the drafts of each step. */
function joinTrackDrafts(drafts: TrackChangeDraft[]): TrackChangeDraft {
  const once = <Item extends { id: string }>(items: Item[]) => [
    ...new Map(items.map((item) => [item.id, item])).values(),
  ]
  return {
    before: drafts.flatMap((draft) => draft.before),
    records: once(drafts.flatMap((draft) => draft.records)),
    archived: once(drafts.flatMap((draft) => draft.archived)),
  }
}

/** Says what followed the merged titles, for the list of changes. */
function followDetails(
  details: LibraryChangeDetails,
  follows: TrackFollow[],
  moved: AlbumNameMove[],
): LibraryChangeDetails {
  const albumNames = moved.reduce((total, move) => total + move.albumNames, 0)
  const titles = moved.reduce((total, move) => total + move.titles, 0)
  const counts = { ...details.counts }
  if (albumNames) counts['album-name'] = albumNames
  if (titles) counts.title = titles
  return {
    counts,
    labels: [
      ...follows.flatMap((follow) =>
        follow.names.map((name) => name.albumName),
      ),
      ...(details.labels ?? []),
    ].slice(0, 5),
  }
}

/**
 * Merges the selected tracks into one record and records the change. A track
 * with its own Spotify track, or without names to move, stays as a version;
 * the others give their names, album positions and playlist entries to the
 * track to keep and are removed. With `follow`, the album names the merged
 * titles were scrobbled under move to the album of the track to keep, with
 * the other titles under them that match its tracks, in the same change. A
 * plan with cautions must have been reviewed.
 */
export async function mergeTracks(
  {
    reviewed,
    ...selection
  }: TrackMergeSelection & Pick<TrackMergeRequest, 'reviewed'>,
  { interactive = false } = {},
): Promise<LibraryChange> {
  return db.transaction(async (tx) => {
    await lockTrackMerge(tx, interactive)
    const { plan, follows } = await readTrackMerge(tx, selection, true)
    if (plan.cautions.length && !reviewed)
      throw new ServerError({
        statusCode: 409,
        message: 'Review this merge before it is made.',
      })
    const { targetId } = plan
    const merged = plan.tracks.filter((track) => track.outcome === 'merge')
    const versions = plan.tracks.filter((track) => track.outcome === 'version')
    const records = await readChangeRecords(
      tx,
      'track',
      plan.tracks.map((track) => track.id),
    )
    const draft = await beginTrackChange(tx, {
      trackIds: merged.map((track) => track.id),
    })
    const effects: ChangeEffectEntry[] = []
    const joined = versions.length
      ? await joinTrackVersions(
          tx,
          targetId,
          versions.map((track) => track.id),
          merged.map((track) => track.id),
        )
      : { effect: null, trackIds: [] }
    if (joined.effect) effects.push(joined.effect)
    for (const track of merged)
      effects.push(
        ...(await transferTrackMemberships(tx, track.id, targetId, true)),
      )
    await assignScrobbleNames(
      tx,
      draft.before.map(({ username, artist_key, track_key }) => ({
        username,
        artist_key,
        track_key,
      })),
      merged.map((track) => track.id),
      targetId,
      true,
    )
    await relinkTrackRecords(tx, [targetId, ...joined.trackIds])
    const moved: AlbumNameMove[] = []
    for (const { account, albumId, names, follow } of follows)
      moved.push(await moveAlbumNames(tx, account, names, albumId, follow))
    for (const move of moved) effects.push(...move.effects)
    const forgotten = await clearKeptSeparate(
      tx,
      'track',
      plan.tracks.map((track) => track.id),
    )
    if (forgotten) effects.push(forgotten)
    await refreshTrackDuplicates(tx, {
      trackIds: [
        ...new Set([
          ...plan.tracks.map((track) => track.id),
          ...plan.also.titles.flatMap((name) => [
            name.fromTrackId,
            name.toTrackId,
          ]),
        ]),
      ],
    })
    const changeId = await recordTrackChange(
      tx,
      joinTrackDrafts([draft, ...moved.map((move) => move.draft)]),
      {
        action: 'merge',
        target: records.find((record) => record.id === targetId) ?? null,
        sources: records.filter((record) => record.id !== targetId),
        details: followDetails(
          mergeDetails(
            effects,
            joined.effect ? versions.map((track) => track.title) : [],
          ),
          follows,
          moved,
        ),
        effects,
      },
    )
    if (!changeId)
      throw new ServerError({
        statusCode: 409,
        message: 'The selected tracks are one record already.',
      })
    return getLibraryChange(changeId, tx)
  })
}
