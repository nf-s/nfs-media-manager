import { randomUUID } from 'node:crypto'
import { and, desc, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { ProviderRequestError } from '@repo/media-plugin-sdk'
import {
  AlbumListeningSchema,
  LASTFM_SCROBBLE_SYNC_TASK,
  LastfmLinkQuerySchema,
  LastfmLinkReasonSchema,
  LastfmLinkReportSchema,
  LastfmLinkStrategySchema,
  LastfmSyncScheduleSchema,
  type AlbumListening,
  type LastfmLinkReport,
  type LastfmLinkUpdate,
  type LastfmSyncSchedule,
  type LastfmSyncStatus,
} from '@repo/schemas/lastfm'
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
import {
  album,
  lastfmAlbumLink,
  lastfmScrobble,
  lastfmSync,
  providerSecret,
  scrapeJob,
  track,
} from '@/schemas/db'
import { linkScrobblesToAlbums } from './lastfm-album-links'
import { refreshTrackLinks } from './track-links'
import {
  getLastfmSpotifySearchJobs,
  lastfmSpotifyGroupKey,
} from './lastfm-spotify-search'
import {
  createProviderRequest,
  recordProviderFailure,
  recordProviderSuccess,
} from './provider-requests'

const PAGE_SIZE = 200
// Last.fm publishes no numeric limit but warns against several calls per second.
const PAGE_SPACING_MS = 1000
// One job stays well inside a Cloudflare Queue invocation's 15-minute limit
// and its subrequest allowance; a longer sync continues in a follow-on job.
const CHUNK_PAGES = 300
const CHUNK_BUDGET_MS = 8 * 60 * 1000
const LOG_EVERY_PAGES = 50
// Waits before repeating a page after a temporary Last.fm failure.
const RETRY_DELAYS_MS = [5000, 20000, 60000]
// Operation failed, service offline and temporarily unavailable.
const TEMPORARY_ERROR_CODES = [8, 11, 16]
const MAX_ALBUM_SOURCES = 50
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

/** The configured account identity stays server-side. */
export async function getLastfmAccount() {
  return (await credentials())?.account ?? null
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

// SQL form of `albumNameKey`.
const nameKey = (value: ReturnType<typeof sql>) =>
  sql`lower(regexp_replace(trim(${value}), '[[:space:]]+', ' ', 'g'))`

/** Recomputes the scrobble-derived album browse values, including the rolling windows. */
async function refreshAlbumListeningFields() {
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

const SCHEDULE_MINUTES: Record<LastfmSyncSchedule, number | null> = {
  off: null,
  '10m': 10,
  '30m': 30,
  '1h': 60,
  '3h': 3 * 60,
  '6h': 6 * 60,
  daily: 24 * 60,
  weekly: 7 * 24 * 60,
}

async function latestSyncJob() {
  const [job] = await db
    .select({
      id: scrapeJob.id,
      status: scrapeJob.status,
      errorMessage: scrapeJob.errorMessage,
    })
    .from(scrapeJob)
    .where(
      and(
        eq(scrapeJob.provider, 'lastfm'),
        sql`${scrapeJob.options}->>'task' = ${LASTFM_SCROBBLE_SYNC_TASK}`,
      ),
    )
    .orderBy(desc(scrapeJob.createdAt), desc(scrapeJob.id))
    .limit(1)
  return job ?? null
}

type SyncJob = Awaited<ReturnType<typeof latestSyncJob>>

// The checkpoint row records the run; the job table records who is working on it.
function syncState(
  row: SyncRow | undefined,
  job: SyncJob,
): LastfmSyncStatus['state'] {
  if (job?.status === 'queued' || job?.status === 'running') return 'running'
  if (!row || row.status === 'idle') return 'never'
  if (row.status === 'complete') return 'complete'
  // An open run without a job was cancelled, or its worker was interrupted.
  return row.status === 'failed' || job?.status === 'failed'
    ? 'failed'
    : 'stopped'
}

export async function getLastfmSyncStatus(): Promise<LastfmSyncStatus> {
  const configured = await credentials()
  if (!configured)
    return {
      configured: false,
      state: 'never',
      job: null,
      schedule: 'daily',
      nextScheduledAt: null,
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
  const job = await latestSyncJob()
  const counts = CountsSchema.parse(
    (
      await db.execute(sql`
        select count(*) as stored, count(album_media_item_id) as matched
        from lastfm_scrobble where username = ${configured.account}`)
    ).rows,
  )
  const state = syncState(row, job)
  const schedule = LastfmSyncScheduleSchema.catch('daily').parse(row?.schedule)
  const minutes = SCHEDULE_MINUTES[schedule]
  return {
    configured: true,
    state,
    job: job ? { id: job.id, status: job.status } : null,
    schedule,
    nextScheduledAt:
      state === 'complete' && row?.completedAt && minutes !== null
        ? new Date(
            row.completedAt.getTime() + minutes * 60 * 1000,
          ).toISOString()
        : null,
    pagesFetched: row ? row.nextPage - 1 : 0,
    totalPages: row?.totalPages ?? null,
    newScrobbles: row?.newScrobbles ?? 0,
    storedScrobbles: counts[0]?.stored ?? 0,
    matchedScrobbles: counts[0]?.matched ?? 0,
    startedAt:
      row && row.status !== 'idle' ? row.startedAt.toISOString() : null,
    lastCompletedAt: row?.completedAt?.toISOString() ?? null,
    errorMessage:
      state === 'failed'
        ? (row?.errorMessage ?? job?.errorMessage ?? null)
        : null,
  }
}

export async function setLastfmSyncSchedule(schedule: LastfmSyncSchedule) {
  const configured = await requireCredentials()
  const now = new Date()
  // The setting can be saved before the first sync creates a run.
  await db
    .insert(lastfmSync)
    .values({
      username: configured.account,
      status: 'idle',
      schedule,
      windowTo: Math.floor(now.getTime() / 1000),
      startedAt: now,
    })
    .onConflictDoUpdate({ target: lastfmSync.username, set: { schedule } })
  return getLastfmSyncStatus()
}

/**
 * Opens a run for a sync job to work on. A completed account gets a new fixed
 * window; an unfinished run keeps its window and page so it resumes in place.
 */
export async function prepareLastfmSyncRun(userId: string | null) {
  const { account } = await requireCredentials()
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
    if (row.status !== 'complete' && row.status !== 'idle') {
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

// Only one sync job is active at a time, so the newest job takes the run. The
// token fences a cancelled job that is still finishing a request.
async function claim(account: string, token: string) {
  const [row] = await db
    .update(lastfmSync)
    .set({ leaseToken: token, leaseUntil: null })
    .where(
      and(eq(lastfmSync.username, account), eq(lastfmSync.status, 'running')),
    )
    .returning()
  return row ?? null
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
  if ('error' in payload) {
    const code = z.object({ error: z.number().int() }).safeParse(payload)
    if (code.success && TEMPORARY_ERROR_CODES.includes(code.data.error))
      throw new ProviderRequestError(
        'Last.fm returned a temporary service error.',
        'request-failed',
      )
    throw new Error('Last.fm returned a service error.')
  }
  const page = RecentTracksSchema.parse(payload)
  const attributes = page.recenttracks['@attr']
  if (attributes.totalPages > 0 && attributes.page !== run.nextPage)
    throw new Error('Last.fm returned a different page than requested.')
  return page
}

/**
 * Repeats a page after a failed request, timeout or temporary service error.
 * Rate limits, access denials and invalid responses are not repeated.
 */
async function fetchPageWithRetry(
  request: ReturnType<typeof createProviderRequest>,
  configured: NonNullable<Awaited<ReturnType<typeof credentials>>>,
  run: SyncRow,
  context: LastfmSyncJobContext,
  retryDelaysMs: number[],
) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const page = await fetchPage(request, configured, run)
      if (attempt > 0) await recordProviderSuccess('lastfm')
      return page
    } catch (error) {
      const wait = retryDelaysMs[attempt]
      if (
        wait === undefined ||
        !(error instanceof ProviderRequestError) ||
        error.code !== 'request-failed' ||
        !(await context.isActive())
      )
        throw error
      await context.log(
        'warn',
        `Page ${run.nextPage}: ${error.message}. Retry ${attempt + 1} of ${retryDelaysMs.length} in ${Math.round(wait / 1000)} seconds.`,
      )
      await delay(wait)
    }
  }
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
      })
      .where(eq(lastfmSync.username, account))
    return run.nextPage >= totalPages ? 'fetched-all' : 'more'
  })
}

async function completeRun(account: string, token: string, run: SyncRow) {
  await linkScrobblesToAlbums(account)
  await refreshAlbumListeningFields()
  await refreshTrackLinks(account)
  await db
    .update(lastfmSync)
    .set({
      status: 'complete',
      syncedThrough: run.windowTo,
      completedAt: new Date(),
      leaseToken: null,
    })
    .where(
      and(
        eq(lastfmSync.username, account),
        eq(lastfmSync.status, 'running'),
        eq(lastfmSync.leaseToken, token),
      ),
    )
}

/** Recomputes links and browse fields from stored scrobbles; no Last.fm requests. */
export async function relinkLastfmScrobbles() {
  const configured = await credentials()
  if (configured) {
    await linkScrobblesToAlbums(configured.account)
    await refreshAlbumListeningFields()
    await refreshTrackLinks(configured.account)
  }
  return getLastfmSyncStatus()
}

/**
 * Links one scrobbled artist and album name to an album, keeps it unlinked,
 * or returns it to automatic matching. Manual choices survive later syncs.
 */
export async function setLastfmAlbumLink(input: LastfmLinkUpdate) {
  const { account } = await requireCredentials()
  const artistKey = albumNameKey(input.artistName)
  const albumKey = albumNameKey(input.albumName)
  const [scrobbled] = await db
    .select({ id: lastfmScrobble.id })
    .from(lastfmScrobble)
    .where(
      and(
        eq(lastfmScrobble.username, account),
        eq(lastfmScrobble.artistKey, artistKey),
        eq(lastfmScrobble.albumKey, albumKey),
      ),
    )
    .limit(1)
  if (!scrobbled)
    throw new ServerError({
      statusCode: 404,
      message: 'No scrobbles have this artist and album name.',
    })
  const group = and(
    eq(lastfmAlbumLink.username, account),
    eq(lastfmAlbumLink.artistKey, artistKey),
    eq(lastfmAlbumLink.albumKey, albumKey),
  )
  if (input.action === 'auto') {
    await db.delete(lastfmAlbumLink).where(group)
    await linkScrobblesToAlbums(account)
  } else {
    const albumId = input.action === 'link' ? input.albumId : null
    if (albumId !== null) {
      const [found] = await db
        .select({ id: album.mediaItemId })
        .from(album)
        .where(eq(album.mediaItemId, albumId))
      if (!found)
        throw new ServerError({ statusCode: 404, message: 'Album not found' })
    }
    const link = {
      albumMediaItemId: albumId,
      source: 'manual',
      strategy: null,
      candidateIds: [],
    }
    await db.transaction(async (tx) => {
      await tx
        .insert(lastfmAlbumLink)
        .values({ username: account, artistKey, albumKey, ...link })
        .onConflictDoUpdate({
          target: [
            lastfmAlbumLink.username,
            lastfmAlbumLink.artistKey,
            lastfmAlbumLink.albumKey,
          ],
          set: link,
        })
      await tx
        .update(lastfmScrobble)
        .set({ albumMediaItemId: albumId })
        .where(
          and(
            eq(lastfmScrobble.username, account),
            eq(lastfmScrobble.artistKey, artistKey),
            eq(lastfmScrobble.albumKey, albumKey),
          ),
        )
    })
  }
  await refreshAlbumListeningFields()
  await refreshTrackLinks(account)
  return getLastfmSyncStatus()
}

export interface LastfmSyncJobContext {
  /** Rejects once the job is cancelled or its dispatcher withdraws the slot. */
  assertActive(): Promise<void>
  isActive(): Promise<boolean>
  log(level: 'info' | 'warn', message: string): Promise<void>
}

export type LastfmSyncJobResult =
  | { outcome: 'complete' | 'continue'; message: string }
  | { outcome: 'stopped' }
  | { outcome: 'failed'; error: unknown }

type ChunkOptions = {
  maxPages?: number
  budgetMs?: number
  spacingMs?: number
  retryDelaysMs?: number[]
}

/**
 * One sync job: fetches pages from the saved checkpoint until the run
 * completes or the chunk limit is reached. `continue` asks the job system to
 * queue a follow-on job. A temporary failure repeats its page a few times; any
 * other failure, or one that persists, ends the job.
 */
export async function runLastfmSyncJob(
  context: LastfmSyncJobContext,
  options: ChunkOptions = {},
): Promise<LastfmSyncJobResult> {
  const maxPages = options.maxPages ?? CHUNK_PAGES
  const spacingMs = options.spacingMs ?? PAGE_SPACING_MS
  const retryDelaysMs = options.retryDelaysMs ?? RETRY_DELAYS_MS
  const deadline = Date.now() + (options.budgetMs ?? CHUNK_BUDGET_MS)
  const token = randomUUID()
  let account: string | null = null
  let pages = 0
  try {
    const configured = await requireCredentials()
    account = configured.account
    const request = createProviderRequest(lastfmPlugin, context.assertActive)
    for (;;) {
      if (!(await context.isActive())) return { outcome: 'stopped' }
      const run = await claim(configured.account, token)
      if (!run) return { outcome: 'complete', message: 'No sync run was open.' }
      // A run interrupted after its last page only has linking left to do.
      if (run.totalPages === null || run.nextPage <= run.totalPages) {
        const page = await fetchPageWithRetry(
          request,
          configured,
          run,
          context,
          retryDelaysMs,
        )
        // A page that arrives after cancellation is discarded.
        if (!(await context.isActive())) return { outcome: 'stopped' }
        pages += 1
        const stored = await storePage(configured.account, token, run, page)
        if (stored === 'lost') return { outcome: 'stopped' }
        if (stored === 'more') {
          const total = page.recenttracks['@attr'].totalPages
          if (pages >= maxPages || Date.now() + spacingMs >= deadline) {
            await recordProviderSuccess('lastfm')
            return {
              outcome: 'continue',
              message: `Fetched through page ${run.nextPage} of ${total}. The next job continues from page ${run.nextPage + 1}.`,
            }
          }
          if (pages % LOG_EVERY_PAGES === 0)
            await context.log(
              'info',
              `Fetched page ${run.nextPage} of ${total}.`,
            )
          await delay(spacingMs)
          continue
        }
      }
      await completeRun(configured.account, token, run)
      if (pages > 0) await recordProviderSuccess('lastfm')
      const status = await getLastfmSyncStatus()
      return {
        outcome: 'complete',
        message: `Sync complete. ${status.newScrobbles} new scrobbles; ${status.matchedScrobbles} of ${status.storedScrobbles} stored scrobbles are linked to albums.`,
      }
    }
  } catch (error) {
    // A cancelled job's request rejects before it is sent; that is not a provider failure.
    if (!(await context.isActive())) return { outcome: 'stopped' }
    await recordProviderFailure(lastfmPlugin, error)
    if (account)
      await db
        .update(lastfmSync)
        .set({
          status: 'failed',
          errorMessage:
            error instanceof ProviderRequestError
              ? error.message
              : 'Last.fm sync failed or returned invalid data. No further requests were made.',
          leaseToken: null,
        })
        .where(
          and(
            eq(lastfmSync.username, account),
            eq(lastfmSync.leaseToken, token),
          ),
        )
    return { outcome: 'failed', error }
  }
}

const LinkAlbumRowsSchema = z.array(
  z.object({
    id: z.string(),
    slug: z.string(),
    title: z.string(),
    artists: z.array(z.string()),
  }),
)
const LinkGroupRowsSchema = z.array(
  z.object({
    artist_name: z.string(),
    album_name: z.string().nullable(),
    scrobbles: z.coerce.number(),
    last: z.coerce.number(),
    reason: LastfmLinkReasonSchema,
    album_id: z.string().nullable(),
    strategy: LastfmLinkStrategySchema.nullable().catch(null),
    candidate_ids: z.array(z.string()).nullable(),
    total: z.coerce.number(),
  }),
)
const LinkSummaryRowsSchema = z.array(
  z.object({
    reason: LastfmLinkReasonSchema,
    groups: z.coerce.number(),
    scrobbles: z.coerce.number(),
  }),
)

/** Every scrobbled artist and album name for the account with its link outcome. */
function classifiedGroups(account: string) {
  return sql`
    with groups as (
      select artist_key, album_key, max(artist_name) as artist_name,
        max(album_name) as album_name, count(*) as scrobbles,
        extract(epoch from max(listened_at))::float8 as last
      from lastfm_scrobble where username = ${account}
      group by artist_key, album_key
    ), classified as (
      select g.*, case
          when g.album_key is null then 'no-album'
          when l.source = 'manual' and l.album_media_item_id is not null then 'manual'
          when l.source = 'manual' then 'excluded'
          when l.album_media_item_id is not null then 'linked'
          when jsonb_array_length(l.candidate_ids) > 0 then 'ambiguous'
          else 'unmatched' end as reason,
        l.album_media_item_id as album_id, l.strategy, l.candidate_ids
      from groups g
      left join lastfm_album_link l on l.username = ${account}
        and l.artist_key = g.artist_key and l.album_key = g.album_key
    )`
}

export async function getLastfmLinkReport(
  input: z.input<typeof LastfmLinkQuerySchema> = {},
): Promise<LastfmLinkReport> {
  const query = LastfmLinkQuerySchema.parse(input)
  const configured = await credentials()
  if (!configured)
    return {
      summary: [],
      items: [],
      totalCount: 0,
      page: query.page,
      size: query.size,
      pageCount: 0,
    }
  const groups = classifiedGroups(configured.account)
  const summary = LinkSummaryRowsSchema.parse(
    (
      await db.execute(sql`${groups}
        select reason, count(*) as groups, sum(scrobbles) as scrobbles
        from classified group by reason order by sum(scrobbles) desc`)
    ).rows,
  )
  const pattern = `%${(query.q ?? '').replace(/[\\%_]/g, '\\$&')}%`
  const searchSortRows =
    query.sortBy === 'spotifySearch'
      ? [
          ...(await getLastfmSpotifySearchJobs(configured.account)).values(),
        ].map((search) => ({
          artist_key: search.artistKey,
          album_key: search.albumKey,
          status: search.status,
          result_count: search.resultCount,
        }))
      : []
  const sortColumns = {
    libraryAlbum: sql`case when classified.album_id is not null then (select lower(title) from media_item where id = classified.album_id) when jsonb_array_length(classified.candidate_ids) > 0 then concat(lpad(jsonb_array_length(classified.candidate_ids)::text, 12, '0'), ' possible albums') end`,
    spotifySearch: sql`(select lower(case s.status
      when 'succeeded' then case when s.result_count is null then 'No stored results' else concat(lpad(s.result_count::text, 12, '0'), ' matches') end
      when 'queued' then 'Queued' when 'running' then 'Searching...' when 'failed' then 'Failed' when 'cancelled' then 'Cancelled' end)
      from jsonb_to_recordset(${JSON.stringify(searchSortRows)}::jsonb) as s(artist_key text, album_key text, status text, result_count integer)
      where s.artist_key = classified.artist_key and s.album_key = classified.album_key)`,
    artistName: sql`lower(artist_name)`,
    albumName: sql`lower(album_name)`,
    scrobbles: sql`scrobbles`,
    lastListenedAt: sql`last`,
    reason: sql`case reason when 'linked' then 'linked' when 'manual' then 'linked manually' when 'ambiguous' then 'several albums match' when 'unmatched' then 'no matching album' when 'excluded' then 'kept unlinked' else 'scrobbled without an album' end`,
  }
  const direction = query.sortDirection === 'asc' ? sql`asc` : sql`desc`
  const rows = LinkGroupRowsSchema.parse(
    (
      await db.execute(sql`${groups}
        select artist_name, album_name, scrobbles, last, reason, album_id,
          strategy, candidate_ids, count(*) over () as total
        from classified
        where ${
          query.reason === undefined
            ? sql`true`
            : query.reason === 'unlinked'
              ? sql`reason not in ('linked', 'manual')`
              : sql`reason = ${query.reason}`
        } and ${
          query.q
            ? sql`(artist_name ilike ${pattern} or album_name ilike ${pattern})`
            : sql`true`
        }
        order by ${sortColumns[query.sortBy]} ${direction} nulls last, artist_key, album_key
        limit ${query.size} offset ${(query.page - 1) * query.size}`)
    ).rows,
  )
  const ids = [
    ...new Set(
      rows.flatMap((row) => [
        ...(row.album_id ? [row.album_id] : []),
        ...(row.reason === 'ambiguous' ? (row.candidate_ids ?? []) : []),
      ]),
    ),
  ]
  const albums = ids.length
    ? LinkAlbumRowsSchema.parse(
        (
          await db.execute(sql`
            select mi.id, mi.slug, mi.title,
              coalesce(array_agg(a.name order by c.billing_order)
                filter (where a.id is not null), '{}') as artists
            from media_item mi
            left join media_credit c on c.media_item_id = mi.id and c.role = 'artist'
            left join artist a on a.id = c.artist_id
            where mi.media_type = 'album' and mi.id in (${sql.join(
              ids.map((id) => sql`${id}`),
              sql`, `,
            )})
            group by mi.id order by mi.title, mi.id`)
        ).rows,
      )
    : []
  const searches = await getLastfmSpotifySearchJobs(
    configured.account,
    rows.flatMap((row) =>
      row.album_name === null
        ? []
        : [{ artistName: row.artist_name, albumName: row.album_name }],
    ),
  )
  const totalCount = rows[0]?.total ?? 0
  return LastfmLinkReportSchema.parse({
    summary,
    items: rows.map((row) => ({
      spotifySearch:
        row.album_name === null
          ? null
          : (searches.get(
              lastfmSpotifyGroupKey(configured.account, {
                artistName: row.artist_name,
                albumName: row.album_name,
              }),
            ) ?? null),
      artistName: row.artist_name,
      albumName: row.album_name,
      scrobbles: row.scrobbles,
      lastListenedAt: isoSeconds(row.last),
      reason: row.reason,
      album: albums.find((item) => item.id === row.album_id) ?? null,
      strategy: row.reason === 'linked' ? row.strategy : null,
      candidates:
        row.reason === 'ambiguous'
          ? albums.filter((item) => row.candidate_ids?.includes(item.id))
          : [],
    })),
    totalCount,
    page: query.page,
    size: query.size,
    pageCount: Math.ceil(totalCount / query.size),
  })
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

const SourceRowsSchema = z.array(
  z.object({
    artist_name: z.string(),
    album_name: z.string(),
    count: z.coerce.number(),
    manual: z.boolean().default(false),
  }),
)
const source = (row: z.infer<typeof SourceRowsSchema>[number]) => ({
  artistName: row.artist_name,
  albumName: row.album_name,
  count: row.count,
  manual: row.manual,
})

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
  const sources = SourceRowsSchema.parse(
    (
      await db.execute(sql`
        select max(s.artist_name) as artist_name,
          max(s.album_name) as album_name, count(*) as count,
          coalesce(bool_or(l.source = 'manual'), false) as manual
        from lastfm_scrobble s
        left join lastfm_album_link l on l.username = s.username
          and l.artist_key = s.artist_key and l.album_key = s.album_key
        where s.album_media_item_id = ${albumId} and s.album_name is not null
        group by s.artist_key, s.album_key
        order by count(*) desc, s.artist_key, s.album_key
        limit ${MAX_ALBUM_SOURCES}`)
    ).rows,
  )
  // Same title under another artist, or the same artist with a longer or
  // shorter title such as an edition suffix.
  const similar = SourceRowsSchema.parse(
    (
      await db.execute(sql`
        with target as (
          select ${nameKey(sql`title`)} as album_key from media_item
          where id = ${albumId} and media_type = 'album'
        ), credited as (
          select ${nameKey(sql`a.name`)} as artist_key
          from media_credit c join artist a on a.id = c.artist_id
          where c.media_item_id = ${albumId} and c.role = 'artist'
        )
        select max(s.artist_name) as artist_name,
          max(s.album_name) as album_name, count(*) as count
        from lastfm_scrobble s cross join target t
        where s.album_media_item_id is null and s.album_key is not null and (
          s.album_key = t.album_key
          or (s.artist_key in (select artist_key from credited) and (
            starts_with(s.album_key, t.album_key)
            or (length(s.album_key) >= 4 and starts_with(t.album_key, s.album_key))
          )))
        group by s.artist_key, s.album_key
        order by count(*) desc, s.artist_key, s.album_key limit 10`)
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
    sources: sources.map(source),
    similarUnlinked: similar.map(source),
  })
}
