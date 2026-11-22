// Fails when the commit's migration journal holds entries newer than the last
// migration applied to the production database. Drizzle's migrator applies
// exactly those entries, so they are what the release would need first.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(
  new URL('../../apps/server/package.json', import.meta.url),
)
const pg = require('pg')
const { z } = require('zod')

function fail(message) {
  process.stderr.write(`::error::${message}\n`)
  process.exit(1)
}

const journal = z
  .object({
    entries: z.array(z.object({ when: z.number().int(), tag: z.string() })),
  })
  .parse(
    JSON.parse(
      readFileSync(
        new URL(
          '../../apps/server/drizzle/meta/_journal.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  )

const connectionString = z
  .string()
  .min(1)
  .safeParse(process.env.MIGRATION_CHECK_DATABASE_URL)
if (!connectionString.success)
  fail('The migration check database URL is not configured.')

const client = new pg.Client({
  connectionString: connectionString.data,
  connectionTimeoutMillis: 15_000,
  statement_timeout: 15_000,
  application_name: 'release-migration-check',
})

let newest
try {
  await client.connect()
  const result = await client.query(
    'select max(created_at)::text as newest from drizzle.__drizzle_migrations',
  )
  newest = z
    .array(z.object({ newest: z.string().regex(/^\d+$/).nullable() }))
    .length(1)
    .parse(result.rows)[0].newest
} catch (error) {
  // Never print driver errors: they can echo connection details.
  const code = z
    .object({ code: z.string().regex(/^[A-Z0-9_]{1,12}$/) })
    .safeParse(error)
  fail(
    `Could not read the applied migrations from the production database${
      code.success ? ` (${code.data.code})` : ''
    }.`,
  )
} finally {
  await client.end().catch(() => undefined)
}

const applied = newest === null ? -1 : Number(newest)
const pending = journal.entries.filter((entry) => entry.when > applied)
if (pending.length) {
  fail(
    `Production has not applied ${pending.length} migration(s) in this commit: ${pending
      .map((entry) => entry.tag)
      .join(', ')}. Apply them, then re-run this job. Nothing was published.`,
  )
}
process.stdout.write(
  `Production has applied every migration in this commit (${journal.entries.length} in the journal).\n`,
)
