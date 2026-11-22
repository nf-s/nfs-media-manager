import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, promisify } from 'node:util'
import { parse } from 'dotenv'
import type pg from 'pg'
import { z } from 'zod'
import { loadWorkspaceEnv } from '../src/lib/load-workspace-env'
import { getBuiltinProviderCatalog } from '../src/lib/provider-catalog'
import { connection } from './cloud-helpers'
import { databaseClient } from './cloud-database'
import {
  type DatabaseStatus,
  formatDatabase,
  formatWorkers,
  statusRowSchemas,
  statusStatements,
  type WorkerStatus,
} from './production-status-report'

// Read-only production status: Worker commits, job queue and syncs.
// See docs/production-operations.md#production-status.

const run = promisify(execFile)
const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url))
const wranglerBinary = fileURLToPath(
  new URL('../../../node_modules/.bin/wrangler', import.meta.url),
)
const workers = [
  { label: 'API', directory: fileURLToPath(new URL('..', import.meta.url)) },
  {
    label: 'web',
    directory: fileURLToPath(new URL('../../web', import.meta.url)),
  },
]

export function parseStatusArguments(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      'env-file': { type: 'string', multiple: true, default: [] },
      'database-url-env': { type: 'string', default: 'DATABASE_URL_UNPOOLED' },
      ref: { type: 'string', default: 'HEAD' },
    },
  })
  return {
    envFiles: values['env-file'],
    databaseUrlVariable: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]*$/)
      .parse(values['database-url-env']),
    ref: z
      .string()
      .regex(/^[A-Za-z0-9_./~^-]+$/)
      .parse(values.ref),
  }
}

/**
 * The workspace env as every server script loads it, then each named file in
 * order. Named files are read into the returned settings only, never into
 * process.env, so production values cannot reach other code in this process.
 */
async function loadSettings(
  envFiles: string[],
): Promise<Record<string, string | undefined>> {
  loadWorkspaceEnv()
  const settings: Record<string, string | undefined> = { ...process.env }
  // pnpm runs the package script in apps/server; resolve from the caller's directory.
  const base = process.env['INIT_CWD'] ?? process.cwd()
  for (const path of envFiles)
    Object.assign(settings, parse(await readFile(resolve(base, path), 'utf8')))
  return settings
}

const deploymentSchema = z.object({
  created_on: z.string().nullable().optional(),
  versions: z.array(
    z.object({ version_id: z.string(), percentage: z.number() }),
  ),
})
const versionSchema = z.object({
  annotations: z.record(z.string(), z.string()).optional(),
  metadata: z.object({ created_on: z.string().optional() }).optional(),
})

async function wrangler(
  directory: string,
  args:
    | ['deployments', 'status', '--json']
    | ['versions', 'view', string, '--json'],
  settings: Record<string, string | undefined>,
): Promise<unknown> {
  const accountId = z
    .string()
    .regex(/^[a-f0-9]{32}$/)
    .parse(settings['CLOUDFLARE_ACCOUNT_ID'])
  const token = settings['CLOUDFLARE_API_TOKEN']
  const { stdout } = await run(wranglerBinary, args, {
    cwd: directory,
    env: {
      ...process.env,
      CLOUDFLARE_ACCOUNT_ID: accountId,
      ...(token ? { CLOUDFLARE_API_TOKEN: token } : {}),
      WRANGLER_SEND_METRICS: 'false',
      WRANGLER_SEND_ERROR_REPORTS: 'false',
    },
    maxBuffer: 4 * 1024 * 1024,
    shell: false,
    timeout: 60000,
  })
  return JSON.parse(stdout)
}

async function git(args: string[]): Promise<string | null> {
  try {
    const { stdout } = await run('git', args, {
      cwd: repositoryRoot,
      shell: false,
      timeout: 15000,
    })
    return stdout.trim()
  } catch {
    return null
  }
}

async function commitContext(commit: string, ref: string) {
  const subject = await git(['log', '-1', '--format=%s', `${commit}^{commit}`])
  if (subject === null) return null
  const target = await git(['rev-parse', '--verify', `${ref}^{commit}`])
  if (target === null) return { subject, behind: null, matches: false }
  if (target === commit) return { subject, behind: 0, matches: true }
  const ancestor =
    (await git(['merge-base', '--is-ancestor', commit, target])) !== null
  const behind = ancestor
    ? Number(await git(['rev-list', '--count', `${commit}..${target}`]))
    : null
  return { subject, behind, matches: false }
}

async function readWorker(
  worker: (typeof workers)[number],
  settings: Record<string, string | undefined>,
  ref: string,
): Promise<WorkerStatus> {
  const deployment = deploymentSchema.parse(
    await wrangler(
      worker.directory,
      ['deployments', 'status', '--json'],
      settings,
    ),
  )
  const versions = []
  for (const version of deployment.versions) {
    const view = versionSchema.parse(
      await wrangler(
        worker.directory,
        ['versions', 'view', version.version_id, '--json'],
        settings,
      ),
    )
    const tag = view.annotations?.['workers/tag'] ?? null
    const commit = tag !== null && /^[a-f0-9]{40}$/.test(tag) ? tag : null
    versions.push({
      versionId: version.version_id,
      percentage: version.percentage,
      commit,
      createdOn: view.metadata?.created_on ?? null,
      context: commit === null ? null : await commitContext(commit, ref),
    })
  }
  return {
    label: worker.label,
    deployedOn: deployment.created_on ?? null,
    versions,
  }
}

async function rows(
  client: pg.Client,
  key: keyof typeof statusStatements,
): Promise<unknown[]> {
  return (await client.query(statusStatements[key])).rows
}

export async function readDatabase(raw: string): Promise<DatabaseStatus> {
  // Read-only twice over: the session default and an explicit read-only
  // transaction that is rolled back. The statements are fixed SELECTs.
  const client = databaseClient(connection(raw), 'production-status')
  await client.connect()
  try {
    await client.query('START TRANSACTION READ ONLY')
    const mode = await client.query('SHOW transaction_read_only')
    if (
      !z
        .array(z.object({ transaction_read_only: z.literal('on') }))
        .length(1)
        .safeParse(mode.rows).success
    )
      throw new Error('The status session is not read-only')
    await client.query("SET LOCAL statement_timeout = '20s'")
    return {
      jobs: statusRowSchemas.jobs.parse(await rows(client, 'jobs')),
      oldestQueued: statusRowSchemas.oldestQueued.parse(
        await rows(client, 'oldestQueued'),
      ),
      recentFailed: statusRowSchemas.recentFailed.parse(
        await rows(client, 'recentFailed'),
      ),
      providers: statusRowSchemas.providers.parse(
        await rows(client, 'providers'),
      ),
      syncs: statusRowSchemas.syncs.parse(await rows(client, 'syncs')),
      imports: statusRowSchemas.imports.parse(await rows(client, 'imports')),
    }
  } finally {
    await client.query('ROLLBACK').catch(() => undefined)
    await client.end()
  }
}

async function main(): Promise<void> {
  const options = parseStatusArguments(process.argv.slice(2))
  const settings = await loadSettings(options.envFiles)
  const now = new Date()
  const output: string[] = [`Production status at ${now.toISOString()}`, '']
  let failed = false

  const workerStatus: WorkerStatus[] = []
  const unread: string[] = []
  for (const worker of workers) {
    try {
      workerStatus.push(await readWorker(worker, settings, options.ref))
    } catch {
      failed = true
      unread.push(
        `  ${worker.label}: not read. Check the Wrangler sign-in and CLOUDFLARE_ACCOUNT_ID.`,
      )
    }
  }
  output.push(...formatWorkers(workerStatus, options.ref, now), ...unread, '')

  const databaseUrl = settings[options.databaseUrlVariable]
  if (!databaseUrl) {
    failed = true
    output.push(
      `Database: not read. ${options.databaseUrlVariable} is not set.`,
    )
  } else {
    try {
      const publicProviders = new Set(
        getBuiltinProviderCatalog().map((entry) => entry.id),
      )
      output.push(
        ...formatDatabase(await readDatabase(databaseUrl), publicProviders),
      )
    } catch (error) {
      failed = true
      output.push(
        `Database: not read (${error instanceof z.ZodError ? 'unexpected result shape' : 'connection or query failed'}). No connection details printed.`,
      )
    }
  }

  output.push(
    '',
    'Slowest routes: not read. Route timings are api.request events in Workers Logs; see docs/query-performance.md.',
  )
  process.stdout.write(`${output.join('\n')}\n`)
  if (failed) process.exitCode = 1
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    process.stderr.write(
      `Status failed (${error instanceof z.ZodError ? 'invalid arguments or settings' : 'error'}); no connection details printed.\n`,
    )
    process.exitCode = 1
  })
}
