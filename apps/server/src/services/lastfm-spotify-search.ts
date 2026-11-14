import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import {
  LASTFM_SPOTIFY_SEARCH_TASK,
  LastfmSpotifySearchGroupSchema,
  LastfmSpotifySearchInputSchema,
  LastfmSpotifySearchJobSchema,
  LastfmSpotifySearchSchema,
  type LastfmSpotifySearchInput,
} from '@repo/schemas/lastfm'
import { EnrichmentResultSchema } from '@repo/schemas/job'
import { ManualMediaSearchResultSchema } from '@repo/schemas/manual-add'
import { albumNameKey } from '@/lib/album-import-candidates'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import { createStableId } from '@/lib/media-utils'
import { mediaItem, scrapeJob, scrapeJobLog } from '@/schemas/db'
import { createTaskJob, type TaskJobResult } from './jobs'
import { getLastfmAccount, type LastfmSyncJobContext } from './lastfm-scrobbles'
import { prepareManualMediaSearch, searchManualMedia } from './manual-add'

type SearchGroup = z.infer<typeof LastfmSpotifySearchGroupSchema>
const SearchOptionsSchema = LastfmSpotifySearchGroupSchema.extend({
  groupKey: z.string().min(1),
  query: z.string().min(1).max(200),
}).strip()
const StoredResultSchema = z.object({
  diagnostics: z.array(
    z.object({
      kind: z.literal(LASTFM_SPOTIFY_SEARCH_TASK),
      query: z.string(),
      result: ManualMediaSearchResultSchema,
    }),
  ),
})

export function lastfmSpotifyGroupKey(account: string, group: SearchGroup) {
  return createStableId(
    'lastfm-album',
    JSON.stringify([
      account,
      albumNameKey(group.artistName),
      albumNameKey(group.albumName),
    ]),
  )
}

function searchQuery(group: SearchGroup) {
  return `${group.artistName} ${group.albumName}`.slice(0, 200)
}

async function requireAccount() {
  const account = await getLastfmAccount()
  if (!account)
    throw new ServerError({
      statusCode: 422,
      message: 'Configure Last.fm before searching scrobbled albums.',
    })
  return account
}

async function requireUnlinkedGroup(account: string, group: SearchGroup) {
  const rows = z.array(z.object({ linked: z.boolean() })).parse(
    (
      await db.execute(sql`
    select exists (
      select 1 from lastfm_album_link l where l.username = ${account}
        and l.artist_key = ${albumNameKey(group.artistName)}
        and l.album_key = ${albumNameKey(group.albumName)}
        and l.album_media_item_id is not null
    ) as linked
    where exists (
      select 1 from lastfm_scrobble s where s.username = ${account}
        and s.artist_key = ${albumNameKey(group.artistName)}
        and s.album_key = ${albumNameKey(group.albumName)}
    )`)
    ).rows,
  )
  if (!rows[0])
    throw new ServerError({
      statusCode: 404,
      message: 'Scrobbled album no longer exists.',
    })
  if (rows[0].linked)
    throw new ServerError({
      statusCode: 409,
      message: 'Scrobbled album is already linked.',
    })
}

export async function prepareLastfmSpotifySearch(
  _userId: string | null,
  input: Record<string, unknown>,
) {
  const group = LastfmSpotifySearchGroupSchema.parse({
    artistName: input.artistName,
    albumName: input.albumName,
  })
  const account = await requireAccount()
  const groupKey = lastfmSpotifyGroupKey(account, group)
  if (input.groupKey !== undefined && input.groupKey !== groupKey)
    throw new ServerError({
      statusCode: 409,
      message: 'The Last.fm account has changed.',
    })
  await requireUnlinkedGroup(account, group)
  await prepareManualMediaSearch('album')
  return { ...group, groupKey, query: searchQuery(group) }
}

export async function runLastfmSpotifySearch(
  context: LastfmSyncJobContext,
  input: Record<string, unknown>,
): Promise<TaskJobResult> {
  try {
    const options = SearchOptionsSchema.parse(input)
    await context.assertActive()
    const account = await requireAccount()
    if (lastfmSpotifyGroupKey(account, options) !== options.groupKey)
      throw new ServerError({
        statusCode: 409,
        message: 'The Last.fm account has changed.',
      })
    try {
      await requireUnlinkedGroup(account, options)
    } catch (error) {
      if (
        error instanceof ServerError &&
        [404, 409].includes(error.response.statusCode)
      )
        return {
          outcome: 'complete',
          message:
            'Search skipped: the scrobbled album is missing or already linked.',
        }
      throw error
    }
    const result = await searchManualMedia(
      { mediaType: 'album', q: options.query, page: 1 },
      context.assertActive,
    )
    if (!(await context.isActive())) return { outcome: 'stopped' }
    return {
      outcome: 'complete',
      message: `Spotify search returned ${result.items.length} albums.`,
      options: { resultCount: result.items.length },
      metadata: {
        diagnostics: [
          { kind: LASTFM_SPOTIFY_SEARCH_TASK, query: options.query, result },
        ],
      },
    }
  } catch (error) {
    if (!(await context.isActive())) return { outcome: 'stopped' }
    return { outcome: 'failed', error }
  }
}

export async function queueLastfmSpotifySearches(
  input: LastfmSpotifySearchInput,
  userId: string | null,
) {
  const parsed = LastfmSpotifySearchInputSchema.parse(input)
  const account = await requireAccount()
  await prepareManualMediaSearch('album')
  const batchId = parsed.batchId ?? nanoid()
  let queued = 0
  let skipped = 0
  const warnings: string[] = []
  const seen = new Set<string>()
  for (const group of parsed.groups) {
    const groupKey = lastfmSpotifyGroupKey(account, group)
    if (seen.has(groupKey)) {
      skipped += 1
      continue
    }
    seen.add(groupKey)
    try {
      await createTaskJob(LASTFM_SPOTIFY_SEARCH_TASK, userId, {
        taskOptions: { ...group, groupKey, batchId },
        skipActive: true,
      })
      queued += 1
    } catch (error) {
      if (
        error instanceof ServerError &&
        [404, 409].includes(error.response.statusCode)
      ) {
        skipped += 1
        continue
      }
      throw error
    }
  }
  if (skipped)
    warnings.push(
      'Linked, missing, duplicate or already queued albums were skipped.',
    )
  return EnrichmentResultSchema.parse({ batchId, queued, skipped, warnings })
}

export async function getLastfmSpotifySearchJobs(
  account: string,
  groups?: SearchGroup[],
) {
  const keys = groups?.map((group) => lastfmSpotifyGroupKey(account, group))
  const summaries = new Map<
    string,
    z.infer<typeof LastfmSpotifySearchJobSchema> & {
      artistKey: string
      albumKey: string
    }
  >()
  if (keys?.length === 0) return summaries
  const jobs = await db
    .selectDistinctOn([sql`${scrapeJob.options}->>'groupKey'`], {
      id: scrapeJob.id,
      status: scrapeJob.status,
      errorMessage: scrapeJob.errorMessage,
      groupKey: sql<unknown>`${scrapeJob.options}->>'groupKey'`,
      artistName: sql<unknown>`${scrapeJob.options}->>'artistName'`,
      albumName: sql<unknown>`${scrapeJob.options}->>'albumName'`,
      resultCount: sql<unknown>`${scrapeJob.options}->'resultCount'`,
    })
    .from(scrapeJob)
    .where(
      and(
        eq(scrapeJob.provider, 'spotify'),
        sql`${scrapeJob.options}->>'task' = ${LASTFM_SPOTIFY_SEARCH_TASK}`,
        keys
          ? inArray(sql`${scrapeJob.options}->>'groupKey'`, keys)
          : undefined,
      ),
    )
    .orderBy(
      sql`${scrapeJob.options}->>'groupKey'`,
      desc(scrapeJob.createdAt),
      desc(scrapeJob.id),
    )
  for (const job of jobs) {
    const key = z.string().parse(job.groupKey)
    const group = LastfmSpotifySearchGroupSchema.safeParse({
      artistName: job.artistName,
      albumName: job.albumName,
    })
    if (!group.success || lastfmSpotifyGroupKey(account, group.data) !== key)
      continue
    summaries.set(key, {
      ...LastfmSpotifySearchJobSchema.parse({
        jobId: job.id,
        status: job.status,
        errorMessage: job.errorMessage,
        resultCount: job.resultCount,
      }),
      artistKey: albumNameKey(group.data.artistName),
      albumKey: albumNameKey(group.data.albumName),
    })
  }
  return summaries
}

export async function getLastfmSpotifySearch(input: SearchGroup) {
  const group = LastfmSpotifySearchGroupSchema.parse(input)
  const account = await requireAccount()
  const summaries = await getLastfmSpotifySearchJobs(account, [group])
  const job = summaries.get(lastfmSpotifyGroupKey(account, group)) ?? null
  if (!job)
    return LastfmSpotifySearchSchema.parse({
      job: null,
      query: searchQuery(group),
      result: null,
    })
  const logs =
    job.status === 'succeeded'
      ? await db
          .select({ metadata: scrapeJobLog.metadata })
          .from(scrapeJobLog)
          .where(
            and(
              eq(scrapeJobLog.jobId, job.jobId),
              sql`${scrapeJobLog.metadata} ? 'diagnostics'`,
            ),
          )
      : []
  for (const log of logs) {
    const stored = StoredResultSchema.safeParse(log.metadata)
    const entry = stored.success ? stored.data.diagnostics[0] : undefined
    if (entry) {
      const ids = entry.result.items.flatMap((item) =>
        item.mediaItemId === null ? [] : [item.mediaItemId],
      )
      const existing = ids.length
        ? await db
            .select({ id: mediaItem.id })
            .from(mediaItem)
            .where(
              and(inArray(mediaItem.id, ids), eq(mediaItem.mediaType, 'album')),
            )
        : []
      const retainedIds = new Set(existing.map((item) => item.id))
      return LastfmSpotifySearchSchema.parse({
        job,
        query: entry.query,
        result: {
          ...entry.result,
          items: entry.result.items.map((item) => ({
            ...item,
            mediaItemId:
              item.mediaItemId !== null && retainedIds.has(item.mediaItemId)
                ? item.mediaItemId
                : null,
          })),
        },
      })
    }
  }
  return LastfmSpotifySearchSchema.parse({
    job,
    query: searchQuery(group),
    result: null,
  })
}
