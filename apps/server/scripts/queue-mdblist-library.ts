import { parseArgs } from 'node:util'
import { writeFile } from 'node:fs/promises'
import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { CreateJobSchema, JobSchema } from '@repo/schemas/job'
import { db } from '@/lib/db'
import { env } from '@/env'

const options = z
  .object({
    run: z.boolean().default(false),
    all: z.boolean().default(false),
    'confirm-broad-run': z.boolean().default(false),
    limit: z.coerce.number().int().min(1).max(5).default(3),
    output: z.string().min(1),
  })
  .parse(
    parseArgs({
      options: {
        run: { type: 'boolean' },
        all: { type: 'boolean' },
        'confirm-broad-run': { type: 'boolean' },
        limit: { type: 'string' },
        output: { type: 'string' },
      },
    }).values,
  )

const CandidateSchema = z.object({
  id: z.string(),
  title: z.string(),
  identified: z.boolean(),
  completed: z.boolean(),
  active: z.boolean(),
})

async function main() {
  if (options.run && options.all && !options['confirm-broad-run'])
    throw new Error('All-library dispatch requires --confirm-broad-run')
  const candidates = z.array(CandidateSchema).parse(
    (
      await db.execute(sql`
    select m.id, m.title,
      exists (select 1 from provider_reference r where r.media_item_id=m.id and
        ((r.reference_type='imdb' and r.external_id ~ '^tt[0-9]+$') or
         (r.reference_type='tmdb' and r.external_id ~ '^[1-9][0-9]*$'))) as identified,
      exists (select 1 from provider_current_state s where s.media_item_id=m.id
        and s.provider='mdblist' and s.last_scraped_at is not null) as completed,
      exists (select 1 from scrape_job_item i join scrape_job j on j.id=i.job_id
        where i.media_item_id=m.id and j.provider='mdblist' and j.status in ('queued','running')
        and i.status in ('queued','running')) as active
    from media_item m where m.media_type='film'
      and m.metadata->>'legacyHidden' is distinct from 'true'
    order by m.title,m.id
  `)
    ).rows,
  )
  const eligible = candidates.filter(
    (row) => row.identified && !row.completed && !row.active,
  )
  const selected = options.all ? eligible : eligible.slice(0, options.limit)
  const jobs: Array<{ id: string; count: number }> = []
  const report = {
    createdAt: new Date().toISOString(),
    total: candidates.length,
    completed: candidates.filter((row) => row.completed).length,
    alreadyActive: candidates.filter((row) => row.active && !row.completed)
      .length,
    missingIdentifiers: candidates.filter(
      (row) => !row.identified && !row.completed,
    ),
    eligible: eligible.length,
    selected: selected.map(({ id, title }) => ({ id, title })),
    jobs,
  }
  await writeFile(options.output, JSON.stringify(report, null, 2), {
    flag: 'wx',
    mode: 0o600,
  })
  if (options.run && selected.length) {
    const email = process.env.INITIAL_USER_EMAIL
    const password = process.env.INITIAL_USER_PASSWORD
    if (!email || !password)
      throw new Error(
        'Initial admin credentials are not configured; use the authenticated UI instead',
      )
    const base = `http://localhost:${env.PORT}`
    const login = await fetch(`${base}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: env.APP_URL },
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(15000),
    })
    if (!login.ok)
      throw new Error(`Admin sign-in failed (HTTP ${login.status})`)
    const cookie = login.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ')
    if (!cookie) throw new Error('Sign-in returned no session cookie')
    for (const selectedItem of selected) {
      const ids = [selectedItem.id]
      const input = CreateJobSchema.parse({
        provider: 'mdblist',
        scope: { mediaType: 'film', mediaItemIds: ids },
        confirmBroadRun: false,
        options: {
          purpose: 'Initial MDBList library enrichment',
          batchId: report.createdAt,
        },
      })
      const response = await fetch(`${base}/api/v1/scrape/jobs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
          Origin: env.APP_URL,
        },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(30000),
      })
      if (!response.ok)
        throw new Error(
          `Job creation stopped (HTTP ${response.status}); inspect existing jobs before resuming`,
        )
      const result = z.object({ data: JobSchema }).parse(await response.json())
      jobs.push({ id: result.data.id, count: ids.length })
      await writeFile(options.output, JSON.stringify(report, null, 2), {
        mode: 0o600,
      })
      process.stdout.write(
        JSON.stringify({ queuedJob: result.data.id, count: ids.length }) + '\n',
      )
    }
  }
  process.stdout.write(
    JSON.stringify({
      total: report.total,
      completed: report.completed,
      alreadyActive: report.alreadyActive,
      missingIdentifiers: report.missingIdentifiers.length,
      eligible: report.eligible,
      selected: selected.length,
      queuedJobs: jobs.length,
    }) + '\n',
  )
}

void main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'Dispatch failed'}\n`,
    )
    process.exit(1)
  })
