import { parseArgs } from 'node:util'
import { db } from '@/lib/db'
import {
  NonMusicBackfillInput,
  runNonMusicCatalogBackfill,
} from '@/services/nonmusic-catalog-backfill'

async function main() {
  try {
    const { values } = parseArgs({
      options: {
        family: { type: 'string' },
        after: { type: 'string' },
        limit: { type: 'string' },
        apply: { type: 'boolean', default: false },
      },
    })
    const input = NonMusicBackfillInput.parse({
      family: values.family,
      after: values.after,
      limit: values.limit === undefined ? undefined : Number(values.limit),
    })
    const report = await runNonMusicCatalogBackfill(input, values.apply)
    process.stdout.write(JSON.stringify(report) + '\n')
  } catch {
    process.stderr.write(
      'Catalog backfill failed. Verify the selected family, cursor, batch size and database.\n',
    )
    process.exitCode = 1
  } finally {
    await db.$client.end()
  }
}

void main()
