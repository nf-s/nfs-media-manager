import { randomUUID } from 'node:crypto'
import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import {
  ProviderRequestError,
  isProviderItemNotFoundError,
} from '@repo/media-plugin-sdk'
import type { YoutubeSyncSchedule } from '@repo/schemas/youtube'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import {
  YOUTUBE_PAGE_SIZE,
  YoutubeChannelPageSchema,
  YoutubeSubscriptionPageSchema,
  YoutubeUploadPageSchema,
  YoutubeVideoListSchema,
  youtubeDurationSeconds,
  youtubeJson,
  youtubeThumbnail,
  type YoutubeRequest,
} from '@/lib/youtube-api'
import { youtubePlugin } from '@/plugins/builtin/youtube'
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
import { subscriptionSearchVector } from './subscription-library'
import {
  dueSubscriptionSyncUsers,
  readSubscriptionSyncStatus,
  saveSubscriptionSyncSchedule,
  subscriptionSyncRun,
} from './subscription-sync-state'
import { getYoutubeAccountStatus, youtubeAccessToken } from './youtube-oauth'

// One job stays well inside a Cloudflare Queue invocation's 15-minute limit
// and its subrequest allowance; a longer sync continues in a follow-on job.
const CHUNK_STEPS = 300
const CHUNK_BUDGET_MS = 8 * 60 * 1000
const LOG_EVERY_CHANNELS = 25
const TOKEN_REUSE_MS = 60 * 1000
// When a quota pause carries no reset time.
const DEFAULT_PAUSE_MS = 60 * 60 * 1000

type SyncRow = typeof subscriptionSync.$inferSelect
type VideoPage = z.infer<typeof YoutubeVideoListSchema>

// Sources, items and checkpoints of this provider; other providers' rows share
// the tables and are never read or changed here.
const YOUTUBE = 'youtube'
const youtubeRun = (userId: string) => subscriptionSyncRun(userId, YOUTUBE)

// PostgreSQL text cannot hold a NUL character.
const clean = (value: string) => value.replaceAll('\u0000', '')

/** The YouTube sync state in the shape every subscription provider shares. */
export async function getYoutubeSubscriptionSyncStatus(userId: string) {
  return readSubscriptionSyncStatus(
    YOUTUBE,
    userId,
    await getYoutubeAccountStatus(userId),
  )
}

export async function setYoutubeSyncSchedule(
  userId: string,
  schedule: YoutubeSyncSchedule,
) {
  await saveSubscriptionSyncSchedule(YOUTUBE, userId, schedule)
  return getYoutubeSubscriptionSyncStatus(userId)
}

/**
 * Opens a run for a sync job to work on. A completed account gets a new run;
 * an unfinished or paused run keeps its checkpoint so it resumes in place.
 */
export async function prepareYoutubeSyncRun(userId: string | null) {
  const connected =
    userId !== null && (await getYoutubeAccountStatus(userId)).connected
  if (userId === null || !connected)
    throw new ServerError({
      statusCode: 422,
      message: 'Connect a YouTube account in Subscriptions before syncing.',
    })
  const now = new Date()
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
    startedAt: now,
  }
  await db.transaction(async (tx) => {
    await tx
      .insert(subscriptionSync)
      .values({ userId, provider: YOUTUBE, ...fresh })
      .onConflictDoNothing()
    const [row] = await tx
      .select()
      .from(subscriptionSync)
      .where(youtubeRun(userId))
      .for('update')
    if (!row || row.status === 'running') return
    await tx
      .update(subscriptionSync)
      .set(
        row.status === 'complete' || row.status === 'idle'
          ? fresh
          : { status: 'running', resumeAfter: null, errorMessage: null },
      )
      .where(youtubeRun(userId))
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
        eq(subscriptionSync.provider, YOUTUBE),
        eq(subscriptionSync.status, 'running'),
      ),
    )
    .orderBy(asc(subscriptionSync.startedAt), asc(subscriptionSync.userId))
    .limit(1)
  if (!open) return null
  const [row] = await db
    .update(subscriptionSync)
    .set({ leaseToken: token })
    .where(and(youtubeRun(open.userId), eq(subscriptionSync.status, 'running')))
    .returning()
  return row ?? null
}

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

/** Locks the run and confirms this job still owns the step it fetched. */
async function ownedRun(tx: Transaction, token: string, run: SyncRow) {
  const [current] = await tx
    .select()
    .from(subscriptionSync)
    .where(youtubeRun(run.userId))
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
 * Reads one page of the subscription list with each channel's details. After
 * the last page, channels the list no longer contains stop being subscribed.
 */
async function syncSubscriptionPage(
  request: YoutubeRequest,
  accessToken: string,
  token: string,
  run: SyncRow,
  context: LastfmSyncJobContext,
) {
  const page = YoutubeSubscriptionPageSchema.parse(
    await youtubeJson(request, accessToken, 'subscriptions', {
      part: 'snippet',
      mine: 'true',
      maxResults: String(YOUTUBE_PAGE_SIZE),
      order: 'alphabetical',
      ...(run.pageToken ? { pageToken: run.pageToken } : {}),
    }),
  )
  const ids = [
    ...new Set(page.items.map((item) => item.snippet.resourceId.channelId)),
  ]
  const details = ids.length
    ? YoutubeChannelPageSchema.parse(
        await youtubeJson(request, accessToken, 'channels', {
          part: 'snippet,statistics,contentDetails',
          id: ids.join(','),
          maxResults: String(YOUTUBE_PAGE_SIZE),
        }),
      ).items
    : []
  // A page that arrives after cancellation is discarded.
  if (!(await context.isActive())) return 'lost'
  const rows = ids.flatMap((id) => {
    const listed = page.items.find(
      (item) => item.snippet.resourceId.channelId === id,
    )
    if (!listed) return []
    const detail = details.find((item) => item.id === id)
    const handle = detail?.snippet.customUrl
    return [
      {
        id,
        type: YOUTUBE,
        title: clean(detail?.snippet.title ?? listed.snippet.title),
        handle: handle?.startsWith('@') ? clean(handle) : null,
        description:
          clean(
            detail?.snippet.description ?? listed.snippet.description ?? '',
          ) || null,
        thumbnailUrl: youtubeThumbnail(
          detail?.snippet.thumbnails ?? listed.snippet.thumbnails,
        ),
        uploadsPlaylistId:
          detail?.contentDetails?.relatedPlaylists.uploads ?? null,
        subscriberCount: detail?.statistics?.hiddenSubscriberCount
          ? null
          : (detail?.statistics?.subscriberCount ?? null),
        itemTotal: detail?.statistics?.videoCount ?? null,
        subscribed: true,
        seenRunId: run.runId,
      },
    ]
  })
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
          .where(inArray(subscriptionSource.id, ids))
      ).flatMap((existing) => {
        const next = rows.find((row) => row.id === existing.id)
        return next && next.title !== existing.title ? [next] : []
      })
      await tx
        .insert(subscriptionSource)
        .values(rows)
        .onConflictDoUpdate({
          target: subscriptionSource.id,
          set: {
            title: sql`excluded.title`,
            handle: sql`excluded.handle`,
            description: sql`excluded.description`,
            thumbnailUrl: sql`excluded.thumbnail_url`,
            uploadsPlaylistId: sql`excluded.uploads_playlist_id`,
            subscriberCount: sql`excluded.subscriber_count`,
            itemTotal: sql`excluded.item_total`,
            subscribed: true,
            seenRunId: run.runId,
            updatedAt: new Date(),
          },
        })
      // The channel name is part of each video's search text.
      for (const channel of renamed)
        await tx
          .update(subscriptionItem)
          .set({
            search: subscriptionSearchVector(
              sql`${subscriptionItem.title}`,
              sql`${channel.title}::text`,
              sql`(select coalesce(string_agg(tag, ' '), '')
                from jsonb_array_elements_text(${subscriptionItem.tags}) tag)`,
              sql`${subscriptionItem.description}`,
            ),
          })
          .where(eq(subscriptionItem.sourceId, channel.id))
    }
    if (page.nextPageToken) {
      await tx
        .update(subscriptionSync)
        .set({ pageToken: page.nextPageToken })
        .where(youtubeRun(run.userId))
      return 'more'
    }
    await tx
      .update(subscriptionSource)
      .set({ subscribed: false })
      .where(
        and(
          eq(subscriptionSource.type, YOUTUBE),
          eq(subscriptionSource.subscribed, true),
          sql`${subscriptionSource.seenRunId} is distinct from ${run.runId}`,
        ),
      )
    const total = await tx.$count(
      subscriptionSource,
      and(
        eq(subscriptionSource.type, YOUTUBE),
        eq(subscriptionSource.subscribed, true),
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
      .where(youtubeRun(run.userId))
    return 'more'
  })
}

function videoRows(
  channel: { id: string; title: string },
  videos: VideoPage['items'],
) {
  return videos.map((video) => {
    const title = clean(video.snippet.title)
    const description = clean(video.snippet.description)
    const tags = video.snippet.tags.map(clean)
    return {
      id: video.id,
      sourceId: channel.id,
      type: YOUTUBE,
      title,
      description,
      tags,
      publishedAt: new Date(video.snippet.publishedAt),
      durationSec: youtubeDurationSeconds(video.contentDetails.duration),
      viewCount: video.statistics?.viewCount ?? null,
      likeCount: video.statistics?.likeCount ?? null,
      commentCount: video.statistics?.commentCount ?? null,
      live: video.snippet.liveBroadcastContent,
      search: subscriptionSearchVector(
        sql`${title}::text`,
        sql`${channel.title}::text`,
        sql`${tags.join(' ')}::text`,
        sql`${description}::text`,
      ),
    }
  })
}

const UnchangedSchema = z.boolean()

/**
 * The subscribed channels after the cursor, in ID order. A channel is
 * unchanged when its history is stored, its listed video count equals the
 * count at its last read, and no stored video was live or upcoming then: a
 * stream that ends changes its length and status but not the count.
 */
async function remainingChannels(run: SyncRow) {
  const rows = await db
    .select({
      id: subscriptionSource.id,
      title: subscriptionSource.title,
      uploadsPlaylistId: subscriptionSource.uploadsPlaylistId,
      historyComplete: subscriptionSource.historyComplete,
      itemTotal: subscriptionSource.itemTotal,
      // The stored videos are searched only when the counts match. A
      // single-table select names columns without their table, so the
      // correlated subquery names both tables itself.
      unchanged: sql<unknown>`case
        when ${subscriptionSource.historyComplete}
          and ${subscriptionSource.itemTotal} = ${subscriptionSource.readItemTotal}
        then not exists (select 1 from subscription_item i
          where i.source_id = ${subscriptionSource}.id and i.live <> 'none')
        else false end`,
    })
    .from(subscriptionSource)
    .where(
      and(
        eq(subscriptionSource.type, YOUTUBE),
        eq(subscriptionSource.subscribed, true),
        run.sourceCursor === null
          ? undefined
          : gt(subscriptionSource.id, run.sourceCursor),
      ),
    )
    .orderBy(asc(subscriptionSource.id))
  return rows.map((row) => ({
    ...row,
    unchanged: UnchangedSchema.parse(row.unchanged),
  }))
}

/**
 * Moves past every unchanged channel without a request, then reads one page
 * of the next channel's uploads, newest first, with each video's details. A
 * channel whose history is already stored stops at the first page that holds
 * a known video; otherwise every page is read.
 */
async function syncUploadsPage(
  request: YoutubeRequest,
  accessToken: string,
  token: string,
  run: SyncRow,
  context: LastfmSyncJobContext,
) {
  const channels = await remainingChannels(run)
  const changed = channels.findIndex((item) => !item.unchanged)
  const skipped = changed === -1 ? channels.length : changed
  const last = channels[skipped - 1]
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
        .where(youtubeRun(run.userId))
      return 'skipped'
    })
  const channel = channels[0]
  if (!channel) return 'fetched-all'
  let uploads: z.infer<typeof YoutubeUploadPageSchema>
  try {
    uploads = YoutubeUploadPageSchema.parse(
      await youtubeJson(
        request,
        accessToken,
        'playlistItems',
        {
          part: 'contentDetails',
          // Every channel's uploads playlist shares its ID after the prefix.
          playlistId: channel.uploadsPlaylistId ?? `UU${channel.id.slice(2)}`,
          maxResults: String(YOUTUBE_PAGE_SIZE),
          ...(run.pageToken ? { pageToken: run.pageToken } : {}),
        },
        { notFoundOn404: true },
      ),
    )
  } catch (error) {
    // A channel without public uploads has no uploads playlist.
    if (!isProviderItemNotFoundError(error)) throw error
    uploads = { items: [] }
  }
  const ids = [
    ...new Set(uploads.items.map((item) => item.contentDetails.videoId)),
  ]
  // Private and deleted videos are listed in the playlist but not returned here.
  const videos = ids.length
    ? YoutubeVideoListSchema.parse(
        await youtubeJson(request, accessToken, 'videos', {
          part: 'snippet,contentDetails,statistics',
          id: ids.join(','),
          maxResults: String(YOUTUBE_PAGE_SIZE),
        }),
      ).items
    : []
  if (!(await context.isActive())) return 'lost'
  const rows = videoRows(channel, videos)
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
            tags: sql`excluded.tags`,
            publishedAt: sql`excluded.published_at`,
            durationSec: sql`excluded.duration_sec`,
            viewCount: sql`excluded.view_count`,
            likeCount: sql`excluded.like_count`,
            commentCount: sql`excluded.comment_count`,
            live: sql`excluded.live`,
            search: sql`excluded.search`,
            updatedAt: new Date(),
          },
        })
    const added = rows.filter(
      (row) => !known.some((item) => item.id === row.id),
    ).length
    const next = uploads.nextPageToken
    if (next && (!channel.historyComplete || known.length === 0)) {
      await tx
        .update(subscriptionSync)
        .set({ pageToken: next, newItems: current.newItems + added })
        .where(youtubeRun(run.userId))
      return 'more'
    }
    // The count was listed before this read, so a video published since
    // then changes the next listing's count and the channel is read again.
    await tx
      .update(subscriptionSource)
      .set({
        historyComplete: channel.historyComplete || !next,
        readItemTotal: channel.itemTotal,
      })
      .where(eq(subscriptionSource.id, channel.id))
    await tx
      .update(subscriptionSync)
      .set({
        pageToken: null,
        sourceCursor: channel.id,
        sourcesDone: current.sourcesDone + 1,
        newItems: current.newItems + added,
      })
      .where(youtubeRun(run.userId))
    return 'channel-done'
  })
}

type ChunkOptions = { maxSteps?: number; budgetMs?: number }

/**
 * One sync job: reads pages from the saved checkpoint until the run completes
 * or the chunk limit is reached. `continue` asks the job system to queue a
 * follow-on job. Running out of the daily quota pauses the run for the
 * schedule to resume; any other failure ends the job.
 */
export async function runYoutubeSyncJob(
  context: LastfmSyncJobContext,
  options: ChunkOptions = {},
): Promise<LastfmSyncJobResult> {
  const maxSteps = options.maxSteps ?? CHUNK_STEPS
  const deadline = Date.now() + (options.budgetMs ?? CHUNK_BUDGET_MS)
  const token = randomUUID()
  const owned = and(
    eq(subscriptionSync.provider, YOUTUBE),
    eq(subscriptionSync.status, 'running'),
    eq(subscriptionSync.leaseToken, token),
  )
  let access: { userId: string; token: string; readAt: number } | null = null
  let steps = 0
  try {
    const request = createProviderRequest(youtubePlugin, context.assertActive)
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
          token: await youtubeAccessToken(run.userId, request),
          readAt: Date.now(),
        }
      const step =
        run.phase === 'items'
          ? await syncUploadsPage(request, access.token, token, run, context)
          : await syncSubscriptionPage(
              request,
              access.token,
              token,
              run,
              context,
            )
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
        await recordProviderSuccess('youtube')
        const status = await getYoutubeSubscriptionSyncStatus(run.userId)
        return {
          outcome: 'complete',
          message: `Sync complete. ${status.newItems} new videos; ${status.storedItems} videos from ${status.storedSources} subscribed channels are stored.`,
        }
      }
      steps += 1
      const done = run.sourcesDone + 1
      if (step === 'channel-done' && done % LOG_EVERY_CHANNELS === 0)
        await context.log(
          'info',
          `Read ${done} of ${run.sourcesTotal} channels.`,
        )
      if (steps >= maxSteps || Date.now() >= deadline) {
        await recordProviderSuccess('youtube')
        return {
          outcome: 'continue',
          message:
            run.phase === 'items'
              ? `Read ${step === 'channel-done' ? done : run.sourcesDone} of ${run.sourcesTotal} channels. The next job continues.`
              : 'Reading the subscription list. The next job continues.',
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
        message: `Paused: ${error.message.replace(/\.$/, '')}. Stored videos are kept; the schedule resumes the sync after ${resumeAfter.toISOString()}.`,
      }
    }
    // A missing or rejected sign-in is the account's state, not a provider fault.
    if (!(error instanceof ServerError))
      await recordProviderFailure(youtubePlugin, error)
    await db
      .update(subscriptionSync)
      .set({
        status: 'failed',
        errorMessage:
          error instanceof ProviderRequestError || error instanceof ServerError
            ? error.message
            : 'YouTube sync failed or returned invalid data. No further requests were made.',
        leaseToken: null,
      })
      .where(owned)
    return { outcome: 'failed', error }
  }
}

/** Accounts whose schedule is due, or whose quota pause has passed. */
export function dueYoutubeSyncUsers(now: number): Promise<string[]> {
  return dueSubscriptionSyncUsers(
    YOUTUBE,
    now,
    getYoutubeSubscriptionSyncStatus,
  )
}
