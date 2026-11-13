import { and, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import {
  SPOTIFY_PLAYLIST_IMPORT_TASK,
  SPOTIFY_PLAYLIST_ITEM_LIMIT,
  SPOTIFY_PLAYLIST_LISTING_TASK,
  SPOTIFY_PLAYLIST_PAGE_SIZE,
  SpotifyPlaylistListSchema,
  type SpotifyPlaylistList,
} from '@repo/schemas/tracks'
import { db } from '@/lib/db'
import {
  SpotifyPlaylistsPageSchema,
  SpotifyProfileSchema,
  spotifyArtworkUrl,
  spotifyJson,
  type SpotifyRequest,
} from '@/lib/spotify-api'
import { playlist, spotifyPlaylistListing } from '@/schemas/db'
import { createTaskJob, type TaskJobContext, type TaskJobResult } from './jobs'
import { spotifyOperation, spotifyPlaylistToken } from './spotify-oauth'
import {
  NOT_IMPORTABLE,
  latestSpotifyJobs,
  playlistGroupKey,
  playlistUrl,
  readSpotifyPlaylistListing,
  refused,
  requirePlaylistAccess,
  storedImports,
  storedSummary,
  type ListedPlaylist,
  type StoredImport,
} from './spotify-playlist-state'

// The account's playlist list is read in full; this bounds a runaway listing.
const MAX_LISTED_PLAYLISTS = 2000

const OptionsSchema = z.object({
  userId: z.string().min(1),
  groupKey: z.string().min(1),
})

const listingGroupKey = (userId: string) => `spotify-listing:${userId}`

export async function prepareSpotifyPlaylistListing(userId: string | null) {
  if (!userId) throw refused('Sign in to list Spotify playlists.')
  await requirePlaylistAccess(userId)
  return { userId, groupKey: listingGroupKey(userId) }
}

async function listAccountPlaylists(
  context: TaskJobContext,
  request: SpotifyRequest,
  token: string,
): Promise<ListedPlaylist[] | null> {
  const profile = SpotifyProfileSchema.parse(
    await spotifyJson(request, token, 'me'),
  )
  const listed = new Map<string, ListedPlaylist>()
  let offset = 0
  await context.progress({ pagesRead: 0, totalPages: null })
  for (let pages = 1; ; pages += 1) {
    // Cancellation is a return value: a thrown error would count against Spotify.
    if (!(await context.isActive())) return null
    const page = SpotifyPlaylistsPageSchema.parse(
      await spotifyJson(request, token, 'me/playlists', {
        limit: String(SPOTIFY_PLAYLIST_PAGE_SIZE),
        offset: String(offset),
      }),
    )
    if (page.offset !== offset)
      throw refused('Invalid Spotify playlist pagination')
    for (const item of page.items) {
      if (!item) continue
      listed.set(item.id, {
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
    const done =
      page.next === null ||
      !page.items.length ||
      offset >= page.total ||
      offset >= MAX_LISTED_PLAYLISTS
    const expected = Math.ceil(
      Math.min(page.total, MAX_LISTED_PLAYLISTS) / SPOTIFY_PLAYLIST_PAGE_SIZE,
    )
    await context.progress({
      pagesRead: pages,
      totalPages: done ? pages : Math.max(pages, expected),
    })
    if (done) break
  }
  return [...listed.values()]
}

/**
 * One listing job: reads the account's playlists and replaces the stored
 * list. Imported playlists record whether the account can still change them.
 */
export async function runSpotifyPlaylistListing(
  context: TaskJobContext,
  input: Record<string, unknown>,
): Promise<TaskJobResult> {
  try {
    const options = OptionsSchema.parse(input)
    await context.assertActive()
    const listed = await spotifyOperation(async (request) =>
      listAccountPlaylists(
        context,
        request,
        await spotifyPlaylistToken(options.userId, request),
      ),
    )
    if (!listed || !(await context.isActive())) return { outcome: 'stopped' }
    const listedAt = new Date()
    await db.transaction(async (tx) => {
      await tx
        .insert(spotifyPlaylistListing)
        .values({ userId: options.userId, playlists: listed, listedAt })
        .onConflictDoUpdate({
          target: spotifyPlaylistListing.userId,
          set: { playlists: listed, listedAt },
        })
      for (const editable of [true, false]) {
        const ids = listed
          .filter((item) => item.importable === editable)
          .map((item) => item.spotifyId)
        if (ids.length)
          await tx
            .update(playlist)
            .set({ spotifyEditable: editable })
            .where(
              and(
                eq(playlist.source, 'spotify'),
                inArray(playlist.spotifyId, ids),
              ),
            )
      }
    })
    return {
      outcome: 'complete',
      message: `Listed ${listed.length} playlists.`,
      options: { playlistCount: listed.length },
    }
  } catch (error) {
    if (!(await context.isActive())) return { outcome: 'stopped' }
    return { outcome: 'failed', error }
  }
}

function notImportableReason(item: ListedPlaylist) {
  if (!item.importable) return NOT_IMPORTABLE
  if (item.trackTotal > SPOTIFY_PLAYLIST_ITEM_LIMIT)
    return `The playlist has more than ${SPOTIFY_PLAYLIST_ITEM_LIMIT.toLocaleString('en')} tracks, which is more than one import reads.`
  return null
}

/** The stored playlist list with import state and the latest jobs; no Spotify requests. */
export async function getSpotifyPlaylists(
  userId: string,
): Promise<SpotifyPlaylistList> {
  const listing = await readSpotifyPlaylistListing(userId)
  const stored = new Map<string, StoredImport>()
  for (const row of await storedImports())
    if (row.spotify_id) stored.set(row.spotify_id, row)
  const imports = await latestSpotifyJobs(SPOTIFY_PLAYLIST_IMPORT_TASK)
  const listings = await latestSpotifyJobs(SPOTIFY_PLAYLIST_LISTING_TASK)
  const playlists = listing?.playlists ?? []
  return SpotifyPlaylistListSchema.parse({
    total: playlists.length,
    listedAt: listing?.listedAt.toISOString() ?? null,
    job: listings.get(listingGroupKey(userId))?.job ?? null,
    playlists: playlists.map((item) => {
      const row = stored.get(item.spotifyId)
      return {
        spotifyId: item.spotifyId,
        name: item.name,
        ownerName: item.ownerName,
        importable: item.importable,
        notImportableReason: notImportableReason(item),
        trackTotal: item.trackTotal,
        artworkUrl: item.artworkUrl,
        spotifyUrl: playlistUrl(item.spotifyId),
        stored: row ? storedSummary(row) : null,
        current: Boolean(
          row && item.snapshotId && row.snapshot_id === item.snapshotId,
        ),
        job: imports.get(playlistGroupKey(item.spotifyId))?.job ?? null,
      }
    }),
  })
}

/**
 * Queues a listing job, or keeps the one already queued or running, and
 * returns the stored list with that job.
 */
export async function queueSpotifyPlaylistListing(userId: string) {
  await createTaskJob(SPOTIFY_PLAYLIST_LISTING_TASK, userId)
  return getSpotifyPlaylists(userId)
}
