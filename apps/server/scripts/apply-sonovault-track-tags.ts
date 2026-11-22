import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Record the genres and subgenres of each library track's stored Sonovault
 * record as its tags (TTAG-07). Dry run unless --apply; makes no requests.
 */
async function main(args: string[]) {
  if (
    args.length > 1 ||
    (args.length === 1 && args[0] !== '--apply' && args[0] !== '--dry-run')
  ) {
    process.stderr.write(
      'Usage: apply:sonovault-track-tags [--dry-run | --apply]\n',
    )
    process.exitCode = 1
    return
  }
  const [{ db }, { applyStoredSonovaultTrackTags }] = await Promise.all([
    import('@/lib/db'),
    import('@/services/track-tags'),
  ])
  try {
    const result = await applyStoredSonovaultTrackTags(db, {
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
    process.stderr.write('Sonovault track tags failed.\n')
    process.exitCode = 1
  })
}
