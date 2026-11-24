import { sql } from 'drizzle-orm'
import type { ArtistMergeRequest } from '@repo/schemas/artist-merges'
import type { LibraryChange } from '@repo/schemas/library-changes'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import { lockLibraryTrackWrites } from './album-library-tracks'
import { refreshArtistListeningTotals } from './artist-listening'
import {
  artistTitleFollowEffect,
  mergeArtistInto,
} from './artist-merge-effects'
import {
  readArtistMerge,
  type ArtistMergeSelection,
  type ArtistMergeReading,
} from './artist-merge-plan'
import { clearKeptSeparate } from './keep-separate-effects'
import type {
  ChangeEffectEntry,
  ChangeTransaction,
} from './library-change-effect'
import {
  beginTrackChange,
  getLibraryChange,
  readChangeRecords,
  recordChange,
} from './library-changes'
import type { ArtistFollowedName } from './merge-follows'
import { refreshTrackAddedDates } from './spotify-playlists'
import { removeEmptyTracks } from './track-archive'
import { refreshTrackDuplicates } from './track-duplicate-refresh'
import { writeScrobbleTrackLinks } from './track-links'

/**
 * Gives the names that follow an artist merge to their tracks, relinks them
 * and removes the tracks they left. Returns the tracks the names moved from
 * and to.
 */
async function moveFollowedNames(
  tx: ChangeTransaction,
  follows: ArtistFollowedName[],
) {
  if (!follows.length) return []
  await tx.execute(sql`
    update lastfm_track_source s
    set track_media_item_id = r."toTrackId", manually_matched = true
    from jsonb_to_recordset(${JSON.stringify(
      follows.map(({ username, artistKey, trackKey, toTrackId }) => ({
        username,
        artistKey,
        trackKey,
        toTrackId,
      })),
    )}::jsonb) as r(username text, "artistKey" text, "trackKey" text,
      "toTrackId" text)
    where s.username = r.username and s.artist_key = r."artistKey"
      and s.track_key = r."trackKey"`)
  for (const username of new Set(follows.map((name) => name.username)))
    await writeScrobbleTrackLinks(
      tx,
      username,
      follows
        .filter((name) => name.username === username)
        .map(({ artistKey, trackKey }) => ({ artistKey, trackKey })),
    )
  const fromIds = [...new Set(follows.map((name) => name.fromTrackId))]
  await removeEmptyTracks(tx, fromIds)
  const trackIds = [
    ...new Set([...fromIds, ...follows.map((name) => name.toTrackId)]),
  ]
  await refreshTrackAddedDates(tx, trackIds)
  return trackIds
}

/**
 * Merges the selected artists into one and records the change. The merged
 * artists stay as names the kept artist keeps, and their credits go to it.
 * With `follow`, the names of the merged artists' Last.fm-only tracks move to
 * the kept artist's track with the same title, in the same change. A plan
 * with cautions must have been reviewed.
 */
export async function mergeArtists({
  reviewed,
  ...selection
}: ArtistMergeSelection &
  Pick<ArtistMergeRequest, 'reviewed'>): Promise<LibraryChange> {
  return db.transaction(async (tx) => {
    await lockLibraryTrackWrites(tx)
    const { plan, follows } = await readArtistMerge(tx, selection, true)
    if (plan.blocked)
      throw new ServerError({
        statusCode: 409,
        message: 'Artists with film credits cannot be merged.',
      })
    if (plan.cautions.length && !reviewed)
      throw new ServerError({
        statusCode: 409,
        message: 'Review this merge before it is made.',
      })
    const id = await persistArtistMerge(tx, { plan, follows })
    return getLibraryChange(id, tx)
  })
}

/** Caller holds the recording writer lock and has reviewed this plan's cautions. */
export async function persistArtistMerge(
  tx: ChangeTransaction,
  { plan, follows }: ArtistMergeReading,
  rule?: string,
) {
  const sources = plan.artists.filter((artist) => artist.id !== plan.targetId)
  const ids = plan.artists.map((artist) => artist.id)
  const [target] = await readChangeRecords(tx, 'artist', [plan.targetId])
  const records = await readChangeRecords(
    tx,
    'artist',
    sources.map((artist) => artist.id),
  )
  const draft = follows.length
    ? await beginTrackChange(tx, {
        names: follows.map(({ username, artistKey, trackKey }) => ({
          username,
          artist_key: artistKey,
          track_key: trackKey,
        })),
      })
    : undefined
  const effects: ChangeEffectEntry[] = []
  let credits = 0
  let names = 0
  for (const source of sources) {
    const merged = await mergeArtistInto(tx, source, plan.targetId)
    effects.push(merged.entry)
    credits += merged.credits
    names += merged.names
  }
  const followed = await moveFollowedNames(tx, follows)
  const separate = await clearKeptSeparate(tx, 'artist', ids)
  if (separate) effects.push(separate)
  if (followed.length) {
    effects.push(artistTitleFollowEffect(followed))
    await refreshTrackDuplicates(tx, { trackIds: followed })
  }
  await refreshArtistListeningTotals(tx, ids)
  const changeId = await recordChange(
    tx,
    {
      kind: 'artist',
      action: 'merge',
      ...(rule ? { actor: 'automatic', rule } : {}),
      target: target ?? null,
      sources: records,
      details: {
        counts: {
          credit: credits,
          'artist-name': names,
          ...(follows.length ? { title: follows.length } : {}),
        },
        labels: sources.slice(0, 5).map((artist) => artist.name),
      },
    },
    { draft, effects },
  )
  if (!changeId)
    throw new ServerError({
      statusCode: 409,
      message: 'The selected artists have nothing to merge.',
    })
  return changeId
}
