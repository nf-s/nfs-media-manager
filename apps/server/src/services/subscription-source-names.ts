import { sql } from 'drizzle-orm'
import { z } from 'zod'
import {
  SubscriptionSourceIdSchema,
  SubscriptionTypeSchema,
} from '@repo/schemas/subscriptions'
import { db } from '@/lib/db'

const SourceNameRowsSchema = z.array(
  z.object({
    id: SubscriptionSourceIdSchema,
    type: SubscriptionTypeSchema,
    title: z.string(),
    handle: z.string().nullable(),
  }),
)
export type SubscriptionSourceName = z.infer<
  typeof SourceNameRowsSchema
>[number]

type NamedSource = { title: string; handle: string | null }

export type SourceNameMatch<Source extends NamedSource> =
  | { status: 'matched'; source: Source }
  | { status: 'missing' }
  | { status: 'ambiguous'; candidates: Source[] }

/** Titles and handles of subscribed channels and podcasts; read on the server only. */
export async function listSubscribedSourceNames() {
  return SourceNameRowsSchema.parse(
    (
      await db.execute(sql`
        select id, type, title, handle from subscription_source
        where subscribed
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
export function matchSourceName<Source extends NamedSource>(
  name: string,
  sources: Source[],
): SourceNameMatch<Source> {
  const key = nameKey(name)
  if (!key) return { status: 'missing' }
  const title = name.trim().toLocaleLowerCase()
  const keys = (source: Source) => [
    source.title.trim().toLocaleLowerCase(),
    source.handle ? nameKey(source.handle) : '',
  ]
  const exact = sources.filter((source) => {
    const [sourceTitle, handle] = keys(source)
    return sourceTitle === title || handle === key
  })
  const matches = exact.length
    ? exact
    : sources.filter((source) =>
        keys(source).some((value) => value.includes(key)),
      )
  const [source] = matches
  if (!source) return { status: 'missing' }
  return matches.length === 1
    ? { status: 'matched', source }
    : { status: 'ambiguous', candidates: matches }
}
