import { randomUUID } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { ProviderRequestError } from '@repo/media-plugin-sdk'
import {
  AlbumListeningSchema,
  LastfmSyncStatusSchema,
  type AlbumListening,
  type LastfmSyncStatus,
} from '@repo/schemas/lastfm'
import { env } from '@/env'
import { albumNameKey } from '@/lib/album-import-candidates'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import { createStableId } from '@/lib/media-utils'
import { resolveProviderSecrets } from '@/lib/provider-secrets'
import {
  AlbumCountSchema,
  albumNameMatches,
  requestAlbumJson,
} from '@/plugins/builtin/album-provider-helpers'
import { lastFmErrorCode, lastfmPlugin } from '@/plugins/builtin/lastfm'
import { lastfmScrobble, lastfmSync, providerSecret, track } from '@/schemas/db'
import {
  createProviderRequest,
  recordProviderFailure,
  recordProviderSuccess,
} from './provider-requests'

const PAGE_SIZE = 200
// Last.fm publishes no numeric limit but warns against several calls per second.
const PAGE_SPACING_MS = 1000
const LEASE_MS = 90_000
const STEP_BUDGET_MS = 20_000
// Offline scrobbles can arrive later with older timestamps.
const OVERLAP_SECONDS = 7 * 24 * 60 * 60
// Earlier timestamps come from devices with an unset clock.
const EARLIEST_UTS = Date.UTC(2002, 0, 1) / 1000
const USER_AGENT = 'media-manager-lastfm-sync/1.0'

const NamedSchema = z.object({
  '#text': z.string(),
  mbid: z.string().optional(),
})
const ScrobbleSchema = z.object({
  artist: NamedSchema,
  album: NamedSchema.optional(),
  name: z.string(),
  mbid: z.string().optional(),
  date: z.object({ uts: AlbumCountSchema }).optional(),
})
const RecentTracksSchema = z.object({
  recenttracks: z.object({
    // Last.fm returns a bare object when a page holds one track.
    track: z.union([z.array(ScrobbleSchema), ScrobbleSchema]).optional(),
    '@attr': z.object({
      page: AlbumCountSchema,
      totalPages: AlbumCountSchema,
    }),
  }),
})

type SyncRow = typeof lastfmSync.$inferSelect
type StepOptions = { budgetMs?: number; spacingMs?: number }

const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms))

const optional = (value: string | undefined) => value?.trim() || null

async function credentials() {
  const rows = await db
    .select()
    .from(providerSecret)
    .where(eq(providerSecret.provider, 'lastfm'))
  const secrets = resolveProviderSecrets(
    'lastfm',
    rows,
    lastfmPlugin.manifest.secrets,
  )
  const apiKey = secrets['apiKey']?.trim()
  const username = secrets['username']?.trim()
  return apiKey && username
    ? { secrets, username, account: username.toLowerCase() }
    : null
}

async function requireCredentials() {
  const configured = await credentials()
  if (!configured)
    throw new ServerError({
      statusCode: 422,
      message:
        'Add a Last.fm API key and username in Providers before syncing scrobbles.',
    })
  return configured
}

function scrobbleRows(
  account: string,
  page: z.infer<typeof RecentTracksSchema>,
): Array<typeof lastfmScrobble.$inferInsert> {
  const listed = page.recenttracks.track ?? []
  return (Array.isArray(listed) ? listed : [listed]).flatMap((item) => {
    // The now-playing entry has no date and repeats on every page.
    if (!item.date || item.date.uts < EARLIEST_UTS) return []
    const artistName = item.artist['#text'].trim()
    const trackName = item.name.trim()
    if (!artistName || !trackName) return []
    const albumName = optional(item.album?.['#text'])
    return [
      {
        // Last.fm exposes no scrobble ID; identical same-second repeats collapse.
        id: createStableId(
          'scrobble',
          JSON.stringify([
            account,
            item.date.uts,
            artistName,
            trackName,
            albumName,
          ]),
        ),
        username: account,
        listenedAt: new Date(item.date.uts * 1000),
        artistName,
        albumName,
        trackName,
        artistKey: albumNameKey(artistName),
        albumKey: albumName ? albumNameKey(albumName) : null,
        trackKey: albumNameKey(trackName),
        artistMbid: optional(item.artist.mbid),
        albumMbid: optional(item.album?.mbid),
        trackMbid: optional(item.mbid),
      },
    ]
  })
}

/** Links scrobbles to the one album whose title and a credited artist match by name. */
export async function linkScrobblesToAlbums() {
  const key = (value: ReturnType<typeof sql>) =>
    sql`lower(regexp_replace(trim(${value}), '[[:space:]]+', ' ', 'g'))`
  await db.execute(sql`
    with album_keys as (
      select mi.id, ${key(sql`mi.title`)} as album_key, ${key(sql`a.name`)} as artist_key
      from media_item mi
      join media_credit c on c.media_item_id = mi.id and c.role = 'artist'
      join artist a on a.id = c.artist_id
      where mi.media_type = 'album'
    ), unambiguous as (
      select album_key, artist_key, min(id) as id
      from album_keys group by album_key, artist_key having count(distinct id) = 1
    )
    update lastfm_scrobble s set album_media_item_id = u.id
    from unambiguous u
    where s.album_key = u.album_key and s.artist_key = u.artist_key
      and s.album_media_item_id is distinct from u.id`)
}

/** Recomputes the scrobble-derived album browse values, including the rolling windows. */
export async function refreshAlbumListeningFields() {
  await db.execute(sql`
    update media_item m set metadata = jsonb_set(
      coalesce(m.metadata, '{}'::jsonb), '{browse}',
      coalesce(m.metadata->'browse', '{}'::jsonb) || s.stats)
    from (
      select album_media_item_id as id, jsonb_build_object(
        'scrobbles', count(*),
        'lastListenedAt', floor(extract(epoch from max(listened_at)) * 1000),
        'scrobblesLast1y', count(*) filter (where listened_at >= (now() at time zone 'utc') - interval '1 year'),
        'scrobblesLast5y', count(*) filter (where listened_at >= (now() at time zone 'utc') - interval '5 years')
      ) as stats
      from lastfm_scrobble where album_media_item_id is not null
      group by album_media_item_id
    ) s
    where m.id = s.id
      and not (coalesce(m.metadata->'browse', '{}'::jsonb) @> s.stats)`)
  await db.execute(sql`
    update media_item m set metadata = jsonb_set(
      m.metadata, '{browse}',
      (m.metadata->'browse') - 'lastListenedAt' - 'scrobblesLast1y' - 'scrobblesLast5y')
    where m.media_type = 'album'
      and m.metadata->'browse' ? 'lastListenedAt'
      and not exists (
        select 1 from lastfm_scrobble s where s.album_media_item_id = m.id)`)
}

const CountsSchema = z
  .array(z.object({ stored: z.coerce.number(), matched: z.coerce.number() }))
  .length(1)

function syncState(row: SyncRow | undefined): LastfmSyncStatus['state'] {
  if (!row) return 'never'
  return LastfmSyncStatusSchema.shape.state.parse(row.status)
}

export async function getLastfmSyncStatus(): Promise<LastfmSyncStatus> {
  const configured = await credentials()
  if (!configured)
    return {
      configured: false,
      state: 'never',
      pagesFetched: 0,
      totalPages: null,
      newScrobbles: 0,
      storedScrobbles: 0,
      matchedScrobbles: 0,
      startedAt: null,
      lastCompletedAt: null,
      errorMessage: null,
    }
  const [row] = await db
    .select()
    .from(lastfmSync)
    .where(eq(lastfmSync.username, configured.account))
  const counts = CountsSchema.parse(
    (
      await db.execute(sql`
        select count(*) as stored, count(album_media_item_id) as matched
        from lastfm_scrobble where username = ${configured.account}`)
    ).rows,
  )
  return {
    configured: true,
    state: syncState(row),
    pagesFetched: row ? row.nextPage - 1 : 0,
    totalPages: row?.totalPages ?? null,
    newScrobbles: row?.newScrobbles ?? 0,
    storedScrobbles: counts[0]?.stored ?? 0,
    matchedScrobbles: counts[0]?.matched ?? 0,
    startedAt: row?.startedAt.toISOString() ?? null,
    lastCompletedAt: row?.completedAt?.toISOString() ?? null,
    errorMessage: row?.errorMessage ?? null,
  }
}

async function beginRun(account: string, userId: string | null) {
  const now = new Date()
  await db.transaction(async (tx) => {
    await tx
      .insert(lastfmSync)
      .values({
        username: account,
        status: 'running',
        windowTo: Math.floor(now.getTime() / 1000),
        startedAt: now,
        requestedByUserId: userId,
      })
      .onConflictDoNothing()
    const [row] = await tx
      .select()
      .from(lastfmSync)
      .where(eq(lastfmSync.username, account))
      .for('update')
    if (!row || row.status === 'running') return
    // A failed or stopped run keeps its window and page so it resumes in place.
    if (row.status !== 'complete') {
      await tx
        .update(lastfmSync)
        .set({ status: 'running', errorMessage: null })
        .where(eq(lastfmSync.username, account))
      return
    }
    await tx
      .update(lastfmSync)
      .set({
        status: 'running',
        windowFrom:
          row.syncedThrough === null
            ? null
            : Math.max(0, row.syncedThrough - OVERLAP_SECONDS),
        windowTo: Math.floor(now.getTime() / 1000),
        nextPage: 1,
        totalPages: null,
        newScrobbles: 0,
        errorMessage: null,
        startedAt: now,
        requestedByUserId: userId,
      })
      .where(eq(lastfmSync.username, account))
  })
}

let driving = false

/** Node has no queue or cron, so one in-process loop carries a run to its end. */
async function driveLastfmSync() {
  if (driving) return
  driving = true
  try {
    let status = await runLastfmSyncStep()
    while (status.state === 'running') {
      // Also paces the loop while another driver holds the lease.
      await delay(PAGE_SPACING_MS)
      status = await runLastfmSyncStep()
    }
  } catch {
    // The step records its own failure; the status endpoint reports it.
  } finally {
    driving = false
  }
}

export async function startLastfmSync(userId: string | null) {
  const configured = await requireCredentials()
  await beginRun(configured.account, userId)
  if (env.RUNTIME_KIND === 'node') void driveLastfmSync()
  return getLastfmSyncStatus()
}

export async function stopLastfmSync() {
  const configured = await credentials()
  if (configured)
    await db
      .update(lastfmSync)
      .set({ status: 'stopped', leaseToken: null, leaseUntil: null })
      .where(
        and(
          eq(lastfmSync.username, configured.account),
          eq(lastfmSync.status, 'running'),
        ),
      )
  return getLastfmSyncStatus()
}

async function claim(account: string, token: string) {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(lastfmSync)
      .where(eq(lastfmSync.username, account))
      .for('update')
    if (!row || row.status !== 'running') return null
    if (
      row.leaseToken !== token &&
      row.leaseUntil &&
      row.leaseUntil.getTime() > Date.now()
    )
      return null
    await tx
      .update(lastfmSync)
      .set({ leaseToken: token, leaseUntil: new Date(Date.now() + LEASE_MS) })
      .where(eq(lastfmSync.username, account))
    return row
  })
}

async function fetchPage(
  request: ReturnType<typeof createProviderRequest>,
  configured: NonNullable<Awaited<ReturnType<typeof credentials>>>,
  run: SyncRow,
) {
  const url = new URL('https://ws.audioscrobbler.com/2.0/')
  url.search = new URLSearchParams({
    method: 'user.getRecentTracks',
    format: 'json',
    api_key: configured.secrets['apiKey'] ?? '',
    user: configured.username,
    limit: String(PAGE_SIZE),
    page: String(run.nextPage),
    to: String(run.windowTo),
    ...(run.windowFrom === null ? {} : { from: String(run.windowFrom) }),
  }).toString()
  const payload = await requestAlbumJson(
    { request, secrets: configured.secrets },
    'Last.fm',
    url,
    { headers: { 'User-Agent': USER_AGENT } },
    lastFmErrorCode,
  )
  if ('error' in payload) throw new Error('Last.fm returned a service error.')
  const page = RecentTracksSchema.parse(payload)
  const attributes = page.recenttracks['@attr']
  if (attributes.totalPages > 0 && attributes.page !== run.nextPage)
    throw new Error('Last.fm returned a different page than requested.')
  return page
}

async function insertScrobbles(
  database: Pick<typeof db, 'insert'>,
  rows: Array<typeof lastfmScrobble.$inferInsert>,
) {
  if (!rows.length) return 0
  const inserted = await database
    .insert(lastfmScrobble)
    .values(rows)
    .onConflictDoNothing()
    .returning({ id: lastfmScrobble.id })
  return inserted.length
}

/** Stores one fetched page and advances the checkpoint in the same transaction. */
async function storePage(
  account: string,
  token: string,
  run: SyncRow,
  page: z.infer<typeof RecentTracksSchema>,
) {
  const totalPages = page.recenttracks['@attr'].totalPages
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(lastfmSync)
      .where(eq(lastfmSync.username, account))
      .for('update')
    if (
      !current ||
      current.status !== 'running' ||
      current.leaseToken !== token ||
      current.nextPage !== run.nextPage
    )
      return 'lost'
    const inserted = await insertScrobbles(tx, scrobbleRows(account, page))
    await tx
      .update(lastfmSync)
      .set({
        nextPage: run.nextPage + 1,
        totalPages,
        newScrobbles: current.newScrobbles + inserted,
        leaseUntil: new Date(Date.now() + LEASE_MS),
      })
      .where(eq(lastfmSync.username, account))
    return run.nextPage >= totalPages ? 'fetched-all' : 'more'
  })
}

async function completeRun(account: string, token: string, run: SyncRow) {
  await linkScrobblesToAlbums()
  await refreshAlbumListeningFields()
  await db
    .update(lastfmSync)
    .set({
      status: 'complete',
      syncedThrough: run.windowTo,
      completedAt: new Date(),
      leaseToken: null,
      leaseUntil: null,
    })
    .where(
      and(
        eq(lastfmSync.username, account),
        eq(lastfmSync.status, 'running'),
        eq(lastfmSync.leaseToken, token),
      ),
    )
}

/**
 * Fetches pages of the running sync until it completes, stops, or the time
 * budget ends. A failure stops the run; it is resumed only on request.
 */
export async function runLastfmSyncStep(
  options: StepOptions = {},
): Promise<LastfmSyncStatus> {
  const configured = await requireCredentials()
  const deadline = Date.now() + (options.budgetMs ?? STEP_BUDGET_MS)
  const spacingMs = options.spacingMs ?? PAGE_SPACING_MS
  const token = randomUUID()
  const request = createProviderRequest(lastfmPlugin)
  let fetched = false
  try {
    for (;;) {
      const run = await claim(configured.account, token)
      if (!run) break
      // A run interrupted after its last page only has linking left to do.
      if (run.totalPages === null || run.nextPage <= run.totalPages) {
        const page = await fetchPage(request, configured, run)
        fetched = true
        const stored = await storePage(configured.account, token, run, page)
        if (stored === 'lost') break
        if (stored === 'more') {
          if (Date.now() + spacingMs >= deadline) break
          await delay(spacingMs)
          continue
        }
      }
      await completeRun(configured.account, token, run)
      break
    }
    if (fetched) await recordProviderSuccess('lastfm')
  } catch (error) {
    await recordProviderFailure(lastfmPlugin, error)
    await db
      .update(lastfmSync)
      .set({
        status: 'failed',
        errorMessage:
          error instanceof ProviderRequestError
            ? error.message
            : 'Last.fm sync failed or returned invalid data. No further requests were made.',
        leaseToken: null,
        leaseUntil: null,
      })
      .where(
        and(
          eq(lastfmSync.username, configured.account),
          eq(lastfmSync.leaseToken, token),
        ),
      )
  }
  // Free the lease so the next step, possibly from another driver, can continue.
  await db
    .update(lastfmSync)
    .set({ leaseToken: null, leaseUntil: null })
    .where(
      and(
        eq(lastfmSync.username, configured.account),
        eq(lastfmSync.leaseToken, token),
      ),
    )
  return getLastfmSyncStatus()
}

/**
 * Cron entry point: continues a running sync, or starts an incremental one
 * when the last completed sync is at least `intervalMs` old. Never starts the
 * first sync or resumes a failed or stopped one.
 */
export async function continueScheduledLastfmSync(
  intervalMs: number,
  options: StepOptions = {},
) {
  const configured = await credentials()
  if (!configured) return
  const [row] = await db
    .select()
    .from(lastfmSync)
    .where(eq(lastfmSync.username, configured.account))
  if (!row) return
  if (
    row.status === 'complete' &&
    row.completedAt &&
    row.completedAt.getTime() <= Date.now() - intervalMs
  )
    await beginRun(configured.account, null)
  else if (row.status !== 'running') return
  await runLastfmSyncStep(options)
}

const SummarySchema = z
  .array(
    z.object({
      total: z.coerce.number(),
      first: z.coerce.number().nullable(),
      last: z.coerce.number().nullable(),
    }),
  )
  .length(1)
const MonthRowsSchema = z.array(
  z.object({ month: z.string(), count: z.coerce.number() }),
)
const TrackRowsSchema = z.array(
  z.object({
    key: z.string(),
    title: z.string(),
    count: z.coerce.number(),
    last: z.coerce.number(),
  }),
)

const isoSeconds = (value: number | null) =>
  value === null ? null : new Date(value * 1000).toISOString()

export async function getAlbumListening(
  albumId: string,
  trackKey?: string,
): Promise<AlbumListening> {
  const filter = trackKey ? sql`and track_key = ${trackKey}` : sql``
  const summary = SummarySchema.parse(
    (
      await db.execute(sql`
        select count(*) as total,
          extract(epoch from min(listened_at))::float8 as first,
          extract(epoch from max(listened_at))::float8 as last
        from lastfm_scrobble
        where album_media_item_id = ${albumId} ${filter}`)
    ).rows,
  )
  const months = MonthRowsSchema.parse(
    (
      await db.execute(sql`
        select to_char(date_trunc('month', listened_at), 'YYYY-MM') as month,
          count(*) as count
        from lastfm_scrobble
        where album_media_item_id = ${albumId} ${filter}
        group by 1 order by 1`)
    ).rows,
  )
  const scrobbled = TrackRowsSchema.parse(
    (
      await db.execute(sql`
        select track_key as key,
          (array_agg(track_name order by listened_at desc))[1] as title,
          count(*) as count,
          extract(epoch from max(listened_at))::float8 as last
        from lastfm_scrobble
        where album_media_item_id = ${albumId}
        group by track_key order by count(*) desc, track_key`)
    ).rows,
  )
  const albumTracks = await db
    .select({ title: track.title, position: track.position })
    .from(track)
    .where(eq(track.albumMediaItemId, albumId))
  return AlbumListeningSchema.parse({
    total: summary[0]?.total ?? 0,
    firstListenedAt: isoSeconds(summary[0]?.first ?? null),
    lastListenedAt: isoSeconds(summary[0]?.last ?? null),
    months,
    tracks: scrobbled.map((row) => ({
      key: row.key,
      title: row.title,
      position:
        albumTracks.find((item) => albumNameMatches(item.title, row.title))
          ?.position ?? null,
      count: row.count,
      lastListenedAt: isoSeconds(row.last),
    })),
  })
}
