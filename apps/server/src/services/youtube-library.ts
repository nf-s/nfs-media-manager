import { sql } from 'drizzle-orm'
import { z } from 'zod'
import {
  YoutubeChannelListSchema,
  YoutubeVideoPageSchema,
  YoutubeVideoQuerySchema,
  type YoutubeVideoPage,
  type YoutubeVideoQueryInput,
} from '@repo/schemas/youtube'
import { db } from '@/lib/db'

const isoSeconds = (value: number | null) =>
  value === null ? null : new Date(value * 1000).toISOString()

const CountSchema = z.coerce.number().nullable()
const ChannelRowsSchema = z.array(
  z.object({
    id: z.string(),
    title: z.string(),
    handle: z.string().nullable(),
    description: z.string().nullable(),
    thumbnail_url: z.string().nullable(),
    subscriber_count: CountSchema,
    history_complete: z.boolean(),
    stored: z.coerce.number(),
    latest: z.coerce.number().nullable(),
  }),
)

/** Every subscribed channel with its stored video count; no YouTube requests. */
export async function listYoutubeChannels() {
  const rows = ChannelRowsSchema.parse(
    (
      await db.execute(sql`
        select c.id, c.title, c.handle, c.description, c.thumbnail_url,
          c.subscriber_count, c.history_complete, count(v.id) as stored,
          extract(epoch from max(v.published_at))::float8 as latest
        from youtube_channel c
        left join youtube_video v on v.channel_id = c.id
        where c.subscribed
        group by c.id
        order by lower(c.title), c.id`)
    ).rows,
  )
  return YoutubeChannelListSchema.parse({
    items: rows.map((row) => ({
      id: row.id,
      title: row.title,
      handle: row.handle,
      description: row.description,
      thumbnailUrl: row.thumbnail_url,
      subscriberCount: row.subscriber_count,
      storedVideos: row.stored,
      latestVideoAt: isoSeconds(row.latest),
      historyComplete: row.history_complete,
    })),
  })
}

const VideoRowsSchema = z.array(
  z.object({
    id: z.string(),
    channel_id: z.string(),
    channel_title: z.string(),
    channel_thumbnail_url: z.string().nullable(),
    title: z.string(),
    description: z.string(),
    published: z.coerce.number(),
    duration_sec: z.coerce.number(),
    view_count: CountSchema,
    like_count: CountSchema,
    comment_count: CountSchema,
    live: z.enum(['none', 'live', 'upcoming']).catch('none'),
    total: z.coerce.number(),
  }),
)

const LexemeRowsSchema = z.array(z.object({ nodes: z.coerce.number() }))

const DURATION_FILTERS = {
  short: sql`v.duration_sec > 0 and v.duration_sec < 240`,
  medium: sql`v.duration_sec between 240 and 1200`,
  long: sql`v.duration_sec > 1200`,
}

/** Searches stored videos from subscribed channels; no YouTube requests. */
export async function searchYoutubeVideos(
  input: YoutubeVideoQueryInput = {},
): Promise<YoutubeVideoPage> {
  const query = YoutubeVideoQuerySchema.parse(input)
  const text = query.q || null
  const match = sql`websearch_to_tsquery('english', ${text})`
  // A search made only of stop words, such as "The Who", has no lexemes to
  // match; it falls back to the literal text in the title or channel name.
  const literal =
    text !== null &&
    LexemeRowsSchema.parse(
      (await db.execute(sql`select numnode(${match}) as nodes`)).rows,
    )[0]?.nodes === 0
  const pattern = `%${(text ?? '').replace(/[\\%_]/g, '\\$&')}%`
  const ranked = text !== null && !literal
  const filters = [
    sql`c.subscribed`,
    ...(literal
      ? [sql`(v.title ilike ${pattern} or c.title ilike ${pattern})`]
      : []),
    ...(ranked
      ? [
          sql`v.search @@ ${match}`,
          // The index narrows on every field; titles-only rechecks the heavier weights.
          ...(query.fields === 'title'
            ? [sql`ts_filter(v.search, '{a,b}') @@ ${match}`]
            : []),
        ]
      : []),
    ...(query.channelId?.length
      ? [
          sql`v.channel_id in (${sql.join(
            query.channelId.map((id) => sql`${id}`),
            sql`, `,
          )})`,
        ]
      : []),
    ...(query.duration ? [DURATION_FILTERS[query.duration]] : []),
    ...(query.publishedFrom
      ? [sql`v.published_at >= ${query.publishedFrom}::date`]
      : []),
    ...(query.publishedTo
      ? [sql`v.published_at < ${query.publishedTo}::date + 1`]
      : []),
  ]
  const direction = query.sortDirection === 'asc' ? sql`asc` : sql`desc`
  const requested = query.sortBy ?? (ranked ? 'relevance' : 'publishedAt')
  const sortBy =
    requested === 'relevance' && !ranked ? 'publishedAt' : requested
  const order = {
    relevance: sql`ts_rank(v.search, ${match}) ${direction}, v.published_at desc`,
    publishedAt: sql`v.published_at ${direction}`,
    viewCount: sql`v.view_count ${direction} nulls last, v.published_at desc`,
    durationSec: sql`v.duration_sec ${direction}, v.published_at desc`,
  }
  const rows = VideoRowsSchema.parse(
    (
      await db.execute(sql`
        select v.id, v.channel_id, c.title as channel_title,
          c.thumbnail_url as channel_thumbnail_url, v.title, v.description,
          extract(epoch from v.published_at)::float8 as published,
          v.duration_sec, v.view_count, v.like_count, v.comment_count, v.live,
          count(*) over () as total
        from youtube_video v
        join youtube_channel c on c.id = v.channel_id
        where ${sql.join(filters, sql` and `)}
        order by ${order[sortBy]}, v.id
        limit ${query.size} offset ${(query.page - 1) * query.size}`)
    ).rows,
  )
  const totalCount = rows[0]?.total ?? 0
  return YoutubeVideoPageSchema.parse({
    items: rows.map((row) => ({
      id: row.id,
      channelId: row.channel_id,
      channelTitle: row.channel_title,
      channelThumbnailUrl: row.channel_thumbnail_url,
      title: row.title,
      description: row.description,
      publishedAt: new Date(row.published * 1000).toISOString(),
      durationSec: row.duration_sec,
      viewCount: row.view_count,
      likeCount: row.like_count,
      commentCount: row.comment_count,
      live: row.live,
    })),
    totalCount,
    page: query.page,
    size: query.size,
    pageCount: Math.ceil(totalCount / query.size),
  })
}
