import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { z } from 'zod'

const OptionsSchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(1000).default(1),
    apply: z.boolean().default(false),
    'confirm-broad-run': z.boolean().default(false),
  })
  .refine(
    (options) =>
      !options.apply || options.limit <= 5 || options['confirm-broad-run'],
    'Looking up more than five tracks needs --confirm-broad-run',
  )

/**
 * Queues Sonovault lookups by artist and title (SONO-23) for up to `limit`
 * tracks with neither a Spotify ID nor an ISRC, the most scrobbled first,
 * 100 to a job, for the one library user. Without --apply it only counts.
 * Prints counts and job IDs only.
 */
async function main(args: string[]) {
  const options = OptionsSchema.parse(
    parseArgs({
      args,
      options: {
        limit: { type: 'string' },
        apply: { type: 'boolean' },
        'confirm-broad-run': { type: 'boolean' },
      },
    }).values,
  )
  const [{ db }, { sql }, service] = await Promise.all([
    import('@/lib/db'),
    import('drizzle-orm'),
    import('@/services/sonovault-track-candidates'),
  ])
  try {
    const trackIds = await service.listSonovaultTrackNameLookupTargets(
      options.limit,
    )
    if (!options.apply) {
      process.stdout.write(
        JSON.stringify({ apply: false, due: trackIds.length }) + '\n',
      )
      return
    }
    const users = z
      .array(z.object({ id: z.string() }))
      .parse((await db.execute(sql`select id from "user" limit 2`)).rows)
    const [user] = users
    if (!user || users.length > 1)
      throw new Error('Expected exactly one library user')
    const result = trackIds.length
      ? await service.queueSonovaultTrackNameLookups(
          { trackIds, confirmBroadRun: trackIds.length > 5 },
          user.id,
        )
      : null
    process.stdout.write(
      JSON.stringify({
        apply: true,
        due: trackIds.length,
        queued: result?.queued ?? 0,
        skipped: result?.skipped ?? 0,
        batchId: result?.batchId ?? null,
      }) + '\n',
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
    process.stderr.write(
      `Queueing Sonovault lookups failed: ${error instanceof Error ? error.message : 'unknown error'}\n`,
    )
    process.exitCode = 1
  })
}
