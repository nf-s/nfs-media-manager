import { and, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import { EnrichmentResultSchema } from '@repo/schemas/job'
import {
  SPOTIFY_PLAYLIST_IMPORT_TASK,
  SPOTIFY_PLAYLIST_ITEM_LIMIT,
  SpotifyPlaylistImportInputSchema,
  SpotifyPlaylistImportJobSchema,
  SpotifyPlaylistImportsSchema,
  SpotifyPlaylistListSchema,
  type SpotifyPlaylistImportInput,
} from '@repo/schemas/tracks'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import {
  createStableId,
  parseOptionalDate,
  slugifyParts,
} from '@/lib/media-utils'
import {
  SpotifyIdSchema,
  SpotifyPlaylistsPageSchema,
  SpotifyProfileSchema,
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
  scrapeJob,
} from '@/schemas/db'
import { createTaskJob, type TaskJobResult } from './jobs'
import { getLastfmAccount, type LastfmSyncJobContext } from './lastfm-scrobbles'
import {
  getSpotifyAccountStatus,
  spotifyOperation,
  spotifyPlaylistToken,
} from './spotify-oauth'
import { refreshTrackLinks } from './track-links'

const PAGE_SIZE = 50
// The account's playlist list is read in full; this bounds a runaway listing.
const MAX_LISTED_PLAYLISTS = 2000
const WRITE_BATCH = 500
const LOG_EVERY_PAGES = 40
const LIKED_SONGS_KEY = 'spotify-liked'
const PLAYLIST_KEY_PREFIX = 'spotify:'
const LIKED_SONGS_NAME = 'Liked Songs'
const NOT_IMPORTABLE =
  'Spotify returns tracks only for playlists the account owns or collaborates on. Copy the playlist into the account to import it.'

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
type Target = z.infer<typeof TargetSchema>

const activeListings = new Set<string>()

function refused(message: string) {
  return new ServerError({ statusCode: 422, message })
}

const groupKey = (target: Target) =>
  target.source === 'spotify'
    ? `${PLAYLIST_KEY_PREFIX}${target.spotifyId}`
    : LIKED_SONGS_KEY

const playlistUrl = (spotifyId: string) =>
  `https://open.spotify.com/playlist/${spotifyId}`

async function requirePlaylistAccess(userId: string) {
  const status = await getSpotifyAccountStatus(userId)
  if (!status.configured)
    throw refused(
      'Spotify is not configured. Configure and connect the account first.',
    )
  if (!status.connected)
    throw refused('Connect a Spotify account before reading playlists')
  if (!status.playlists)
    throw refused(
      'Reconnect the Spotify account to allow playlist access. The current connection does not include it.',
    )
}

async function listAccountPlaylists(request: SpotifyRequest, token: string) {
  const profile = SpotifyProfileSchema.parse(
    await spotifyJson(request, token, 'me'),
  )
  const listed = new Map<
    string,
    z.infer<typeof PlaylistTargetSchema> & {
      importable: boolean
      trackTotal: number
    }
  >()
  let offset = 0
  for (;;) {
    const page = SpotifyPlaylistsPageSchema.parse(
      await spotifyJson(request, token, 'me/playlists', {
        limit: String(PAGE_SIZE),
        offset: String(offset),
      }),
    )
    if (page.offset !== offset)
      throw refused('Invalid Spotify playlist pagination')
    for (const item of page.items) {
      if (!item) continue
      listed.set(item.id, {
        source: 'spotify',
        spotifyId: item.id,
        name: item.name.trim().slice(0, 500) || 'Untitled playlist',
        ownerName: item.owner?.display_name?.trim() || null,
        description: item.description?.trim() || null,
        artworkUrl: spotifyArtworkUrl(item.images),
        snapshotId: item.snapshot_id ?? null,
        importable:
          item.owner?.id === profile.id || item.collaborative === true,
        trackTotal: item.items?.total ?? item.tracks?.total ?? 0,
      })
    }
    offset += page.items.length
    if (
      page.next === null ||
      !page.items.length ||
      offset >= page.total ||
      offset >= MAX_LISTED_PLAYLISTS
    )
      break
  }
  return [...listed.values()]
}

async function accountPlaylists(userId: string) {
  if (activeListings.has(userId))
    throw new ServerError({
      statusCode: 409,
      message:
        'Spotify playlists are already being read. Wait for it to finish.',
    })
  activeListings.add(userId)
  try {
    return await spotifyOperation(async (request) =>
      listAccountPlaylists(
        request,
        await spotifyPlaylistToken(userId, request),
      ),
    )
  } finally {
    activeListings.delete(userId)
  }
}

async function latestImportJobs() {
  const jobs = await db
    .selectDistinctOn([sql`${scrapeJob.options}->>'groupKey'`], {
      id: scrapeJob.id,
      status: scrapeJob.status,
      errorMessage: scrapeJob.errorMessage,
      finishedAt: scrapeJob.finishedAt,
      groupKey: sql<unknown>`${scrapeJob.options}->>'groupKey'`,
    })
    .from(scrapeJob)
    .where(
      and(
        eq(scrapeJob.provider, 'spotify'),
        sql`${scrapeJob.options}->>'task' = ${SPOTIFY_PLAYLIST_IMPORT_TASK}`,
      ),
    )
    .orderBy(
      sql`${scrapeJob.options}->>'groupKey'`,
      desc(scrapeJob.createdAt),
      desc(scrapeJob.id),
    )
  const latest = new Map<
    string,
    z.infer<typeof SpotifyPlaylistImportJobSchema>
  >()
  for (const job of jobs) {
    const key = z.string().safeParse(job.groupKey)
    if (key.success)
      latest.set(
        key.data,
        SpotifyPlaylistImportJobSchema.parse({
          jobId: job.id,
          status: job.status,
          errorMessage: job.errorMessage,
          finishedAt: job.finishedAt?.toISOString() ?? null,
        }),
      )
  }
  return latest
}

const StoredRowsSchema = z.array(
  z.object({
    id: z.string(),
    source: z.string(),
    spotify_id: z.string().nullable(),
    snapshot_id: z.string().nullable(),
    imported_at: z.string().nullable(),
    track_count: z.number().int().nonnegative(),
  }),
)

async function storedImports() {
  return StoredRowsSchema.parse(
    (
      await db.execute(sql`
        select p.id, p.source, p.spotify_id, p.snapshot_id,
          to_char(p.imported_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as imported_at,
          (select count(*)::int from playlist_item pi
            join library_track lt on lt.media_item_id = pi.media_item_id
            where pi.playlist_id = p.id) as track_count
        from playlist p where p.source is not null`)
    ).rows,
  )
}

const storedSummary = (row: z.infer<typeof StoredRowsSchema>[number]) => ({
  playlistId: row.id,
  importedAt: row.imported_at,
  trackCount: row.track_count,
})

/** Reads the account's playlists from Spotify and marks the imported ones. */
export async function listSpotifyPlaylists(userId: string) {
  await requirePlaylistAccess(userId)
  const listed = await accountPlaylists(userId)
  const stored = new Map<string, z.infer<typeof StoredRowsSchema>[number]>()
  for (const row of await storedImports())
    if (row.spotify_id) stored.set(row.spotify_id, row)
  const jobs = await latestImportJobs()
  return SpotifyPlaylistListSchema.parse({
    total: listed.length,
    playlists: listed.map((item) => {
      const row = stored.get(item.spotifyId)
      return {
        spotifyId: item.spotifyId,
        name: item.name,
        ownerName: item.ownerName,
        importable: item.importable,
        trackTotal: item.trackTotal,
        artworkUrl: item.artworkUrl,
        stored: row ? storedSummary(row) : null,
        current: Boolean(
          row && item.snapshotId && row.snapshot_id === item.snapshotId,
        ),
        job: jobs.get(groupKey(item)) ?? null,
      }
    }),
  })
}

/** Stored import state and the latest jobs; no Spotify requests. */
export async function getSpotifyPlaylistImports() {
  const liked = (await storedImports()).find(
    (row) => row.source === LIKED_SONGS_KEY,
  )
  const jobs = await latestImportJobs()
  const playlistJobs: Record<
    string,
    z.infer<typeof SpotifyPlaylistImportJobSchema>
  > = {}
  for (const [key, job] of jobs)
    if (key.startsWith(PLAYLIST_KEY_PREFIX))
      playlistJobs[key.slice(PLAYLIST_KEY_PREFIX.length)] = job
  return SpotifyPlaylistImportsSchema.parse({
    likedSongs: {
      stored: liked ? storedSummary(liked) : null,
      job: jobs.get(LIKED_SONGS_KEY) ?? null,
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
 * playlists are checked against the account's own list first, because a
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
    ? (await accountPlaylists(userId)).filter((item) =>
        chosen.has(item.spotifyId),
      )
    : []
  const importable = listed.filter((item) => item.importable)
  const targets: Target[] = [
    ...(parsed.likedSongs
      ? [LikedTargetSchema.parse({ source: LIKED_SONGS_KEY })]
      : []),
    ...importable.map((item) => PlaylistTargetSchema.parse(item)),
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
        ? [`${missing} playlists are no longer in the Spotify account.`]
        : []),
      ...(refusedCount ? [NOT_IMPORTABLE] : []),
    ],
  })
}

type Fetched = { entries: SpotifyLibraryTrack[]; skipped: number }

async function fetchTracks(
  context: LastfmSyncJobContext,
  options: z.infer<typeof OptionsSchema>,
): Promise<Fetched | null> {
  const path =
    options.source === 'spotify'
      ? `playlists/${options.spotifyId}/items`
      : 'me/tracks'
  return spotifyOperation(async (request) => {
    const token = await spotifyPlaylistToken(options.userId, request)
    const tracks = new Map<string, SpotifyLibraryTrack>()
    let skipped = 0
    let invalid = 0
    let offset = 0
    let total: number | null = null
    for (let pages = 1; ; pages += 1) {
      // Cancellation is a return value: a thrown error would count against Spotify.
      if (!(await context.isActive())) return null
      const page = SpotifyTrackEntriesPageSchema.parse(
        await spotifyJson(request, token, path, {
          limit: String(PAGE_SIZE),
          offset: String(offset),
        }),
      )
      if (page.offset !== offset || page.items.length > PAGE_SIZE)
        throw refused('Invalid Spotify track pagination')
      if (page.total > SPOTIFY_PLAYLIST_ITEM_LIMIT)
        throw refused(
          `The playlist has more than ${SPOTIFY_PLAYLIST_ITEM_LIMIT.toLocaleString('en')} tracks, which is more than one import reads. Nothing was imported.`,
        )
      if (total !== null && total !== page.total)
        throw refused(
          'The playlist changed during the import. Nothing was imported; import it again.',
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
      if (page.next === null || !page.items.length || offset >= page.total)
        break
      if (pages % LOG_EVERY_PAGES === 0)
        await context.log('info', `Read ${offset} of ${page.total} tracks.`)
    }
    if (invalid > 0 && invalid >= tracks.size)
      throw refused(
        'Spotify returned tracks in a form this application does not recognise. Nothing was imported.',
      )
    return { entries: [...tracks.values()], skipped: skipped + invalid }
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

async function resolvePlaylist(tx: Transaction, target: Target) {
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
    importedAt: new Date(),
  }
  await tx
    .insert(playlist)
    .values({ id, kind: 'playlist', ...values })
    .onConflictDoUpdate({ target: playlist.id, set: values })
  return id
}

const trackItemId = (spotifyTrackId: string) =>
  createStableId('library-track', `spotify:${spotifyTrackId}`)

/** Deletes tracks that are in no playlist. */
export async function removeOrphanTracks(tx: Transaction) {
  const removed = await tx.execute(sql`
    delete from media_item mi
    where mi.media_type = 'track' and not exists (
      select 1 from playlist_item pi where pi.media_item_id = mi.id)`)
  return removed.rowCount ?? 0
}

/** A track's added date is the earliest date it joined an imported playlist. */
export async function refreshTrackAddedDates(tx: Transaction) {
  await tx.execute(sql`
    update library_track lt set date_added = m.added
    from library_track base
    left join (
      select media_item_id, min(added_at) as added
      from playlist_item group by media_item_id
    ) m on m.media_item_id = base.media_item_id
    where lt.media_item_id = base.media_item_id
      and lt.date_added is distinct from m.added`)
}

async function storeImport(target: Target, tracks: SpotifyLibraryTrack[]) {
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
 * Nothing is stored unless every page was read.
 */
export async function runSpotifyPlaylistImport(
  context: LastfmSyncJobContext,
  input: Record<string, unknown>,
): Promise<TaskJobResult> {
  try {
    const options = OptionsSchema.parse(input)
    await context.assertActive()
    if (options.source === 'spotify' && options.snapshotId) {
      const [stored] = await db
        .select({ snapshotId: playlist.snapshotId })
        .from(playlist)
        .where(eq(playlist.spotifyId, options.spotifyId))
      if (stored?.snapshotId === options.snapshotId)
        return {
          outcome: 'complete',
          message: 'The playlist has not changed since the last import.',
        }
    }
    const fetched = await fetchTracks(context, options)
    if (!fetched || !(await context.isActive())) return { outcome: 'stopped' }
    const stored = await storeImport(options, fetched.entries)
    await refreshTrackLinks(await getLastfmAccount())
    const name = options.source === 'spotify' ? options.name : LIKED_SONGS_NAME
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
