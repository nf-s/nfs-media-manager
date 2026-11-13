import { randomUUID } from 'node:crypto'
import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import {
  ProviderRequestError,
  isProviderItemNotFoundError,
} from '@repo/media-plugin-sdk'
import type {
  SubscriptionSyncSchedule,
  SubscriptionSyncStatus,
} from '@repo/schemas/subscriptions'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import {
  SPOTIFY_PODCAST_PAGE_SIZE,
  SpotifyEpisodesPageSchema,
  SpotifySavedShowsPageSchema,
  normalizeSpotifyEpisode,
  normalizeSpotifyShow,
  spotifyJson,
  type SpotifyEpisode,
  type SpotifyRequest,
  type SpotifyShow,
} from '@/lib/spotify-api'
import { spotifyPlugin } from '@/plugins/builtin/spotify'
import {
  subscriptionItem,
  subscriptionSource,
  subscriptionSync,
} from '@/schemas/db'
import type {
  LastfmSyncJobContext,
  LastfmSyncJobResult,
} from './lastfm-scrobbles'
import {
  createProviderRequest,
  recordProviderFailure,
  recordProviderSuccess,
} from './provider-requests'
import { getSpotifyAccountStatus, spotifyAccountToken } from './spotify-oauth'
import { subscriptionSearchVector } from './subscription-library'
import {
  dueSubscriptionSyncUsers,
  readSubscriptionSyncStatus,
  saveSubscriptionSyncSchedule,
  subscriptionSyncRun,
} from './subscription-sync-state'

// The same limits as the YouTube sync: one job stays well inside a Cloudflare
// Queue invocation; a longer sync continues in a follow-on job.
const CHUNK_STEPS = 300
const CHUNK_BUDGET_MS = 8 * 60 * 1000
const LOG_EVERY_SHOWS = 25
const TOKEN_REUSE_MS = 60 * 1000
// When a rate limit carries no retry time.
const DEFAULT_PAUSE_MS = 60 * 60 * 1000

type SyncRow = typeof subscriptionSync.$inferSelect

// Sources, items and checkpoints of this provider; YouTube rows share the
// tables and are never read or changed here.
const SPOTIFY = 'spotify'
const spotifyRun = (userId: string) => subscriptionSyncRun(userId, SPOTIFY)

// Podcasts the run's own listing returned; a run always has an ID.
const listedInRun = (run: SyncRow) =>
  run.runId === null ? sql`false` : eq(subscriptionSource.seenRunId, run.runId)

// The next offset is kept in `page_token` as a decimal string.
const OffsetSchema = z.coerce.number().int().nonnegative()
const pageOffset = (run: SyncRow) => OffsetSchema.parse(run.pageToken ?? 0)

/** The podcast sync state in the shape every subscription provider shares. */
export async function getSpotifyPodcastSyncStatus(
  userId: string,
): Promise<SubscriptionSyncStatus> {
  const account = await getSpotifyAccountStatus(userId)
  return readSubscriptionSyncStatus(SPOTIFY, userId, {
    configured: account.configured,
    connected: account.connected,
    redirectUri: account.redirectUri,
  })
}

export async function setSpotifyPodcastSyncSchedule(
  userId: string,
  schedule: SubscriptionSyncSchedule,
) {
  await saveSubscriptionSyncSchedule(SPOTIFY, userId, schedule)
  return getSpotifyPodcastSyncStatus(userId)
}

/**
 * Opens a run for a sync job to work on. A completed account gets a new run;
 * an unfinished or paused run keeps its checkpoint so it resumes in place.
 */
export async function prepareSpotifyPodcastSyncRun(userId: string | null) {
  const account = userId === null ? null : await getSpotifyAccountStatus(userId)
  if (userId === null || !account?.configured)
    throw new ServerError({
      statusCode: 422,
      message:
        'Spotify is not configured. Configure and connect the account first.',
    })
  if (!account.connected)
    throw new ServerError({
      statusCode: 422,
      message: 'Connect a Spotify account before syncing podcasts.',
    })
  const fresh = {
    status: 'running',
    runId: nanoid(),
    phase: 'sources',
    pageToken: null,
    sourceCursor: null,
    sourcesDone: 0,
    sourcesTotal: 0,
    newItems: 0,
    resumeAfter: null,
    errorMessage: null,
    startedAt: new Date(),
  }
  await db.transaction(async (tx) => {
    await tx
      .insert(subscriptionSync)
      .values({ userId, provider: SPOTIFY, ...fresh })
      .onConflictDoNothing()
    const [row] = await tx
      .select()
      .from(subscriptionSync)
      .where(spotifyRun(userId))
      .for('update')
    if (!row || row.status === 'running') return
    await tx
      .update(subscriptionSync)
      .set(
        row.status === 'complete' || row.status === 'idle'
          ? fresh
          : { status: 'running', resumeAfter: null, errorMessage: null },
      )
      .where(spotifyRun(userId))
  })
}

// Only one sync job is active at a time, so the newest job takes the run. The
// token fences a cancelled job that is still finishing a request.
async function claim(token: string) {
  const [open] = await db
    .select({ userId: subscriptionSync.userId })
    .from(subscriptionSync)
    .where(
      and(
        eq(subscriptionSync.provider, SPOTIFY),
        eq(subscriptionSync.status, 'running'),
      ),
    )
    .orderBy(asc(subscriptionSync.startedAt), asc(subscriptionSync.userId))
    .limit(1)
  if (!open) return null
  const [row] = await db
    .update(subscriptionSync)
    .set({ leaseToken: token })
    .where(and(spotifyRun(open.userId), eq(subscriptionSync.status, 'running')))
    .returning()
  return row ?? null
}

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

/** Locks the run and confirms this job still owns the step it fetched. */
async function ownedRun(tx: Transaction, token: string, run: SyncRow) {
  const [current] = await tx
    .select()
    .from(subscriptionSync)
    .where(spotifyRun(run.userId))
    .for('update')
  return current &&
    current.status === 'running' &&
    current.leaseToken === token &&
    current.runId === run.runId &&
    current.phase === run.phase &&
    current.pageToken === run.pageToken &&
    current.sourceCursor === run.sourceCursor
    ? current
    : null
}

/**
 * A listing that changed while it was read fails the run. The checkpoint goes
 * back to the first page, so resuming reads the whole list again.
 */
async function restartListing(token: string, run: SyncRow) {
  await db.transaction(async (tx) => {
    if (!(await ownedRun(tx, token, run))) return
    await tx
      .update(subscriptionSync)
      .set({ pageToken: null, sourcesTotal: 0 })
      .where(spotifyRun(run.userId))
  })
  return new ServerError({
    statusCode: 409,
    message:
      'The saved podcasts changed while they were read. Resume the sync to read the list from the start.',
  })
}

/**
 * Reads one page of the saved podcasts. After the last page, podcasts the
 * account no longer saves stop being subscribed.
 */
async function syncShowsPage(
  request: SpotifyRequest,
  accessToken: string,
  token: string,
  run: SyncRow,
  context: LastfmSyncJobContext,
) {
  const offset = pageOffset(run)
  const page = SpotifySavedShowsPageSchema.parse(
    await spotifyJson(request, accessToken, 'me/shows', {
      limit: String(SPOTIFY_PODCAST_PAGE_SIZE),
      offset: String(offset),
    }),
  )
  // A page that arrives after cancellation is discarded.
  if (!(await context.isActive())) return 'lost'
  // The first page records the total; later pages must agree with it.
  if (page.offset !== offset || (offset > 0 && page.total !== run.sourcesTotal))
    throw await restartListing(token, run)
  const shows = new Map<string, SpotifyShow>()
  for (const entry of page.items) {
    const show = normalizeSpotifyShow(entry)
    if (show && !shows.has(show.id)) shows.set(show.id, show)
  }
  const rows = [...shows.values()].map((show) => ({
    ...show,
    type: SPOTIFY,
    subscribed: true,
    seenRunId: run.runId,
  }))
  const next = offset + page.items.length
  return db.transaction(async (tx) => {
    if (!(await ownedRun(tx, token, run))) return 'lost'
    if (rows.length) {
      const renamed = (
        await tx
          .select({
            id: subscriptionSource.id,
            title: subscriptionSource.title,
          })
          .from(subscriptionSource)
          .where(inArray(subscriptionSource.id, [...shows.keys()]))
      ).flatMap((existing) => {
        const show = shows.get(existing.id)
        return show && show.title !== existing.title ? [show] : []
      })
      await tx
        .insert(subscriptionSource)
        .values(rows)
        .onConflictDoUpdate({
          target: subscriptionSource.id,
          set: {
            title: sql`excluded.title`,
            description: sql`excluded.description`,
            thumbnailUrl: sql`excluded.thumbnail_url`,
            itemTotal: sql`excluded.item_total`,
            subscribed: true,
            seenRunId: run.runId,
            updatedAt: new Date(),
          },
        })
      // The podcast name is part of each episode's search text.
      for (const show of renamed)
        await tx
          .update(subscriptionItem)
          .set({
            search: subscriptionSearchVector(
              sql`${subscriptionItem.title}`,
              sql`${show.title}::text`,
              sql`''::text`,
              sql`${subscriptionItem.description}`,
            ),
          })
          .where(eq(subscriptionItem.sourceId, show.id))
    }
    if (page.next !== null && page.items.length && next < page.total) {
      await tx
        .update(subscriptionSync)
        .set({ pageToken: String(next), sourcesTotal: page.total })
        .where(spotifyRun(run.userId))
      return 'more'
    }
    await tx
      .update(subscriptionSource)
      .set({ subscribed: false })
      .where(
        and(
          eq(subscriptionSource.type, SPOTIFY),
          eq(subscriptionSource.subscribed, true),
          sql`${subscriptionSource.seenRunId} is distinct from ${run.runId}`,
        ),
      )
    const total = await tx.$count(
      subscriptionSource,
      and(
        eq(subscriptionSource.type, SPOTIFY),
        eq(subscriptionSource.subscribed, true),
        listedInRun(run),
      ),
    )
    await tx
      .update(subscriptionSync)
      .set({
        phase: 'items',
        pageToken: null,
        sourceCursor: null,
        sourcesDone: 0,
        sourcesTotal: total,
      })
      .where(spotifyRun(run.userId))
    return 'more'
  })
}

function episodeRows(
  show: { id: string; title: string },
  episodes: SpotifyEpisode[],
) {
  return episodes.map((episode) => ({
    ...episode,
    sourceId: show.id,
    type: SPOTIFY,
    tags: [],
    live: 'none',
    search: subscriptionSearchVector(
      sql`${episode.title}::text`,
      sql`${show.title}::text`,
      sql`''::text`,
      sql`${episode.description}::text`,
    ),
  }))
}

/** Every release date is on or before the one listed above it. */
const newestFirst = (episodes: SpotifyEpisode[]) =>
  episodes.every(
    (episode, index) =>
      index === 0 ||
      episode.publishedAt.getTime() <=
        (episodes[index - 1]?.publishedAt.getTime() ?? 0),
  )

const StoredCountSchema = z.coerce.number().int().nonnegative()

/**
 * The saved podcasts of this run after the cursor, in ID order, with how many
 * of their episodes are stored. Only podcasts this run's listing returned are
 * read, so a podcast the account no longer saves is never requested.
 */
async function remainingShows(run: SyncRow) {
  const rows = await db
    .select({
      id: subscriptionSource.id,
      title: subscriptionSource.title,
      historyComplete: subscriptionSource.historyComplete,
      itemTotal: subscriptionSource.itemTotal,
      // A single-table select names columns without their table, so the
      // correlated subquery names both tables itself.
      stored: sql<unknown>`(select count(*) from subscription_item i
        where i.source_id = ${subscriptionSource}.id)`,
    })
    .from(subscriptionSource)
    .where(
      and(
        eq(subscriptionSource.type, SPOTIFY),
        eq(subscriptionSource.subscribed, true),
        listedInRun(run),
        run.sourceCursor === null
          ? undefined
          : gt(subscriptionSource.id, run.sourceCursor),
      ),
    )
    .orderBy(asc(subscriptionSource.id))
  return rows.map((row) => ({
    ...row,
    stored: StoredCountSchema.parse(row.stored),
  }))
}

/**
 * Moves past every podcast whose history is stored and whose episode count
 * matches Spotify's total, without a request, then reads one page of the next
 * podcast's episodes. A podcast whose history is already stored stops at the
 * first page that holds a known episode, unless that page is not newest first.
 */
async function syncEpisodesPage(
  request: SpotifyRequest,
  accessToken: string,
  token: string,
  run: SyncRow,
  context: LastfmSyncJobContext,
) {
  const shows = await remainingShows(run)
  const unchanged = shows.findIndex(
    (show) => !show.historyComplete || show.stored !== show.itemTotal,
  )
  const skipped = unchanged === -1 ? shows.length : unchanged
  const last = shows[skipped - 1]
  if (last && run.pageToken === null)
    return db.transaction(async (tx) => {
      const current = await ownedRun(tx, token, run)
      if (!current) return 'lost'
      await tx
        .update(subscriptionSync)
        .set({
          sourceCursor: last.id,
          sourcesDone: current.sourcesDone + skipped,
        })
        .where(spotifyRun(run.userId))
      return 'skipped'
    })
  const show = shows[0]
  if (!show) return 'fetched-all'
  const offset = pageOffset(run)
  let page: z.infer<typeof SpotifyEpisodesPageSchema> | null
  try {
    page = SpotifyEpisodesPageSchema.parse(
      await spotifyJson(
        request,
        accessToken,
        `shows/${show.id}/episodes`,
        { limit: String(SPOTIFY_PODCAST_PAGE_SIZE), offset: String(offset) },
        { notFoundOn404: true },
      ),
    )
  } catch (error) {
    // A podcast Spotify has removed is skipped; its stored episodes are kept.
    if (!isProviderItemNotFoundError(error)) throw error
    page = null
  }
  if (!(await context.isActive())) return 'lost'
  if (page && page.offset !== offset)
    throw new Error('Spotify returned an episode page out of order.')
  const episodes = new Map<string, SpotifyEpisode>()
  for (const item of page?.items ?? []) {
    if (!item || episodes.has(item.id)) continue
    episodes.set(item.id, normalizeSpotifyEpisode(item))
  }
  const listed = [...episodes.values()]
  const rows = episodeRows(show, listed)
  const ids = [...episodes.keys()]
  return db.transaction(async (tx) => {
    const current = await ownedRun(tx, token, run)
    if (!current) return 'lost'
    const known = ids.length
      ? await tx
          .select({ id: subscriptionItem.id })
          .from(subscriptionItem)
          .where(inArray(subscriptionItem.id, ids))
      : []
    if (rows.length)
      await tx
        .insert(subscriptionItem)
        .values(rows)
        .onConflictDoUpdate({
          target: subscriptionItem.id,
          set: {
            title: sql`excluded.title`,
            description: sql`excluded.description`,
            publishedAt: sql`excluded.published_at`,
            publishedPrecision: sql`excluded.published_precision`,
            durationSec: sql`excluded.duration_sec`,
            artworkUrl: sql`excluded.artwork_url`,
            search: sql`excluded.search`,
            updatedAt: new Date(),
          },
        })
    const added = rows.filter(
      (row) => !known.some((item) => item.id === row.id),
    ).length
    const next = page ? offset + page.items.length : null
    const more =
      page !== null &&
      next !== null &&
      page.next !== null &&
      page.items.length > 0 &&
      next < page.total
    const stop = show.historyComplete && known.length > 0 && newestFirst(listed)
    if (more && !stop) {
      await tx
        .update(subscriptionSync)
        .set({ pageToken: String(next), newItems: current.newItems + added })
        .where(spotifyRun(run.userId))
      return 'more'
    }
    if (page && !more && !show.historyComplete)
      await tx
        .update(subscriptionSource)
        .set({ historyComplete: true })
        .where(eq(subscriptionSource.id, show.id))
    await tx
      .update(subscriptionSync)
      .set({
        pageToken: null,
        sourceCursor: show.id,
        sourcesDone: current.sourcesDone + 1,
        newItems: current.newItems + added,
      })
      .where(spotifyRun(run.userId))
    return 'show-done'
  })
}

type ChunkOptions = { maxSteps?: number; budgetMs?: number }

/**
 * One sync job: reads pages from the saved checkpoint until the run completes
 * or the chunk limit is reached. `continue` asks the job system to queue a
 * follow-on job. A rate limit or cooldown pauses the run for the schedule to
 * resume; any other failure ends the job.
 */
export async function runSpotifyPodcastSyncJob(
  context: LastfmSyncJobContext,
  options: ChunkOptions = {},
): Promise<LastfmSyncJobResult> {
  const maxSteps = options.maxSteps ?? CHUNK_STEPS
  const deadline = Date.now() + (options.budgetMs ?? CHUNK_BUDGET_MS)
  const token = randomUUID()
  const owned = and(
    eq(subscriptionSync.provider, SPOTIFY),
    eq(subscriptionSync.status, 'running'),
    eq(subscriptionSync.leaseToken, token),
  )
  let access: { userId: string; token: string; readAt: number } | null = null
  let steps = 0
  try {
    const request = createProviderRequest(spotifyPlugin, context.assertActive)
    for (;;) {
      if (!(await context.isActive())) return { outcome: 'stopped' }
      const run = await claim(token)
      if (!run) return { outcome: 'complete', message: 'No sync run was open.' }
      if (
        !access ||
        access.userId !== run.userId ||
        Date.now() - access.readAt > TOKEN_REUSE_MS
      )
        access = {
          userId: run.userId,
          token: await spotifyAccountToken(run.userId, request),
          readAt: Date.now(),
        }
      const step =
        run.phase === 'items'
          ? await syncEpisodesPage(request, access.token, token, run, context)
          : await syncShowsPage(request, access.token, token, run, context)
      if (step === 'lost') return { outcome: 'stopped' }
      if (step === 'fetched-all') {
        await db
          .update(subscriptionSync)
          .set({
            status: 'complete',
            completedAt: new Date(),
            pageToken: null,
            leaseToken: null,
          })
          .where(owned)
        await recordProviderSuccess(SPOTIFY)
        const status = await getSpotifyPodcastSyncStatus(run.userId)
        return {
          outcome: 'complete',
          message: `Sync complete. ${status.newItems} new episodes; ${status.storedItems} episodes from ${status.storedSources} saved podcasts are stored.`,
        }
      }
      steps += 1
      const done = run.sourcesDone + 1
      if (step === 'show-done' && done % LOG_EVERY_SHOWS === 0)
        await context.log(
          'info',
          `Read ${done} of ${run.sourcesTotal} podcasts.`,
        )
      if (steps >= maxSteps || Date.now() >= deadline) {
        await recordProviderSuccess(SPOTIFY)
        return {
          outcome: 'continue',
          message:
            run.phase === 'items'
              ? `Read ${step === 'show-done' ? done : run.sourcesDone} of ${run.sourcesTotal} podcasts. The next job continues.`
              : 'Reading the saved podcasts. The next job continues.',
        }
      }
    }
  } catch (error) {
    // A cancelled job's request rejects before it is sent; that is not a provider failure.
    if (!(await context.isActive())) return { outcome: 'stopped' }
    if (
      error instanceof ProviderRequestError &&
      (error.code === 'rate-limit' || error.code === 'cooldown')
    ) {
      const resumeAfter = new Date(
        error.retryAt ?? Date.now() + DEFAULT_PAUSE_MS,
      )
      await db
        .update(subscriptionSync)
        .set({ status: 'paused', resumeAfter, leaseToken: null })
        .where(owned)
      return {
        outcome: 'complete',
        message: `Paused: ${error.message.replace(/\.$/, '')}. Stored episodes are kept; the schedule resumes the sync after ${resumeAfter.toISOString()}.`,
      }
    }
    // A missing or rejected sign-in is the account's state, not a provider fault.
    if (!(error instanceof ServerError))
      await recordProviderFailure(spotifyPlugin, error)
    await db
      .update(subscriptionSync)
      .set({
        status: 'failed',
        errorMessage:
          error instanceof ProviderRequestError || error instanceof ServerError
            ? error.message
            : 'Spotify podcast sync failed or returned invalid data. No further requests were made.',
        leaseToken: null,
      })
      .where(owned)
    return { outcome: 'failed', error }
  }
}

/** Accounts whose schedule is due, or whose rate-limit pause has passed. */
export function dueSpotifyPodcastSyncUsers(now: number): Promise<string[]> {
  return dueSubscriptionSyncUsers(SPOTIFY, now, getSpotifyPodcastSyncStatus)
}
