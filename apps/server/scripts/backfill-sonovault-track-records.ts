import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Keeps each matched Sonovault track's own record on its lookup row, read
 * from the stored response. Makes no Sonovault requests.
 */
async function main(args: string[]) {
  if (
    args.length > 1 ||
    (args.length === 1 && args[0] !== '--apply' && args[0] !== '--dry-run')
  ) {
    process.stderr.write(
      'Usage: backfill:sonovault-track-records [--dry-run | --apply]\n',
    )
    process.exitCode = 1
    return
  }
  const [{ db }, { backfillSonovaultTrackRecords }] = await Promise.all([
    import('@/lib/db'),
    import('@/services/sonovault-track-records'),
  ])
  try {
    const result = await backfillSonovaultTrackRecords(db, {
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
    process.stderr.write('Sonovault track record backfill failed.\n')
    process.exitCode = 1
  })
}
