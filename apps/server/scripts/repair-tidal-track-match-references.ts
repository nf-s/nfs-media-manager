import { parseArgs } from 'node:util'
import { z } from 'zod'
import { db } from '@/lib/db'
import {
  repairStoredTidalCodeReferences,
  repairTidalTrackMatchReferences,
} from '@/services/tidal-track-match'

async function main() {
  const { values } = parseArgs({
    options: {
      'dry-run': { type: 'boolean' },
      apply: { type: 'boolean' },
      limit: { type: 'string' },
    },
  })
  if (values['dry-run'] && values.apply)
    throw new Error('Specify either --dry-run or --apply')
  const apply = values.apply ?? false
  const limit = z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(25)
    .parse(values.limit)
  const codes = await repairStoredTidalCodeReferences({ apply, limit })
  const matches = await repairTidalTrackMatchReferences({ apply, limit })
  process.stdout.write(JSON.stringify({ apply, codes, matches }) + '\n')
}

void main()
  .catch(() => {
    process.stderr.write('TIDAL track match repair failed.\n')
    process.exitCode = 1
  })
  .finally(() => db.$client.end())
