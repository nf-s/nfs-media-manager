import { db } from '@/lib/db'
import { repairTidalSimilarReferences } from '@/services/tidal-similar-reference-repair'

async function main() {
  const [mode = '--dry-run', ...rest] = process.argv.slice(2)
  if (rest.length || !['--apply', '--dry-run'].includes(mode))
    throw new Error('Expected --dry-run or --apply')
  const result = await repairTidalSimilarReferences(db, mode === '--apply')
  process.stdout.write(JSON.stringify({ mode, ...result }) + '\n')
}

void main()
  .catch(() => {
    process.stderr.write('Similar reference repair failed.\n')
    process.exitCode = 1
  })
  .finally(() => db.$client.end())
