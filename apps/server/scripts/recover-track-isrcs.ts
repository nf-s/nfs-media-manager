import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Record ISRCs already held in stored Spotify data. Makes no provider requests. */
async function main(args: string[]) {
  if (
    args.length > 1 ||
    (args.length === 1 && args[0] !== '--apply' && args[0] !== '--dry-run')
  ) {
    process.stderr.write('Usage: recover:track-isrcs [--dry-run | --apply]\n')
    process.exitCode = 1
    return
  }
  const [{ db }, { recoverStoredTrackIsrcs }] = await Promise.all([
    import('@/lib/db'),
    import('@/services/track-isrc-recovery'),
  ])
  try {
    const result = await recoverStoredTrackIsrcs(db, {
      apply: args[0] === '--apply',
    })
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
    process.stderr.write('Track ISRC recovery failed.\n')
    process.exitCode = 1
  })
}
