import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import { EnrichmentResultSchema } from '@repo/schemas/job'
import {
  SPOTIFY_PLAYLIST_IMPORT_TASK,
  SPOTIFY_PLAYLIST_ITEM_LIMIT,
  SPOTIFY_PLAYLIST_PAGE_SIZE,
  SpotifyPlaylistImportInputSchema,
  SpotifyPlaylistImportsSchema,
  type SpotifyPlaylistImportInput,
  type SpotifyPlaylistJob,
} from '@repo/schemas/tracks'
import { db } from '@/lib/db'
import {
  createStableId,
  parseOptionalDate,
  slugifyParts,
} from '@/lib/media-utils'
import {
  SpotifyIdSchema,
  SpotifyPlaylistSchema,
  SpotifyTrackEntriesPageSchema,
  normalizeSpotifyTrackEntry,
  spotifyArtworkUrl,
  spotifyJson,
  type SpotifyLibraryTrack,
  type SpotifyRequest,
} from '@/lib/spotify-api'
import {
  artist,
  libraryTrack,
  mediaCredit,
  mediaItem,
  playlist,
  playlistItem,
} from '@/schemas/db'
import { createTaskJob, type TaskJobContext, type TaskJobResult } from './jobs'
import { getLastfmAccount } from './lastfm-scrobbles'
import { spotifyOperation, spotifyPlaylistToken } from './spotify-oauth'
import {
  LIKED_SONGS_KEY,
  LIKED_SONGS_NAME,
  NOT_IMPORTABLE,
  PLAYLIST_KEY_PREFIX,
  latestSpotifyJobs,
  playlistGroupKey,
  playlistUrl,
  readSpotifyPlaylistListing,
  refused,
  requirePlaylistAccess,
  storedImports,
  storedSummary,
} from './spotify-playlist-state'
import { refreshTrackLinks } from './track-links'

const WRITE_BATCH = 500
const LOG_EVERY_PAGES = 40

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

const PlaylistTargetSchema = z.object({
  source: z.literal('spotify'),
  spotifyId: SpotifyIdSchema,
  name: z.string().min(1).max(500),
  ownerName: z.string().nullable(),
  description: z.string().nullable(),
  artworkUrl: z.string().url().nullable(),
  snapshotId: z.string().nullable(),
})
const LikedTargetSchema = z.object({ source: z.literal('spotify-liked') })
const TargetSchema = z.discriminatedUnion('source', [
  PlaylistTargetSchema,
  LikedTargetSchema,
])
const Queued = { userId: z.string().min(1), groupKey: z.string().min(1) }
const OptionsSchema = z.discriminatedUnion('source', [
  PlaylistTargetSchema.extend(Queued),
  LikedTargetSchema.extend(Queued),
])
export type PlaylistTarget = z.infer<typeof TargetSchema>

const groupKey = (target: PlaylistTarget) =>
  playlistGroupKey(target.source === 'spotify' ? target.spotifyId : null)

/** Pages Spotify returns for a list of `total` entries; an empty list is one page. */
export const pagesFor = (total: number) =>
  Math.max(1, Math.ceil(total / SPOTIFY_PLAYLIST_PAGE_SIZE))

/**
 * The import target of a stored playlist, for an import the app queues
 * itself. It carries no snapshot, so the job asks Spotify for the current one.
 */
export function storedImportTarget(row: {
  source: string | null
  spotifyId: string | null
  name: string
  ownerName: string | null
  description: string | null
  artworkUrl: string | null
}): PlaylistTarget | null {
  if (row.source === LIKED_SONGS_KEY) return { source: 'spotify-liked' }
  const target = PlaylistTargetSchema.safeParse({
    source: row.source,
    spotifyId: row.spotifyId,
    name: row.name,
    ownerName: row.ownerName,
    description: row.description,
    artworkUrl: row.artworkUrl,
    snapshotId: null,
  })
  return target.success ? target.data : null
}

/** Stored import state and the latest jobs; no Spotify requests. */
export async function getSpotifyPlaylistImports() {
  const liked = (await storedImports()).find(
    (row) => row.source === LIKED_SONGS_KEY,
  )
  const jobs = await latestSpotifyJobs(SPOTIFY_PLAYLIST_IMPORT_TASK)
  const playlistJobs: Record<string, SpotifyPlaylistJob> = {}
  for (const [key, latest] of jobs)
    if (key.startsWith(PLAYLIST_KEY_PREFIX))
      playlistJobs[key.slice(PLAYLIST_KEY_PREFIX.length)] = latest.job
  return SpotifyPlaylistImportsSchema.parse({
    likedSongs: {
      stored: liked ? storedSummary(liked) : null,
      job: jobs.get(LIKED_SONGS_KEY)?.job ?? null,
    },
    jobs: playlistJobs,
  })
}

export async function prepareSpotifyPlaylistImport(
  userId: string | null,
  input: Record<string, unknown>,
) {
  if (!userId) throw refused('Sign in to import Spotify playlists.')
  const target = TargetSchema.parse(input)
  await requirePlaylistAccess(userId)
  return { ...target, userId, groupKey: groupKey(target) }
}

/**
 * Queues one import job for Liked Songs and for each chosen playlist. The
 * playlists are checked against the stored playlist list first, because a
 * refused playlist request would halt every Spotify request.
 */
export async function queueSpotifyPlaylistImports(
  input: SpotifyPlaylistImportInput,
  userId: string,
) {
  const parsed = SpotifyPlaylistImportInputSchema.parse(input)
  await requirePlaylistAccess(userId)
  const chosen = new Set(parsed.playlists.map((item) => item.spotifyId))
  const listed = chosen.size
    ? ((await readSpotifyPlaylistListing(userId))?.playlists ?? []).filter(
        (item) => chosen.has(item.spotifyId),
      )
    : []
  const importable = listed.filter((item) => item.importable)
  const targets: PlaylistTarget[] = [
    ...(parsed.likedSongs
      ? [LikedTargetSchema.parse({ source: LIKED_SONGS_KEY })]
      : []),
    ...importable.map((item) =>
      PlaylistTargetSchema.parse({ ...item, source: 'spotify' }),
    ),
  ]
  const batchId = nanoid()
  for (const target of targets)
    await createTaskJob(SPOTIFY_PLAYLIST_IMPORT_TASK, userId, {
      taskOptions: { ...target, batchId },
    })
  const missing = chosen.size - listed.length
  const refusedCount = listed.length - importable.length
  return EnrichmentResultSchema.parse({
    batchId,
    queued: targets.length,
    skipped: missing + refusedCount,
    warnings: [
      ...(missing
        ? [
            `${missing} playlists are not in the stored playlist list. List playlists again.`,
          ]
        : []),
      ...(refusedCount ? [NOT_IMPORTABLE] : []),
    ],
  })
}

/** Marks a playlist the account can no longer change or read. */
export async function markPlaylistNotEditable(spotifyId: string) {
  await db
    .update(playlist)
    .set({ spotifyEditable: false })
    .where(eq(playlist.spotifyId, spotifyId))
}

/**
 * Reads a playlist's details. Spotify includes its items only for a playlist
 * the account owns or collaborates on, so their absence means the contents
 * must not be requested.
 */
export async function readSpotifyPlaylist(
  request: SpotifyRequest,
  token: string,
  spotifyId: string,
) {
  const data = SpotifyPlaylistSchema.parse(
    await spotifyJson(request, token, `playlists/${spotifyId}`),
  )
  if (data.id !== spotifyId) throw refused('Spotify returned another playlist.')
  return {
    name: data.name.trim().slice(0, 500) || 'Untitled playlist',
    ownerName: data.owner?.display_name?.trim() || null,
    description: data.description?.trim() || null,
    artworkUrl: spotifyArtworkUrl(data.images),
    snapshotId: data.snapshot_id ?? null,
    readable: data.items !== undefined,
    total: data.items?.total ?? 0,
  }
}

type Fetched = { entries: SpotifyLibraryTrack[]; skipped: number }

const overLimit = (action: string) =>
  refused(
    `The playlist has more than ${SPOTIFY_PLAYLIST_ITEM_LIMIT.toLocaleString('en')} tracks, which is more than one import reads. ${action}`,
  )

/**
 * Reads every entry of a playlist or of the saved tracks in pages of 50,
 * recording the pages read as job progress. Null when the job stopped.
 */
export async function readSpotifyTrackEntries(
  context: TaskJobContext,
  request: SpotifyRequest,
  token: string,
  path: string,
  expectedTotal: number | null,
): Promise<Fetched | null> {
  const tracks = new Map<string, SpotifyLibraryTrack>()
  let skipped = 0
  let invalid = 0
  let offset = 0
  let total: number | null = null
  await context.progress({
    pagesRead: 0,
    totalPages: expectedTotal === null ? null : pagesFor(expectedTotal),
  })
  for (let pages = 1; ; pages += 1) {
    // Cancellation is a return value: a thrown error would count against Spotify.
    if (!(await context.isActive())) return null
    const page = SpotifyTrackEntriesPageSchema.parse(
      await spotifyJson(request, token, path, {
        limit: String(SPOTIFY_PLAYLIST_PAGE_SIZE),
        offset: String(offset),
      }),
    )
    if (
      page.offset !== offset ||
      page.items.length > SPOTIFY_PLAYLIST_PAGE_SIZE
    )
      throw refused('Invalid Spotify track pagination')
    if (page.total > SPOTIFY_PLAYLIST_ITEM_LIMIT)
      throw overLimit('Nothing was imported.')
    if (total !== null && total !== page.total)
      throw refused(
        'The playlist changed while it was read. Nothing was imported; try again.',
      )
    total = page.total
    for (const entry of page.items) {
      const result = normalizeSpotifyTrackEntry(entry)
      if (!result.track) {
        if (result.reason === 'invalid') invalid += 1
        else skipped += 1
        continue
      }
      const seen = tracks.get(result.track.spotifyTrackId)
      // A track listed twice keeps its first position and earliest date.
      if (!seen) tracks.set(result.track.spotifyTrackId, result.track)
      else if (
        result.track.addedAt &&
        (!seen.addedAt || result.track.addedAt < seen.addedAt)
      )
        seen.addedAt = result.track.addedAt
    }
    offset += page.items.length
    const done =
      page.next === null || !page.items.length || offset >= page.total
    await context.progress({
      pagesRead: pages,
      totalPages: done ? pages : Math.max(pages, pagesFor(page.total)),
    })
    if (done) break
    if (pages % LOG_EVERY_PAGES === 0)
      await context.log('info', `Read ${offset} of ${page.total} tracks.`)
  }
  if (invalid > 0 && invalid >= tracks.size)
    throw refused(
      'Spotify returned tracks in a form this application does not recognise. Nothing was imported.',
    )
  return { entries: [...tracks.values()], skipped: skipped + invalid }
}

type Imported =
  | { unchanged: true; spotifyId: string }
  | ({ unchanged: false; target: PlaylistTarget } & Fetched)

/**
 * Asks Spotify for a playlist's current version first, so an unchanged
 * playlist costs one request and a playlist the account can no longer read
 * is never requested.
 */
async function fetchTracks(
  context: TaskJobContext,
  options: z.infer<typeof OptionsSchema>,
): Promise<Imported | null> {
  return spotifyOperation(async (request) => {
    const token = await spotifyPlaylistToken(options.userId, request)
    if (options.source === 'spotify-liked') {
      const fetched = await readSpotifyTrackEntries(
        context,
        request,
        token,
        'me/tracks',
        null,
      )
      return fetched && { unchanged: false, target: options, ...fetched }
    }
    const current = await readSpotifyPlaylist(request, token, options.spotifyId)
    if (!current.readable) {
      await markPlaylistNotEditable(options.spotifyId)
      throw refused(NOT_IMPORTABLE)
    }
    const [stored] = await db
      .select({ snapshotId: playlist.snapshotId })
      .from(playlist)
      .where(eq(playlist.spotifyId, options.spotifyId))
    if (stored?.snapshotId && stored.snapshotId === current.snapshotId)
      return { unchanged: true, spotifyId: options.spotifyId }
    if (current.total > SPOTIFY_PLAYLIST_ITEM_LIMIT)
      throw overLimit('Nothing was imported.')
    const fetched = await readSpotifyTrackEntries(
      context,
      request,
      token,
      `playlists/${options.spotifyId}/items`,
      current.total,
    )
    return (
      fetched && {
        unchanged: false,
        target: {
          source: 'spotify',
          spotifyId: options.spotifyId,
          name: current.name,
          ownerName: current.ownerName,
          description: current.description,
          artworkUrl: current.artworkUrl,
          snapshotId: current.snapshotId,
        },
        ...fetched,
      }
    )
  })
}

async function uniquePlaylistName(
  tx: Transaction,
  playlistId: string,
  name: string,
  ownerName: string | null,
) {
  const taken = new Set(
    (
      await tx
        .select({ name: playlist.name })
        .from(playlist)
        .where(and(eq(playlist.kind, 'playlist'), ne(playlist.id, playlistId)))
    ).map((row) => row.name),
  )
  if (!taken.has(name)) return name
  const owned = ownerName ? `${name} (${ownerName})` : null
  if (owned && !taken.has(owned)) return owned
  for (let suffix = 2; ; suffix += 1)
    if (!taken.has(`${name} (${suffix})`)) return `${name} (${suffix})`
}

async function resolvePlaylist(tx: Transaction, target: PlaylistTarget) {
  const [stored] = await tx
    .select({ id: playlist.id })
    .from(playlist)
    .where(
      target.source === 'spotify'
        ? eq(playlist.spotifyId, target.spotifyId)
        : eq(playlist.source, LIKED_SONGS_KEY),
    )
  const name = target.source === 'spotify' ? target.name : LIKED_SONGS_NAME
  // A playlist that came with the legacy library keeps its album members.
  const [legacy] = stored
    ? []
    : await tx
        .select({ id: playlist.id })
        .from(playlist)
        .where(
          and(
            eq(playlist.name, name),
            eq(playlist.kind, 'playlist'),
            isNull(playlist.source),
          ),
        )
  const id =
    stored?.id ?? legacy?.id ?? createStableId('playlist', groupKey(target))
  const now = new Date()
  const values = {
    name: legacy
      ? name
      : await uniquePlaylistName(
          tx,
          id,
          name,
          target.source === 'spotify' ? target.ownerName : null,
        ),
    source: target.source,
    spotifyId: target.source === 'spotify' ? target.spotifyId : null,
    ownerName: target.source === 'spotify' ? target.ownerName : null,
    description: target.source === 'spotify' ? target.description : null,
    artworkUrl: target.source === 'spotify' ? target.artworkUrl : null,
    spotifyUrl:
      target.source === 'spotify' ? playlistUrl(target.spotifyId) : null,
    snapshotId: target.source === 'spotify' ? target.snapshotId : null,
    importedAt: now,
    checkedAt: now,
    spotifyEditable: true,
  }
  await tx
    .insert(playlist)
    .values({ id, kind: 'playlist', ...values })
    .onConflictDoUpdate({ target: playlist.id, set: values })
  return id
}

const trackItemId = (spotifyTrackId: string) =>
  createStableId('library-track', `spotify:${spotifyTrackId}`)

/** Deletes tracks with neither playlist membership nor imported Last.fm history. */
export async function removeOrphanTracks(tx: Transaction) {
  const removed = await tx.execute(sql`
    delete from media_item mi
    where mi.media_type = 'track' and not exists (
      select 1 from playlist_item pi where pi.media_item_id = mi.id)
      and not exists (select 1 from lastfm_track_source s where s.track_media_item_id = mi.id)`)
  return removed.rowCount ?? 0
}

/** The earliest playlist-added date or first imported scrobble. */
export async function refreshTrackAddedDates(tx: Transaction) {
  await tx.execute(sql`
    update library_track lt set date_added = m.added
    from library_track base
    left join (
      select media_item_id, min(added_at) as added from (
        select media_item_id, added_at from playlist_item
        union all
        select l.track_media_item_id, s.listened_at
        from lastfm_track_source l join lastfm_scrobble s
          on s.username = l.username and s.artist_key = l.artist_key and s.track_key = l.track_key
      ) dates group by media_item_id
    ) m on m.media_item_id = base.media_item_id
    where lt.media_item_id = base.media_item_id
      and lt.date_added is distinct from m.added`)
}

async function storeImport(
  target: PlaylistTarget,
  tracks: SpotifyLibraryTrack[],
) {
  return db.transaction(async (tx) => {
    // One import writes at a time, so two cannot both judge a track orphaned.
    await tx.execute(sql`select pg_advisory_xact_lock(614105)`)
    const playlistId = await resolvePlaylist(tx, target)
    for (let start = 0; start < tracks.length; start += WRITE_BATCH) {
      const batch = tracks.slice(start, start + WRITE_BATCH)
      const ids = batch.map((track) => trackItemId(track.spotifyTrackId))
      const items: Array<typeof mediaItem.$inferInsert> = batch.map((track) => {
        const id = trackItemId(track.spotifyTrackId)
        return {
          id,
          mediaType: 'track',
          slug: slugifyParts(track.title, id),
          title: track.title,
          artworkUrl: track.artworkUrl,
          releaseDate: parseOptionalDate(track.releaseDate),
          sourceLabel: 'spotify',
        }
      })
      await tx
        .insert(mediaItem)
        .values(items)
        .onConflictDoUpdate({
          target: mediaItem.id,
          set: {
            title: sql`excluded.title`,
            artworkUrl: sql`excluded.artwork_url`,
            releaseDate: sql`excluded.release_date`,
            updatedAt: new Date(),
          },
        })
      await tx
        .insert(libraryTrack)
        .values(
          batch.map((track) => ({
            mediaItemId: trackItemId(track.spotifyTrackId),
            spotifyTrackId: track.spotifyTrackId,
            isrc: track.isrc,
            durationSec: track.durationSec,
            spotifyUrl: `https://open.spotify.com/track/${track.spotifyTrackId}`,
            albumName: track.albumName,
            spotifyAlbumId: track.spotifyAlbumId,
          })),
        )
        .onConflictDoUpdate({
          target: libraryTrack.mediaItemId,
          set: {
            isrc: sql`excluded.isrc`,
            durationSec: sql`excluded.duration_sec`,
            albumName: sql`excluded.album_name`,
            spotifyAlbumId: sql`excluded.spotify_album_id`,
            updatedAt: new Date(),
          },
        })
      const artists = new Map<string, string>()
      for (const track of batch)
        for (const name of track.artists)
          artists.set(createStableId('artist', name.toLowerCase()), name)
      await tx
        .insert(artist)
        .values(
          [...artists].map(([id, name]) => ({ id, name, sortName: name })),
        )
        .onConflictDoNothing()
      await tx
        .delete(mediaCredit)
        .where(
          and(
            inArray(mediaCredit.mediaItemId, ids),
            eq(mediaCredit.role, 'artist'),
          ),
        )
      await tx
        .insert(mediaCredit)
        .values(
          batch.flatMap((track) =>
            track.artists.map((name, billingOrder) => ({
              mediaItemId: trackItemId(track.spotifyTrackId),
              artistId: createStableId('artist', name.toLowerCase()),
              role: 'artist',
              billingOrder,
            })),
          ),
        )
        // Two spellings of one artist on a track share an artist row.
        .onConflictDoNothing()
    }
    await tx.execute(sql`
      delete from playlist_item pi using library_track lt
      where pi.playlist_id = ${playlistId}
        and lt.media_item_id = pi.media_item_id`)
    for (let start = 0; start < tracks.length; start += WRITE_BATCH)
      await tx.insert(playlistItem).values(
        tracks.slice(start, start + WRITE_BATCH).map((track, index) => ({
          playlistId,
          mediaItemId: trackItemId(track.spotifyTrackId),
          position: start + index + 1,
          addedAt: parseOptionalDate(track.addedAt),
        })),
      )
    const removed = await removeOrphanTracks(tx)
    await refreshTrackAddedDates(tx)
    return { playlistId, removed }
  })
}

/**
 * One import job: reads every track of a playlist or of Liked Songs, replaces
 * the stored playlist with them, then relinks tracks to albums and scrobbles.
 * Nothing is stored unless every page was read. An unchanged playlist only
 * records the check.
 */
export async function runSpotifyPlaylistImport(
  context: TaskJobContext,
  input: Record<string, unknown>,
): Promise<TaskJobResult> {
  try {
    const options = OptionsSchema.parse(input)
    await context.assertActive()
    const fetched = await fetchTracks(context, options)
    if (!fetched || !(await context.isActive())) return { outcome: 'stopped' }
    if (fetched.unchanged) {
      await db
        .update(playlist)
        .set({ checkedAt: new Date(), spotifyEditable: true })
        .where(eq(playlist.spotifyId, fetched.spotifyId))
      return {
        outcome: 'complete',
        message: 'The playlist has not changed since the last import.',
      }
    }
    const stored = await storeImport(fetched.target, fetched.entries)
    await refreshTrackLinks(await getLastfmAccount())
    const name =
      fetched.target.source === 'spotify'
        ? fetched.target.name
        : LIKED_SONGS_NAME
    return {
      outcome: 'complete',
      message: [
        `Imported ${fetched.entries.length} tracks from ${name}.`,
        ...(fetched.skipped
          ? [
              `${fetched.skipped} entries were skipped: local files, episodes or unavailable tracks.`,
            ]
          : []),
        ...(stored.removed
          ? [`${stored.removed} tracks left the track library.`]
          : []),
      ].join(' '),
      options: {
        playlistId: stored.playlistId,
        trackCount: fetched.entries.length,
      },
    }
  } catch (error) {
    if (!(await context.isActive())) return { outcome: 'stopped' }
    return { outcome: 'failed', error }
  }
}
