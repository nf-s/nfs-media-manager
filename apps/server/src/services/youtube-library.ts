import { sql } from 'drizzle-orm'
import {
  YoutubeChannelListSchema,
  YoutubeVideoPageSchema,
  YoutubeVideoQuerySchema,
  type YoutubeVideoPage,
  type YoutubeVideoQueryInput,
} from '@repo/schemas/youtube'
import {
  listSubscriptionSources,
  searchSubscriptionItemRows,
} from './subscription-library'

// The YouTube Videos and Subscriptions pages read the subscription library
// through these YouTube-only views.

/** Every subscribed channel with its stored video count; no YouTube requests. */
export async function listYoutubeChannels() {
  const { items } = await listSubscriptionSources({ type: 'youtube' })
  return YoutubeChannelListSchema.parse({
    items: items.flatMap((source) =>
      source.type === 'youtube'
        ? [
            {
              id: source.id,
              title: source.title,
              handle: source.handle,
              description: source.description,
              thumbnailUrl: source.thumbnailUrl,
              subscriberCount: source.subscriberCount,
              storedVideos: source.storedItems,
              latestVideoAt: source.latestItemAt,
              historyComplete: source.historyComplete,
            },
          ]
        : [],
    ),
  })
}

const DURATION_FILTERS = {
  short: sql`i.duration_sec > 0 and i.duration_sec < 240`,
  medium: sql`i.duration_sec between 240 and 1200`,
  long: sql`i.duration_sec > 1200`,
}

/** Searches stored videos from subscribed channels; no YouTube requests. */
export async function searchYoutubeVideos(
  input: YoutubeVideoQueryInput = {},
): Promise<YoutubeVideoPage> {
  const query = YoutubeVideoQuerySchema.parse(input)
  const conditions = [
    sql`s.type = 'youtube'`,
    ...(query.channelId?.length
      ? [
          sql`i.source_id in (${sql.join(
            query.channelId.map((id) => sql`${id}`),
            sql`, `,
          )})`,
        ]
      : []),
    ...(query.duration ? [DURATION_FILTERS[query.duration]] : []),
    ...(query.publishedFrom
      ? [sql`i.published_at >= ${query.publishedFrom}::date`]
      : []),
    ...(query.publishedTo
      ? [sql`i.published_at < ${query.publishedTo}::date + 1`]
      : []),
  ]
  const direction = query.sortDirection === 'asc' ? sql`asc` : sql`desc`
  const { rows, totalCount } = await searchSubscriptionItemRows({
    text: query.q,
    fields: query.fields,
    conditions,
    order: (ranked) => {
      const sortBy = query.sortBy ?? (ranked ? 'relevance' : 'publishedAt')
      const order = {
        // Relevance without a search is by published date.
        relevance: ranked
          ? sql`ts_rank(i.search, ${ranked}) ${direction}, i.published_at desc`
          : sql`i.published_at ${direction}`,
        publishedAt: sql`i.published_at ${direction}`,
        viewCount: sql`i.view_count ${direction} nulls last, i.published_at desc`,
        durationSec: sql`i.duration_sec ${direction}, i.published_at desc`,
      }
      return order[sortBy]
    },
    page: query.page,
    size: query.size,
  })
  return YoutubeVideoPageSchema.parse({
    items: rows.map((row) => ({
      id: row.id,
      channelId: row.source_id,
      channelTitle: row.source_title,
      channelThumbnailUrl: row.source_thumbnail_url,
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
