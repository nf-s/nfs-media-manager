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
import { baseTitleKey } from '@/lib/lastfm-album-matching'
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
  libraryTrack,
  mediaCredit,
  mediaItem,
  playlist,
  playlistItem,
} from '@/schemas/db'
import { writeArtistCredits } from './artist-names'
import { createTaskJob, type TaskJobContext, type TaskJobResult } from './jobs'
import { getLastfmAccount } from './lastfm-scrobbles'
import { loadPlaylistSummaries } from './playlist-directory'
import {
  lockLibraryTrackWrites,
  removeOrphanTracks,
} from './album-library-tracks'
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
  const [likedRows, jobs] = await Promise.all([
    db
      .select({ id: playlist.id })
      .from(playlist)
      .where(
        and(
          eq(playlist.kind, 'playlist'),
          eq(playlist.source, LIKED_SONGS_KEY),
        ),
      )
      .orderBy(playlist.id)
      .limit(1),
    latestSpotifyJobs(SPOTIFY_PLAYLIST_IMPORT_TASK),
  ])
  const [liked] = await loadPlaylistSummaries(
    likedRows.map((row) => row.id),
    jobs,
  )
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

export const spotifyTrackItemId = (spotifyTrackId: string) =>
  createStableId('library-track', `spotify:${spotifyTrackId}`)

const SpotifyTrackCandidateRowsSchema = z.array(
  z.object({
    spotify_track_id: z.string(),
    existing_id: z.string().nullable(),
    album_recording_id: z.string().nullable(),
    album_title: z.string().nullable(),
    known_album_id: z.boolean().nullable(),
    same_album_id: z.boolean().nullable(),
  }),
)

/** Exact Spotify IDs win, then a uniquely corroborated album recording can gain an ID. */
export async function resolveSpotifyTrackIds(
  tx: Transaction,
  tracks: Pick<
    SpotifyLibraryTrack,
    'spotifyTrackId' | 'spotifyAlbumId' | 'title' | 'artists' | 'albumName'
  >[],
  { choosingOneCandidate = false }: { choosingOneCandidate?: boolean } = {},
) {
  if (!tracks.length) return new Map<string, string>()
  const incoming = tracks.map(
    ({ spotifyTrackId, spotifyAlbumId, title, artists }) => ({
      spotifyTrackId,
      spotifyAlbumId,
      title,
      artists,
    }),
  )
  const candidates = SpotifyTrackCandidateRowsSchema.parse(
    (
      await tx.execute(sql`
      select r."spotifyTrackId" as spotify_track_id, existing.media_item_id as existing_id,
        possible.id as album_recording_id, possible.album_title, possible.known_album_id, possible.same_album_id
      from jsonb_to_recordset(${JSON.stringify(incoming)}::jsonb)
        as r("spotifyTrackId" text, "spotifyAlbumId" text, title text, artists text[])
      left join library_track existing on existing.spotify_track_id = r."spotifyTrackId"
      left join lateral (
        select lt.media_item_id as id, am.title as album_title,
          (
            al.spotify_url ~ '/album/[A-Za-z0-9]{22}([/?#]|$)'
            or exists (select 1 from provider_reference ref where ref.media_item_id = am.id
              and (ref.reference_type = 'spotify' or (ref.provider = 'spotify' and ref.reference_type = 'album')))
          ) as known_album_id,
          (
            al.spotify_url ~ ('/album/' || r."spotifyAlbumId" || '([/?#]|$)')
            or exists (select 1 from provider_reference ref where ref.media_item_id = am.id
              and ref.external_id = r."spotifyAlbumId"
              and (ref.reference_type = 'spotify' or (ref.provider = 'spotify' and ref.reference_type = 'album')))
          ) as same_album_id
        from media_item mi
        join library_track lt on lt.media_item_id = mi.id
        join track t on t.track_media_item_id = lt.media_item_id
        join media_item am on am.id = t.album_media_item_id
        join album al on al.media_item_id = t.album_media_item_id
        where mi.media_type = 'track' and mi.metadata->>'legacyHidden' is distinct from 'true'
          and lower(mi.title) = lower(r.title)
          and lt.spotify_track_id is null
          and not exists (select 1 from track other
            where other.album_media_item_id = t.album_media_item_id and other.position <> t.position
              and lower(regexp_replace(trim(other.title), '[[:space:]]+', ' ', 'g'))
                = lower(regexp_replace(trim(t.title), '[[:space:]]+', ' ', 'g')))
          and exists (select 1 from media_credit c join artist a on a.id = c.artist_id
            where c.media_item_id = mi.id and c.role = 'artist'
              and lower(a.name) in (select lower(unnest(r.artists))))
      ) possible on existing.media_item_id is null`)
    ).rows,
  )
  const ids = new Map<string, string>()
  const names = new Map(
    tracks.map((track) => [
      track.spotifyTrackId,
      track.albumName ? baseTitleKey(track.albumName) : null,
    ]),
  )
  const choices = new Map<string, Set<string>>()
  const direct = new Map<string, Set<string>>()
  for (const row of candidates) {
    if (row.existing_id) ids.set(row.spotify_track_id, row.existing_id)
    if (!row.album_recording_id) continue
    const options = row.same_album_id
      ? direct
      : !row.known_album_id &&
          row.album_title &&
          names.get(row.spotify_track_id) === baseTitleKey(row.album_title)
        ? choices
        : null
    if (!options) continue
    const recordings = options.get(row.spotify_track_id) ?? new Set<string>()
    recordings.add(row.album_recording_id)
    options.set(row.spotify_track_id, recordings)
  }
  const possibleIds = new Map<string, string[]>()
  for (const [spotifyId, options] of new Map([...choices, ...direct])) {
    const [recording] = options
    if (!recording || options.size !== 1) continue
    const matches = possibleIds.get(recording) ?? []
    if (!matches.includes(spotifyId)) matches.push(spotifyId)
    possibleIds.set(recording, matches)
  }
  for (const [recording, candidates] of possibleIds) {
    const [spotifyId, other] = candidates
    if (choosingOneCandidate) {
      // Only one edition will be written, so alternatives can safely point to the same position.
      for (const id of candidates) ids.set(id, recording)
    } else if (spotifyId && !other) ids.set(spotifyId, recording)
  }
  return ids
}

/** The earliest manual addition, playlist-added date or first imported scrobble. */
export async function refreshTrackAddedDates(
  tx: Transaction,
  trackIds?: string[],
) {
  await tx.execute(sql`
    update library_track lt set date_added = least(m.added, manual.added_at)
    from library_track base
    left join (
      select media_item_id, min(added_at) as added from (
        select media_item_id, added_at from playlist_item
        ${trackIds ? sql`where ${inArray(playlistItem.mediaItemId, trackIds)}` : sql``}
        union all
        select l.track_media_item_id, s.listened_at
        from lastfm_track_source l join lastfm_scrobble s
          on s.username = l.username and s.artist_key = l.artist_key and s.track_key = l.track_key
        ${trackIds ? sql`where ${inArray(sql`l.track_media_item_id`, trackIds)}` : sql``}
      ) dates group by media_item_id
    ) m on m.media_item_id = base.media_item_id
    left join lateral (
      select (mi.metadata->>'spotifyTrackManualAddedAt')::timestamptz at time zone 'UTC' as added_at
      from media_item mi where mi.id = base.media_item_id
    ) manual on true
    where lt.media_item_id = base.media_item_id
      ${trackIds ? sql`and ${inArray(sql`lt.media_item_id`, trackIds)}` : sql``}
      and lt.date_added is distinct from least(m.added, manual.added_at)`)
}

/** Resolve the provider's ordered artist credits against existing library artists. */
export async function replaceSpotifyTrackCredits(
  tx: Transaction,
  batch: { id: string; artists: string[] }[],
) {
  await tx.delete(mediaCredit).where(
    and(
      inArray(
        mediaCredit.mediaItemId,
        batch.map((track) => track.id),
      ),
      eq(mediaCredit.role, 'artist'),
    ),
  )
  await writeArtistCredits(
    tx,
    batch.flatMap((track) =>
      track.artists.map((name, billingOrder) => ({
        mediaItemId: track.id,
        name,
        role: 'artist',
        billingOrder,
      })),
    ),
  )
}

async function storeImport(
  target: PlaylistTarget,
  tracks: SpotifyLibraryTrack[],
  jobId: string,
) {
  return db.transaction(async (tx) => {
    // One import writes at a time, so two cannot both judge a track orphaned.
    await lockLibraryTrackWrites(tx)
    const playlistId = await resolvePlaylist(tx, target)
    const artistCreditsSource = {
      source: target.source,
      playlistId,
      jobId,
      recordedAt: new Date().toISOString(),
    }
    const knownIds = await resolveSpotifyTrackIds(tx, tracks)
    const idForTrack = (id: string) =>
      knownIds.get(id) ?? spotifyTrackItemId(id)
    for (let start = 0; start < tracks.length; start += WRITE_BATCH) {
      const batch = tracks.slice(start, start + WRITE_BATCH)
      const confirmed = await tx
        .select({ id: mediaItem.id })
        .from(libraryTrack)
        .innerJoin(mediaItem, eq(mediaItem.id, libraryTrack.mediaItemId))
        .where(
          and(
            inArray(
              libraryTrack.spotifyTrackId,
              batch.map(({ spotifyTrackId }) => spotifyTrackId),
            ),
            sql`${mediaItem.metadata} #>> '{spotifyTrackSearch,spotifyTrackId}' = ${libraryTrack.spotifyTrackId}`,
          ),
        )
      const confirmedIds = new Set(confirmed.map(({ id }) => id))
      const preserveReviewed = inArray(mediaItem.id, [...confirmedIds])
      const items = batch.map((track): typeof mediaItem.$inferInsert => {
        const id = idForTrack(track.spotifyTrackId)
        return {
          id,
          mediaType: 'track',
          slug: slugifyParts(track.title, id),
          title: track.title,
          artworkUrl: track.artworkUrl,
          releaseDate: parseOptionalDate(track.releaseDate),
          sourceLabel: 'spotify',
          metadata: track.artistCredits.length
            ? {
                spotifyArtistCredits: track.artistCredits,
                spotifyArtistCreditsSource: artistCreditsSource,
              }
            : {},
        }
      })
      await tx
        .insert(mediaItem)
        .values(items)
        .onConflictDoUpdate({
          target: mediaItem.id,
          set: {
            title: sql`case when ${preserveReviewed} then ${mediaItem.title} else excluded.title end`,
            artworkUrl: sql`case when ${preserveReviewed} then ${mediaItem.artworkUrl} else excluded.artwork_url end`,
            sourceLabel: sql`case when ${preserveReviewed} then ${mediaItem.sourceLabel} else excluded.source_label end`,
            metadata: sql`coalesce(${mediaItem.metadata}, '{}'::jsonb) || excluded.metadata`,
            releaseDate: sql`case when ${preserveReviewed} then ${mediaItem.releaseDate} else excluded.release_date end`,
            updatedAt: new Date(),
          },
        })
      // The playlist records provider evidence and membership for all tracks.
      // A confirmed ID already has its own library metadata and display credits.
      const imports = batch.filter(
        (track) => !confirmedIds.has(idForTrack(track.spotifyTrackId)),
      )
      if (!imports.length) continue
      await tx
        .insert(libraryTrack)
        .values(
          imports.map((track) => ({
            mediaItemId: idForTrack(track.spotifyTrackId),
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
            spotifyTrackId: sql`excluded.spotify_track_id`,
            spotifyUrl: sql`excluded.spotify_url`,
            isrc: sql`excluded.isrc`,
            durationSec: sql`excluded.duration_sec`,
            albumName: sql`excluded.album_name`,
            spotifyAlbumId: sql`excluded.spotify_album_id`,
            updatedAt: new Date(),
          },
        })
      await replaceSpotifyTrackCredits(
        tx,
        imports.map((track) => ({
          id: idForTrack(track.spotifyTrackId),
          artists: track.artists,
        })),
      )
    }
    await tx.execute(sql`
      delete from playlist_item pi using library_track lt
      where pi.playlist_id = ${playlistId}
        and lt.media_item_id = pi.media_item_id`)
    for (let start = 0; start < tracks.length; start += WRITE_BATCH)
      await tx.insert(playlistItem).values(
        tracks.slice(start, start + WRITE_BATCH).map((track, index) => ({
          playlistId,
          mediaItemId: idForTrack(track.spotifyTrackId),
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
    const stored = await storeImport(
      fetched.target,
      fetched.entries,
      context.jobId,
    )
    await refreshTrackLinks(await getLastfmAccount(), 'playlist-import')
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
