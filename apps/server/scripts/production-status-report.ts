import { createHash } from 'node:crypto'
import { z } from 'zod'

/**
 * Fixed read-only statements for `production:status`. Every one is a single
 * SELECT over counts, statuses, ages and job ids; none reads library content,
 * job scopes, error messages or account identifiers.
 */
export const statusStatements = {
  jobs: `SELECT provider, options->>'task' AS task,
    count(*) FILTER (WHERE status = 'queued')::int AS queued,
    count(*) FILTER (WHERE status = 'running')::int AS running,
    count(*) FILTER (WHERE status = 'failed'
      AND coalesce(finished_at, updated_at) >= (now() AT TIME ZONE 'UTC') - interval '24 hours')::int AS "failedRecent",
    count(*) FILTER (WHERE status = 'failed')::int AS failed,
    extract(epoch FROM (now() AT TIME ZONE 'UTC')
      - min(created_at) FILTER (WHERE status = 'queued'))::float8 AS "oldestQueuedSeconds",
    extract(epoch FROM (now() AT TIME ZONE 'UTC')
      - min(started_at) FILTER (WHERE status = 'running'))::float8 AS "longestRunningSeconds"
    FROM scrape_job
    WHERE status IN ('queued', 'running', 'failed')
    GROUP BY provider, options->>'task'`,
  oldestQueued: `SELECT id, provider, options->>'task' AS task,
    extract(epoch FROM (now() AT TIME ZONE 'UTC') - created_at)::float8 AS "ageSeconds"
    FROM scrape_job WHERE status = 'queued'
    ORDER BY created_at, id LIMIT 1`,
  recentFailed: `SELECT id, provider, options->>'task' AS task,
    extract(epoch FROM (now() AT TIME ZONE 'UTC') - coalesce(finished_at, updated_at))::float8 AS "ageSeconds"
    FROM scrape_job WHERE status = 'failed'
    ORDER BY coalesce(finished_at, updated_at) DESC, id DESC LIMIT 5`,
  providers: `SELECT provider, halted,
    extract(epoch FROM cooldown_until - (now() AT TIME ZONE 'UTC'))::float8 AS "cooldownSeconds"
    FROM provider_request_state
    WHERE halted OR cooldown_until > (now() AT TIME ZONE 'UTC')
    ORDER BY provider`,
  syncs: `SELECT 'subscription' AS kind, provider, status, count(*)::int AS count,
    extract(epoch FROM min(resume_after) - (now() AT TIME ZONE 'UTC'))::float8 AS "resumeSeconds"
    FROM subscription_sync GROUP BY provider, status
    UNION ALL
    SELECT 'lastfm', 'lastfm', status, count(*)::int, NULL
    FROM lastfm_sync GROUP BY status
    ORDER BY kind, provider, status`,
  imports: `SELECT status::text AS status, count(*)::int AS count
    FROM library_import WHERE status IN ('queued', 'running')
    GROUP BY status ORDER BY status`,
} as const

const seconds = z.number().nullable()
const task = z.string().nullable()

export const statusRowSchemas = {
  jobs: z.array(
    z.object({
      provider: z.string(),
      task,
      queued: z.number().int(),
      running: z.number().int(),
      failedRecent: z.number().int(),
      failed: z.number().int(),
      oldestQueuedSeconds: seconds,
      longestRunningSeconds: seconds,
    }),
  ),
  oldestQueued: z.array(
    z.object({
      id: z.string(),
      provider: z.string(),
      task,
      ageSeconds: z.number(),
    }),
  ),
  recentFailed: z.array(
    z.object({
      id: z.string(),
      provider: z.string(),
      task,
      ageSeconds: z.number(),
    }),
  ),
  providers: z.array(
    z.object({
      provider: z.string(),
      halted: z.boolean(),
      cooldownSeconds: seconds,
    }),
  ),
  syncs: z.array(
    z.object({
      kind: z.enum(['subscription', 'lastfm']),
      provider: z.string(),
      status: z.string(),
      count: z.number().int(),
      resumeSeconds: seconds,
    }),
  ),
  imports: z.array(z.object({ status: z.string(), count: z.number().int() })),
}

export type DatabaseStatus = {
  [Key in keyof typeof statusRowSchemas]: z.infer<
    (typeof statusRowSchemas)[Key]
  >
}

export interface WorkerVersion {
  versionId: string
  percentage: number
  commit: string | null
  createdOn: string | null
}

export interface WorkerCommitContext {
  subject: string | null
  /** Commits on the compared ref after the served commit; null when unknown. */
  behind: number | null
  matches: boolean
}

export interface WorkerStatus {
  label: string
  deployedOn: string | null
  versions: Array<WorkerVersion & { context: WorkerCommitContext | null }>
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 6)
}

/**
 * Providers built into this repository keep their names. Any other provider is
 * a private plugin, so its name and task names are replaced by stable hashes.
 */
export function jobTypeLabel(
  provider: string,
  taskName: string | null,
  publicProviders: ReadonlySet<string>,
): string {
  if (!publicProviders.has(provider))
    return `private-${shortHash(provider)} / ${taskName === null ? 'items' : `task-${shortHash(taskName)}`}`
  return `${provider} / ${taskName ?? 'items'}`
}

export function providerLabel(
  provider: string,
  publicProviders: ReadonlySet<string>,
): string {
  return publicProviders.has(provider)
    ? provider
    : `private-${shortHash(provider)}`
}

export function formatDuration(value: number | null): string {
  if (value === null) return '-'
  const total = Math.max(0, Math.round(value))
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h ${minutes % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

function table(header: string[], rows: string[][]): string[] {
  const widths = header.map((cell, column) =>
    Math.max(cell.length, ...rows.map((row) => (row[column] ?? '').length)),
  )
  const line = (row: string[]) =>
    row
      .map((cell, column) =>
        column === 0
          ? cell.padEnd(widths[column] ?? 0)
          : cell.padStart(widths[column] ?? 0),
      )
      .join('  ')
      .trimEnd()
  return [line(header), ...rows.map(line)]
}

function timestamp(value: string | null, now: Date): string {
  if (value === null) return 'unknown time'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'unknown time'
  const utc = date.toISOString().slice(0, 16).replace('T', ' ')
  return `${utc} UTC, ${formatDuration((now.getTime() - date.getTime()) / 1000)} ago`
}

export function formatWorkers(
  workers: WorkerStatus[],
  ref: string,
  now: Date,
): string[] {
  const lines = ['Workers']
  for (const worker of workers) {
    lines.push(
      `  ${worker.label}: deployed ${timestamp(worker.deployedOn, now)}`,
    )
    for (const version of worker.versions) {
      const commit = version.commit ?? 'untagged version'
      const context = version.context
      const relation =
        context === null
          ? 'commit not in this checkout'
          : context.matches
            ? `same as ${ref}`
            : context.behind === null
              ? `not an ancestor of ${ref}`
              : `${context.behind} commit${context.behind === 1 ? '' : 's'} behind ${ref}`
      lines.push(
        `    ${version.percentage}%  ${commit}  ${relation}${context?.subject ? `  ${context.subject}` : ''}`,
      )
    }
  }
  return lines
}

export function formatDatabase(
  status: DatabaseStatus,
  publicProviders: ReadonlySet<string>,
): string[] {
  const lines = ['Jobs (scrape_job)']
  const jobs = [...status.jobs]
    .map((row) => ({
      ...row,
      label: jobTypeLabel(row.provider, row.task, publicProviders),
    }))
    .sort((left, right) => left.label.localeCompare(right.label))
  if (jobs.length === 0) lines.push('  No queued, running or failed jobs.')
  else
    lines.push(
      ...table(
        [
          'type',
          'queued',
          'oldest queued',
          'running',
          'longest running',
          'failed 24h',
          'failed all',
        ],
        jobs.map((row) => [
          row.label,
          String(row.queued),
          formatDuration(row.oldestQueuedSeconds),
          String(row.running),
          formatDuration(row.longestRunningSeconds),
          String(row.failedRecent),
          String(row.failed),
        ]),
      ).map((line) => `  ${line}`),
    )
  const total = (key: 'queued' | 'running' | 'failedRecent' | 'failed') =>
    jobs.reduce((sum, row) => sum + row[key], 0)
  lines.push(
    `  Total: ${total('queued')} queued, ${total('running')} running, ${total('failedRecent')} failed in 24h, ${total('failed')} failed in all`,
  )
  const oldest = status.oldestQueued[0]
  lines.push(
    oldest
      ? `  Oldest queued: ${oldest.id} (${jobTypeLabel(oldest.provider, oldest.task, publicProviders)}), ${formatDuration(oldest.ageSeconds)}`
      : '  Oldest queued: none',
  )
  if (status.recentFailed.length) {
    lines.push('  Latest failed:')
    for (const row of status.recentFailed)
      lines.push(
        `    ${row.id}  ${jobTypeLabel(row.provider, row.task, publicProviders)}  ${formatDuration(row.ageSeconds)} ago`,
      )
  }
  lines.push('', 'Paused or blocked providers (provider_request_state)')
  if (status.providers.length === 0)
    lines.push('  None halted or cooling down.')
  for (const row of status.providers)
    lines.push(
      `  ${providerLabel(row.provider, publicProviders)}: ${row.halted ? 'halted' : `cooling down for ${formatDuration(row.cooldownSeconds)}`}`,
    )
  lines.push('', 'Syncs')
  if (status.syncs.length === 0) lines.push('  None.')
  for (const row of status.syncs) {
    const name =
      row.kind === 'lastfm'
        ? 'Last.fm scrobbles'
        : `subscription ${providerLabel(row.provider, publicProviders)}`
    const resume =
      row.status === 'paused' && row.resumeSeconds !== null
        ? `, resumes in ${formatDuration(row.resumeSeconds)}`
        : ''
    lines.push(`  ${name}: ${row.count} ${row.status}${resume}`)
  }
  lines.push('', 'Library imports')
  lines.push(
    status.imports.length
      ? `  ${status.imports.map((row) => `${row.count} ${row.status}`).join(', ')}`
      : '  None queued or running.',
  )
  return lines
}
