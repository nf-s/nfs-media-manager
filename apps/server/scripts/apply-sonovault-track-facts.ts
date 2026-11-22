import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Apply the tempo and key held in stored Sonovault responses. Makes no provider requests. */
async function main(args: string[]) {
  if (
    args.length > 1 ||
    (args.length === 1 && args[0] !== '--apply' && args[0] !== '--dry-run')
  ) {
    process.stderr.write(
      'Usage: apply:sonovault-track-facts [--dry-run | --apply]\n',
    )
    process.exitCode = 1
    return
  }
  const [{ db }, { applyStoredSonovaultTrackFacts }] = await Promise.all([
    import('@/lib/db'),
    import('@/services/track-facts'),
  ])
  try {
    const result = await applyStoredSonovaultTrackFacts(db, {
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
    process.stderr.write('Sonovault track facts failed.\n')
    process.exitCode = 1
  })
}
