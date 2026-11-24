import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { z } from 'zod'

const OptionsSchema = z
  .object({
    queue: z.coerce.number().int().min(1).max(5000).optional(),
    album: z.string().trim().min(1).max(200).optional(),
    'confirm-broad-run': z.boolean().default(false),
  })
  .refine((options) => !(options.queue && options.album), {
    message: 'Use --queue or --album, not both',
  })
  .refine(
    (options) => (options.queue ?? 0) <= 20 || options['confirm-broad-run'],
    { message: 'Queueing more than 20 albums needs --confirm-broad-run' },
  )

/**
 * Counts library albums with a Spotify album ID by their Sonovault album
 * lookup, and queues lookups for the next due ones. Prints counts and the
 * batch ID only. Credits are spent when the jobs run, not when they queue.
 */
async function main(args: string[]) {
  const options = OptionsSchema.parse(
    parseArgs({
      args,
      options: {
        queue: { type: 'string' },
        album: { type: 'string' },
        'confirm-broad-run': { type: 'boolean' },
      },
    }).values,
  )
  const [{ db }, { sql }, albums, tracks] = await Promise.all([
    import('@/lib/db'),
    import('drizzle-orm'),
    import('@/services/sonovault-album-lookup'),
    import('@/services/sonovault-track-lookup'),
  ])
  try {
    const rows = z.array(z.object({ id: z.string(), state: z.string() })).parse(
      (
        await db.execute(sql`
          select m.id,
            case
              when exists (select 1 from scrape_job j where j.provider = 'sonovault'
                and j.options->>'task' = 'sonovault-album-lookup'
                and j.status in ('queued', 'running') and j.options->>'albumId' = m.id) then 'active'
              when l.status = 'confirmed' then 'confirmed'
              when l.status = 'not_found' and l.looked_up_at >= (now() at time zone 'UTC') - interval '30 days' then 'not_found'
              else 'due'
            end as state
          from media_item m
          left join sonovault_album_lookup l on l.media_item_id = m.id
          where m.media_type = 'album'
            and m.in_library
            and m.metadata->>'legacyHidden' is distinct from 'true'
            and exists (select 1 from provider_reference r where r.media_item_id = m.id
              and r.provider = 'spotify' and r.reference_type = 'album')
            and exists (select 1 from track t where t.album_media_item_id = m.id)
          order by m.id`)
      ).rows,
    )
    const counts = Object.fromEntries(
      ['due', 'active', 'confirmed', 'not_found'].map((state) => [
        state,
        rows.filter((row) => row.state === state).length,
      ]),
    )
    const credits = await tracks.reportedSonovaultCredits(db, new Date())
    const selected = options.album
      ? [options.album]
      : rows
          .filter((row) => row.state === 'due')
          .slice(0, options.queue ?? 0)
          .map(({ id }) => id)
    let batchId: string | null = null
    let queued = 0
    for (let start = 0; start < selected.length; start += 100) {
      const result = await albums.queueSonovaultAlbumLookups(
        {
          albumIds: selected.slice(start, start + 100),
          ...(batchId ? { batchId } : {}),
          confirmBroadRun: true,
        },
        null,
      )
      batchId = result.batchId
      queued += result.queued
    }
    process.stdout.write(
      JSON.stringify(
        {
          albums: rows.length,
          ...counts,
          creditsRemaining: credits?.current ? credits.remaining : null,
          creditsReportedAt: credits?.reportedAt.toISOString() ?? null,
          queued,
          batchId,
        },
        null,
        2,
      ) + '\n',
    )
  } finally {
    await db.$client.end()
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  void main(process.argv.slice(2)).catch((error: unknown) => {
    // Names the cause without connection details or library contents.
    const Coded = z.object({ code: z.string().max(10) })
    const code = Coded.or(
      z.object({ cause: Coded }).transform(({ cause }) => cause),
    ).safeParse(error)
    const reason =
      error instanceof z.ZodError
        ? `: ${error.issues.map((issue) => issue.message).join('; ')}`
        : code.success
          ? ` (database error ${code.data.code}).`
          : '.'
    process.stderr.write(`Queueing Sonovault album lookups failed${reason}\n`)
    process.exitCode = 1
  })
}
