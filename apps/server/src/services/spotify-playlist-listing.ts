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
import { createStableId } from '@/lib/media-utils'
import {
  SpotifyPlaylistsPageSchema,
  SpotifyProfileSchema,
  spotifyArtworkUrl,
  spotifyJson,
  type SpotifyRequest,
} from '@/lib/spotify-api'
import { playlist, spotifyPlaylistListing } from '@/schemas/db'
import { createTaskJob, type TaskJobContext, type TaskJobResult } from './jobs'
import { observeCatalogOccurrences } from './catalog-discoveries'
import { lockLibraryTrackWrites } from './album-library-tracks'
import { loadPlaylistSummaries } from './playlist-directory'
import { spotifyOperation, spotifyPlaylistToken } from './spotify-oauth'
import {
  NOT_IMPORTABLE,
  latestSpotifyJobs,
  listStoredSpotifyImports,
  playlistGroupKey,
  playlistUrl,
  readSpotifyPlaylistListing,
  refused,
  requirePlaylistAccess,
  storedSummary,
  type ListedPlaylist,
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
    const discovered = []
    for (const [index, item] of page.items.entries()) {
      if (!item) continue
      const summary = {
        spotifyId: item.id,
        name: item.name.trim().slice(0, 500) || 'Untitled playlist',
        ownerName: item.owner?.display_name?.trim() || null,
        description: item.description?.trim() || null,
        artworkUrl: spotifyArtworkUrl(item.images),
        snapshotId: item.snapshot_id ?? null,
        importable:
          item.owner?.id === profile.id || item.collaborative === true,
        trackTotal: item.items?.total ?? item.tracks?.total ?? 0,
      }
      listed.set(item.id, summary)
      discovered.push({ summary, position: offset + index + 1 })
    }
    await observeSpotifyPlaylists(discovered, {
      jobId: context.jobId,
      page: pages,
    })
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

type ListedOccurrence = { summary: ListedPlaylist; position: number }

export async function observeSpotifyPlaylists(
  discovered: ListedOccurrence[],
  evidence: { jobId?: string; page?: number; observedAt?: Date },
) {
  if (!discovered.length) return
  await db.transaction(async (tx) => {
    await lockLibraryTrackWrites(tx)
    const ids = [...new Set(discovered.map(({ summary }) => summary.spotifyId))]
    const [known, names] = await Promise.all([
      tx
        .select({ id: playlist.id, spotifyId: playlist.spotifyId })
        .from(playlist)
        .where(inArray(playlist.spotifyId, ids)),
      tx
        .select({ name: playlist.name })
        .from(playlist)
        .where(eq(playlist.kind, 'playlist')),
    ])
    const local = new Map(known.map(({ spotifyId, id }) => [spotifyId, id]))
    const taken = new Set(names.map(({ name }) => name))
    const rows: (typeof playlist.$inferInsert)[] = []
    for (const { summary } of discovered) {
      if (local.has(summary.spotifyId)) continue
      const id = createStableId('playlist', playlistGroupKey(summary.spotifyId))
      let name = summary.name
      for (let suffix = 2; taken.has(name); suffix += 1)
        name = `${summary.name} (${suffix})`
      taken.add(name)
      local.set(summary.spotifyId, id)
      rows.push({
        id,
        kind: 'playlist',
        name,
        spotifyId: summary.spotifyId,
        catalogProvider: 'spotify',
        catalogExternalId: summary.spotifyId,
        spotifyUrl: playlistUrl(summary.spotifyId),
        artworkUrl: summary.artworkUrl,
        spotifyEditable: false,
      })
    }
    if (rows.length)
      await tx.insert(playlist).values(rows).onConflictDoNothing()
    const stored = await tx
      .select({ id: playlist.id, spotifyId: playlist.spotifyId })
      .from(playlist)
      .where(inArray(playlist.spotifyId, ids))
    const storedIds = new Map(
      stored.map(({ spotifyId, id }) => [spotifyId, id]),
    )
    await observeCatalogOccurrences(
      tx,
      discovered.flatMap(({ summary, position }) => {
        const id = storedIds.get(summary.spotifyId)
        return id
          ? [
              {
                target: { kind: 'playlist', id },
                origin: {
                  provider: 'spotify',
                  operation: 'playlist-listing',
                  occurrenceKey: summary.spotifyId,
                  position,
                  ...evidence,
                  details: {
                    name: summary.name,
                    snapshot: summary.snapshotId,
                    trackCount: summary.trackTotal,
                  },
                },
              },
            ]
          : []
      }),
    )
  })
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
    const listed = await spotifyOperation(
      async (request) =>
        listAccountPlaylists(
          context,
          request,
          await spotifyPlaylistToken(options.userId, request),
        ),
      context.jobId,
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
  const playlists = listing?.playlists ?? []
  const spotifyIds = playlists.map((item) => item.spotifyId)
  const [stored, imports, listings, known] = await Promise.all([
    listStoredSpotifyImports(spotifyIds),
    latestSpotifyJobs(
      SPOTIFY_PLAYLIST_IMPORT_TASK,
      spotifyIds.map(playlistGroupKey),
    ),
    latestSpotifyJobs(SPOTIFY_PLAYLIST_LISTING_TASK, [listingGroupKey(userId)]),
    spotifyIds.length
      ? db
          .select({ id: playlist.id, spotifyId: playlist.spotifyId })
          .from(playlist)
          .where(inArray(playlist.spotifyId, spotifyIds))
      : [],
  ])
  const bySpotifyId = new Map(stored.map((row) => [row.spotifyId, row]))
  const summaries = await loadPlaylistSummaries(
    stored.map((row) => row.id),
    imports,
  )
  const byId = new Map(summaries.map((summary) => [summary.id, summary]))
  const knownIds = new Map(known.map((row) => [row.spotifyId, row.id]))
  return SpotifyPlaylistListSchema.parse({
    total: playlists.length,
    listedAt: listing?.listedAt.toISOString() ?? null,
    job: listings.get(listingGroupKey(userId))?.job ?? null,
    playlists: playlists.map((item) => {
      const row = bySpotifyId.get(item.spotifyId)
      const summary = row && byId.get(row.id)
      return {
        spotifyId: item.spotifyId,
        catalogId: knownIds.get(item.spotifyId),
        name: item.name,
        ownerName: item.ownerName,
        importable: item.importable,
        notImportableReason: notImportableReason(item),
        trackTotal: item.trackTotal,
        artworkUrl: item.artworkUrl,
        spotifyUrl: playlistUrl(item.spotifyId),
        stored: summary ? storedSummary(summary) : null,
        current: Boolean(
          summary &&
          row &&
          item.snapshotId &&
          row.snapshotId === item.snapshotId,
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
