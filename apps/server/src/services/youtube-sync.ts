import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, gt, inArray, sql, type SQL } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import {
  ProviderRequestError,
  isProviderItemNotFoundError,
} from '@repo/media-plugin-sdk'
import {
  YOUTUBE_SYNC_TASK,
  YoutubeSyncScheduleSchema,
  YoutubeSyncStatusSchema,
  type YoutubeSyncSchedule,
  type YoutubeSyncStatus,
} from '@repo/schemas/youtube'
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
  scrapeJob,
  youtubeChannel,
  youtubeSync,
  youtubeVideo,
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
import { getYoutubeAccountStatus, youtubeAccessToken } from './youtube-oauth'

// One job stays well inside a Cloudflare Queue invocation's 15-minute limit
// and its subrequest allowance; a longer sync continues in a follow-on job.
const CHUNK_STEPS = 300
const CHUNK_BUDGET_MS = 8 * 60 * 1000
const LOG_EVERY_CHANNELS = 25
const TOKEN_REUSE_MS = 60 * 1000
// When a quota pause carries no reset time.
const DEFAULT_PAUSE_MS = 60 * 60 * 1000

type SyncRow = typeof youtubeSync.$inferSelect
type VideoPage = z.infer<typeof YoutubeVideoListSchema>

const SCHEDULE_MINUTES: Record<YoutubeSyncSchedule, number | null> = {
  off: null,
  '1h': 60,
  '3h': 3 * 60,
  '6h': 6 * 60,
  daily: 24 * 60,
  weekly: 7 * 24 * 60,
}

// PostgreSQL text cannot hold a NUL character.
const clean = (value: string) => value.replaceAll('\u0000', '')

/** Title (A), channel name and tags (B), description (D). */
function searchVector(
  title: SQL,
  channelTitle: SQL,
  tags: SQL,
  description: SQL,
) {
  return sql`setweight(to_tsvector('english', ${title}), 'A') ||
    setweight(to_tsvector('english', ${channelTitle} || ' ' || ${tags}), 'B') ||
    setweight(to_tsvector('english', ${description}), 'D')`
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
        eq(scrapeJob.provider, 'youtube'),
        sql`${scrapeJob.options}->>'task' = ${YOUTUBE_SYNC_TASK}`,
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
): YoutubeSyncStatus['state'] {
  if (job?.status === 'queued' || job?.status === 'running') return 'running'
  if (!row || row.status === 'idle') return 'never'
  if (row.status === 'complete') return 'complete'
  if (row.status === 'paused') return 'paused'
  // An open run without a job was cancelled, or its worker was interrupted.
  return row.status === 'failed' || job?.status === 'failed'
    ? 'failed'
    : 'stopped'
}

const CountsSchema = z
  .array(z.object({ channels: z.coerce.number(), videos: z.coerce.number() }))
  .length(1)

export async function getYoutubeSyncStatus(
  userId: string,
): Promise<YoutubeSyncStatus> {
  const account = await getYoutubeAccountStatus(userId)
  const [row] = await db
    .select()
    .from(youtubeSync)
    .where(eq(youtubeSync.userId, userId))
  const job = await latestSyncJob()
  const counts = CountsSchema.parse(
    (
      await db.execute(sql`
        select
          (select count(*) from youtube_channel where subscribed) as channels,
          (select count(*) from youtube_video v
            join youtube_channel c on c.id = v.channel_id
            where c.subscribed) as videos`)
    ).rows,
  )
  const state = syncState(row, job)
  const schedule = YoutubeSyncScheduleSchema.catch('daily').parse(row?.schedule)
  const minutes = SCHEDULE_MINUTES[schedule]
  const next =
    !account.connected || minutes === null
      ? null
      : state === 'complete' && row?.completedAt
        ? new Date(row.completedAt.getTime() + minutes * 60 * 1000)
        : state === 'paused'
          ? (row?.resumeAfter ?? null)
          : null
  const started = row && row.status !== 'idle'
  return YoutubeSyncStatusSchema.parse({
    account,
    state,
    job: job ? { id: job.id, status: job.status } : null,
    schedule,
    nextScheduledAt: next?.toISOString() ?? null,
    phase: started
      ? row.phase === 'videos'
        ? 'videos'
        : 'subscriptions'
      : null,
    channelsDone: row?.channelsDone ?? 0,
    channelsTotal: row?.channelsTotal ?? 0,
    newVideos: row?.newVideos ?? 0,
    storedChannels: counts[0]?.channels ?? 0,
    storedVideos: counts[0]?.videos ?? 0,
    startedAt: started ? row.startedAt.toISOString() : null,
    lastCompletedAt: row?.completedAt?.toISOString() ?? null,
    resumeAfter:
      state === 'paused' ? (row?.resumeAfter?.toISOString() ?? null) : null,
    errorMessage:
      state === 'failed'
        ? (row?.errorMessage ?? job?.errorMessage ?? null)
        : null,
  })
}

export async function setYoutubeSyncSchedule(
  userId: string,
  schedule: YoutubeSyncSchedule,
) {
  // The setting can be saved before the first sync creates a run.
  await db
    .insert(youtubeSync)
    .values({ userId, status: 'idle', schedule, startedAt: new Date() })
    .onConflictDoUpdate({ target: youtubeSync.userId, set: { schedule } })
  return getYoutubeSyncStatus(userId)
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
    phase: 'subscriptions',
    pageToken: null,
    channelCursor: null,
    channelsDone: 0,
    channelsTotal: 0,
    newVideos: 0,
    resumeAfter: null,
    errorMessage: null,
    startedAt: now,
  }
  await db.transaction(async (tx) => {
    await tx
      .insert(youtubeSync)
      .values({ userId, ...fresh })
      .onConflictDoNothing()
    const [row] = await tx
      .select()
      .from(youtubeSync)
      .where(eq(youtubeSync.userId, userId))
      .for('update')
    if (!row || row.status === 'running') return
    await tx
      .update(youtubeSync)
      .set(
        row.status === 'complete' || row.status === 'idle'
          ? fresh
          : { status: 'running', resumeAfter: null, errorMessage: null },
      )
      .where(eq(youtubeSync.userId, userId))
  })
}

// Only one sync job is active at a time, so the newest job takes the run. The
// token fences a cancelled job that is still finishing a request.
async function claim(token: string) {
  const [open] = await db
    .select({ userId: youtubeSync.userId })
    .from(youtubeSync)
    .where(eq(youtubeSync.status, 'running'))
    .orderBy(asc(youtubeSync.startedAt), asc(youtubeSync.userId))
    .limit(1)
  if (!open) return null
  const [row] = await db
    .update(youtubeSync)
    .set({ leaseToken: token })
    .where(
      and(
        eq(youtubeSync.userId, open.userId),
        eq(youtubeSync.status, 'running'),
      ),
    )
    .returning()
  return row ?? null
}

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

/** Locks the run and confirms this job still owns the step it fetched. */
async function ownedRun(tx: Transaction, token: string, run: SyncRow) {
  const [current] = await tx
    .select()
    .from(youtubeSync)
    .where(eq(youtubeSync.userId, run.userId))
    .for('update')
  return current &&
    current.status === 'running' &&
    current.leaseToken === token &&
    current.runId === run.runId &&
    current.phase === run.phase &&
    current.pageToken === run.pageToken &&
    current.channelCursor === run.channelCursor
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
          .select({ id: youtubeChannel.id, title: youtubeChannel.title })
          .from(youtubeChannel)
          .where(inArray(youtubeChannel.id, ids))
      ).flatMap((existing) => {
        const next = rows.find((row) => row.id === existing.id)
        return next && next.title !== existing.title ? [next] : []
      })
      await tx
        .insert(youtubeChannel)
        .values(rows)
        .onConflictDoUpdate({
          target: youtubeChannel.id,
          set: {
            title: sql`excluded.title`,
            handle: sql`excluded.handle`,
            description: sql`excluded.description`,
            thumbnailUrl: sql`excluded.thumbnail_url`,
            uploadsPlaylistId: sql`excluded.uploads_playlist_id`,
            subscriberCount: sql`excluded.subscriber_count`,
            subscribed: true,
            seenRunId: run.runId,
            updatedAt: new Date(),
          },
        })
      // The channel name is part of each video's search text.
      for (const channel of renamed)
        await tx
          .update(youtubeVideo)
          .set({
            search: searchVector(
              sql`${youtubeVideo.title}`,
              sql`${channel.title}::text`,
              sql`(select coalesce(string_agg(tag, ' '), '')
                from jsonb_array_elements_text(${youtubeVideo.tags}) tag)`,
              sql`${youtubeVideo.description}`,
            ),
          })
          .where(eq(youtubeVideo.channelId, channel.id))
    }
    if (page.nextPageToken) {
      await tx
        .update(youtubeSync)
        .set({ pageToken: page.nextPageToken })
        .where(eq(youtubeSync.userId, run.userId))
      return 'more'
    }
    await tx
      .update(youtubeChannel)
      .set({ subscribed: false })
      .where(
        and(
          eq(youtubeChannel.subscribed, true),
          sql`${youtubeChannel.seenRunId} is distinct from ${run.runId}`,
        ),
      )
    const total = await tx.$count(
      youtubeChannel,
      eq(youtubeChannel.subscribed, true),
    )
    await tx
      .update(youtubeSync)
      .set({
        phase: 'videos',
        pageToken: null,
        channelCursor: null,
        channelsDone: 0,
        channelsTotal: total,
      })
      .where(eq(youtubeSync.userId, run.userId))
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
      channelId: channel.id,
      title,
      description,
      tags,
      publishedAt: new Date(video.snippet.publishedAt),
      durationSec: youtubeDurationSeconds(video.contentDetails.duration),
      viewCount: video.statistics?.viewCount ?? null,
      likeCount: video.statistics?.likeCount ?? null,
      commentCount: video.statistics?.commentCount ?? null,
      live: video.snippet.liveBroadcastContent,
      search: searchVector(
        sql`${title}::text`,
        sql`${channel.title}::text`,
        sql`${tags.join(' ')}::text`,
        sql`${description}::text`,
      ),
    }
  })
}

/**
 * Reads one page of the next channel's uploads, newest first, with each
 * video's details. A channel whose history is already stored stops at the
 * first page that holds a known video; otherwise every page is read.
 */
async function syncUploadsPage(
  request: YoutubeRequest,
  accessToken: string,
  token: string,
  run: SyncRow,
  context: LastfmSyncJobContext,
) {
  const [channel] = await db
    .select({
      id: youtubeChannel.id,
      title: youtubeChannel.title,
      uploadsPlaylistId: youtubeChannel.uploadsPlaylistId,
      historyComplete: youtubeChannel.historyComplete,
    })
    .from(youtubeChannel)
    .where(
      and(
        eq(youtubeChannel.subscribed, true),
        run.channelCursor === null
          ? undefined
          : gt(youtubeChannel.id, run.channelCursor),
      ),
    )
    .orderBy(asc(youtubeChannel.id))
    .limit(1)
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
          .select({ id: youtubeVideo.id })
          .from(youtubeVideo)
          .where(inArray(youtubeVideo.id, ids))
      : []
    if (rows.length)
      await tx
        .insert(youtubeVideo)
        .values(rows)
        .onConflictDoUpdate({
          target: youtubeVideo.id,
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
        .update(youtubeSync)
        .set({ pageToken: next, newVideos: current.newVideos + added })
        .where(eq(youtubeSync.userId, run.userId))
      return 'more'
    }
    if (!next && !channel.historyComplete)
      await tx
        .update(youtubeChannel)
        .set({ historyComplete: true })
        .where(eq(youtubeChannel.id, channel.id))
    await tx
      .update(youtubeSync)
      .set({
        pageToken: null,
        channelCursor: channel.id,
        channelsDone: current.channelsDone + 1,
        newVideos: current.newVideos + added,
      })
      .where(eq(youtubeSync.userId, run.userId))
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
    eq(youtubeSync.status, 'running'),
    eq(youtubeSync.leaseToken, token),
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
        run.phase === 'videos'
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
          .update(youtubeSync)
          .set({
            status: 'complete',
            completedAt: new Date(),
            pageToken: null,
            leaseToken: null,
          })
          .where(owned)
        await recordProviderSuccess('youtube')
        const status = await getYoutubeSyncStatus(run.userId)
        return {
          outcome: 'complete',
          message: `Sync complete. ${status.newVideos} new videos; ${status.storedVideos} videos from ${status.storedChannels} subscribed channels are stored.`,
        }
      }
      steps += 1
      const done = run.channelsDone + 1
      if (step === 'channel-done' && done % LOG_EVERY_CHANNELS === 0)
        await context.log(
          'info',
          `Read ${done} of ${run.channelsTotal} channels.`,
        )
      if (steps >= maxSteps || Date.now() >= deadline) {
        await recordProviderSuccess('youtube')
        return {
          outcome: 'continue',
          message:
            run.phase === 'videos'
              ? `Read ${step === 'channel-done' ? done : run.channelsDone} of ${run.channelsTotal} channels. The next job continues.`
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
        .update(youtubeSync)
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
      .update(youtubeSync)
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
export async function dueYoutubeSyncUsers(now: number): Promise<string[]> {
  const rows = await db
    .select({ userId: youtubeSync.userId })
    .from(youtubeSync)
    .where(inArray(youtubeSync.status, ['complete', 'paused']))
  const due: string[] = []
  for (const row of rows) {
    const status = await getYoutubeSyncStatus(row.userId)
    if (status.nextScheduledAt && Date.parse(status.nextScheduledAt) <= now)
      due.push(row.userId)
  }
  return due
}
