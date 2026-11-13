import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { YoutubeChannelIdSchema } from '@repo/schemas/youtube'
import { db } from '@/lib/db'

const ChannelNameRowsSchema = z.array(
  z.object({
    id: YoutubeChannelIdSchema,
    title: z.string(),
    handle: z.string().nullable(),
  }),
)
export type YoutubeChannelName = z.infer<typeof ChannelNameRowsSchema>[number]

export type YoutubeChannelNameMatch =
  | { status: 'matched'; channel: YoutubeChannelName }
  | { status: 'missing' }
  | { status: 'ambiguous'; candidates: YoutubeChannelName[] }

/** Titles and handles of subscribed channels; read on the server only. */
export async function listSubscribedYoutubeChannelNames() {
  return ChannelNameRowsSchema.parse(
    (
      await db.execute(sql`
        select id, title, handle from subscription_source
        where type = 'youtube' and subscribed
        order by lower(title), id`)
    ).rows,
  )
}

function nameKey(value: string) {
  return value.trim().replace(/^@/, '').toLocaleLowerCase()
}

/**
 * Case-insensitive: an exact title or @handle first, then a substring of
 * either. Several matches at the same step are ambiguous.
 */
export function matchYoutubeChannelName(
  name: string,
  channels: YoutubeChannelName[],
): YoutubeChannelNameMatch {
  const key = nameKey(name)
  if (!key) return { status: 'missing' }
  const title = name.trim().toLocaleLowerCase()
  const keys = (channel: YoutubeChannelName) => [
    channel.title.trim().toLocaleLowerCase(),
    channel.handle ? nameKey(channel.handle) : '',
  ]
  const exact = channels.filter((channel) => {
    const [channelTitle, handle] = keys(channel)
    return channelTitle === title || handle === key
  })
  const matches = exact.length
    ? exact
    : channels.filter((channel) =>
        keys(channel).some((value) => value.includes(key)),
      )
  const [channel] = matches
  if (!channel) return { status: 'missing' }
  return matches.length === 1
    ? { status: 'matched', channel }
    : { status: 'ambiguous', candidates: matches }
}
