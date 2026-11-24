import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

/** Records codes already held in stored Spotify evidence. */
async function main(args: string[]) {
  let values
  try {
    values = parseArgs({
      args,
      options: {
        apply: { type: 'boolean' },
        'dry-run': { type: 'boolean' },
        'album-upcs': { type: 'boolean' },
        limit: { type: 'string' },
        after: { type: 'string' },
      },
    }).values
  } catch {
    values = undefined
  }
  const limit = values?.limit === undefined ? undefined : Number(values.limit)
  if (
    !values ||
    (values.apply && values['dry-run']) ||
    (limit !== undefined &&
      (!Number.isInteger(limit) || limit < 1 || limit > 500))
  ) {
    process.stderr.write(
      'Usage: recover:track-isrcs [--dry-run | --apply] [--album-upcs] [--limit 1..500] [--after CURSOR]\n',
    )
    process.exitCode = 1
    return
  }
  const { db } = await import('@/lib/db')
  const params = {
    apply: values.apply,
    limit: limit ?? (values.after ? 100 : undefined),
    after: values.after,
  }
  try {
    const result = values['album-upcs']
      ? await (
          await import('@/services/spotify-album-upc-recovery')
        ).recoverStoredSpotifyAlbumUpcs(db, params)
      : await (
          await import('@/services/track-isrc-recovery')
        ).recoverStoredTrackIsrcs(db, params)
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
    process.stderr.write('Spotify code recovery failed.\n')
    process.exitCode = 1
  })
}
