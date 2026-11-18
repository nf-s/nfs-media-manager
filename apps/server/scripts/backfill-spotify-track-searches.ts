import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { and, eq, gt, isNotNull, notExists, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { SPOTIFY_TRACK_SEARCH_TASK } from '@repo/schemas/spotify-track-search'
import type { db } from '@/lib/db'
import { scrapeJob } from '@/schemas/db'

const PAGE_SIZE = 100
const trackId = sql<string>`${scrapeJob.options}->>'trackId'`
const task = sql.raw(`'${SPOTIFY_TRACK_SEARCH_TASK}'`)
const newer = alias(scrapeJob, 'newer_search')

function listSavedSearches(
  database: Pick<typeof db, 'select'>,
  cursor?: string,
) {
  return database
    .select({
      jobId: scrapeJob.id,
      trackId,
      userId: scrapeJob.requestedByUserId,
    })
    .from(scrapeJob)
    .where(
      and(
        eq(scrapeJob.provider, 'spotify'),
        sql`${scrapeJob.options}->>'task' = ${task}`,
        eq(scrapeJob.status, 'succeeded'),
        isNotNull(scrapeJob.finishedAt),
        isNotNull(scrapeJob.requestedByUserId),
        sql`${scrapeJob.options} ? 'resultCount'`,
        sql`not (${scrapeJob.options} ?| array['acceptedTrackId', 'acceptedSpotifyTrackId'])`,
        cursor === undefined ? isNotNull(trackId) : gt(trackId, cursor),
        notExists(
          database
            .select({ id: newer.id })
            .from(newer)
            .where(
              and(
                eq(newer.provider, 'spotify'),
                sql`${newer.options}->>'task' = ${task}`,
                eq(sql`${newer.options}->>'trackId'`, trackId),
                sql`(${newer.createdAt}, ${newer.id}) > (${scrapeJob.createdAt}, ${scrapeJob.id})`,
              ),
            ),
        ),
      ),
    )
    .orderBy(trackId)
    .limit(PAGE_SIZE)
}

/** Reconcile saved results only. Each successful link can be skipped on a restart. */
export async function backfillSpotifyTrackSearches(apply = false) {
  const [{ db }, { reconcileSavedSpotifyTrackSearch }] = await Promise.all([
    import('@/lib/db'),
    import('@/services/spotify-track-search-acceptance'),
  ])
  const counts = {
    scanned: 0,
    wouldMatch: 0,
    linked: 0,
    unmatched: 0,
    stale: 0,
  }
  let cursor: string | undefined
  for (;;) {
    const searches = await listSavedSearches(db, cursor)
    const last = searches.at(-1)
    if (!last) break
    for (const search of searches) {
      counts.scanned++
      const result = await reconcileSavedSpotifyTrackSearch(search, {
        dryRun: !apply,
      })
      if (result.status === 'matched') counts[apply ? 'linked' : 'wouldMatch']++
      else counts[result.status]++
    }
    cursor = last.trackId
  }
  return { apply, ...counts }
}

async function main(args: string[]) {
  if (
    args.length > 1 ||
    (args.length === 1 && args[0] !== '--apply' && args[0] !== '--dry-run')
  ) {
    process.stderr.write(
      'Usage: backfill:spotify-track-searches [--dry-run | --apply]\n',
    )
    process.exitCode = 1
    return
  }
  const { db } = await import('@/lib/db')
  try {
    const result = await backfillSpotifyTrackSearches(args[0] === '--apply')
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  } finally {
    await db.$client.end()
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  void main(process.argv.slice(2)).catch(() => {
    process.stderr.write('Spotify track search backfill failed.\n')
    process.exitCode = 1
  })
}
