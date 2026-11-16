import { and, eq, inArray, lt, sql } from 'drizzle-orm'
import type { MediaProviderPlugin } from '@repo/media-plugin-sdk'
import type { Job } from '@repo/schemas/job'
import type {
  ProviderRequestBudget,
  ProviderWaiting,
} from '@repo/schemas/provider'
import { db } from '@/lib/db'
import { env } from '@/env'
import { getScrapePlugin } from '@/plugins/registry'
import {
  providerRequestEvent,
  providerRequestState,
  scrapeJob,
} from '@/schemas/db'
import {
  DAY_MS,
  HOUR_MS,
  fixedRequestWindow,
  hourlyBudget,
  requestBudgetWindow,
} from '@/lib/request-policy'
import { effectiveRequestBudget } from '@/services/provider-requests'
import {
  readProviderDispatchStatus,
  type ProviderDispatchStatus,
} from '@/services/dispatch-status'

export interface ProviderBudgetUsage {
  used: number
  limit: number
  period: ProviderRequestBudget['period']
  resetsAt: string
}

/** What decides whether a provider's queued jobs can start, read once per response. */
export interface ProviderWaitState {
  provider: string
  plugin: MediaProviderPlugin | null
  now: number
  /** A block that holds every queued job of the provider. */
  block: ProviderWaiting | null
  halted: boolean
  cooldownUntil: number | null
  running: number
  concurrency: number | null
  nextAllowedAt: number | null
  budget: ProviderBudgetUsage | null
  dispatch: ProviderDispatchStatus | null
}

const iso = (time: number) => new Date(time).toISOString()

function waiting(
  reason: ProviderWaiting['reason'],
  detail: string,
  until: number | null = null,
): ProviderWaiting {
  return { reason, until: until === null ? null : iso(until), detail }
}

/** Running jobs per provider, in one grouped query. */
export async function countRunningJobs(providers: string[]) {
  if (!providers.length) return new Map<string, number>()
  const rows = await db
    .select({
      provider: scrapeJob.provider,
      running: sql<number>`count(*)::integer`,
    })
    .from(scrapeJob)
    .where(
      and(
        eq(scrapeJob.status, 'running'),
        inArray(scrapeJob.provider, providers),
      ),
    )
    .groupBy(scrapeJob.provider)
  return new Map(rows.map((row) => [row.provider, row.running]))
}

interface RequestUsage {
  provider: string
  day: number
  hour: number
  hourOldest: number | null
  fixedReads: number
  fixedWrites: number
}

// Mirrors the request gate's budget and fixed-window accounting for several
// providers in one grouped query over the durable request log.
async function readRequestUsage(
  providers: {
    provider: string
    budget: ProviderRequestBudget | undefined
    fixedFrom: number | null
    fixedResetsAt: number | null
  }[],
  now: number,
): Promise<Map<string, RequestUsage>> {
  const counted = providers.filter(
    (entry) => entry.budget !== undefined || entry.fixedFrom !== null,
  )
  if (!counted.length) return new Map<string, RequestUsage>()
  const dayFrom = requestBudgetWindow('day', now).from
  const hourFrom = now - HOUR_MS
  const fixed = counted.flatMap((entry) =>
    entry.fixedFrom !== null && entry.fixedResetsAt !== null
      ? [
          {
            provider: entry.provider,
            from: entry.fixedFrom,
            resetsAt: entry.fixedResetsAt,
          },
        ]
      : [],
  )
  const earliest = Math.min(
    dayFrom,
    hourFrom,
    ...fixed.map((entry) => entry.from),
  )
  const timestamp = (time: number) => sql`${iso(time)}::timestamp`
  const fixedBound = (bound: 'from' | 'resetsAt') =>
    fixed.length
      ? sql`case ${providerRequestEvent.provider} ${sql.join(
          fixed.map(
            (entry) =>
              sql`when ${entry.provider} then ${timestamp(entry[bound])}`,
          ),
          sql` `,
        )} end`
      : sql`null::timestamp`
  const inFixedWindow = sql`${providerRequestEvent.requestedAt} >= ${fixedBound('from')}
    and ${providerRequestEvent.requestedAt} < ${fixedBound('resetsAt')}`
  const rows = await db
    .select({
      provider: providerRequestEvent.provider,
      day: sql<number>`count(*) filter (where ${providerRequestEvent.requestedAt} >= ${timestamp(dayFrom)})::integer`,
      hour: sql<number>`count(*) filter (where ${providerRequestEvent.requestedAt} > ${timestamp(hourFrom)})::integer`,
      hourOldest: sql<
        number | null
      >`(extract(epoch from min(${providerRequestEvent.requestedAt}) filter (where ${providerRequestEvent.requestedAt} > ${timestamp(hourFrom)})) * 1000)::float8`,
      fixedReads: sql<number>`count(*) filter (where ${providerRequestEvent.requestClass} = 'read' and ${inFixedWindow})::integer`,
      fixedWrites: sql<number>`count(*) filter (where ${providerRequestEvent.requestClass} <> 'read' and ${inFixedWindow})::integer`,
    })
    .from(providerRequestEvent)
    .where(
      and(
        inArray(
          providerRequestEvent.provider,
          counted.map((entry) => entry.provider),
        ),
        sql`${providerRequestEvent.requestedAt} >= ${timestamp(earliest)}`,
        lt(providerRequestEvent.requestedAt, new Date(now + 1)),
      ),
    )
    .groupBy(providerRequestEvent.provider)
  return new Map(rows.map((row) => [row.provider, row]))
}

function budgetUsage(
  budget: ProviderRequestBudget,
  usage: RequestUsage | undefined,
  now: number,
): ProviderBudgetUsage {
  if (budget.period === 'day')
    return {
      used: usage?.day ?? 0,
      limit: budget.limit,
      period: 'day',
      resetsAt: iso(requestBudgetWindow('day', now).from + DAY_MS),
    }
  return {
    used: usage?.hour ?? 0,
    limit: budget.limit,
    period: 'hour',
    resetsAt: iso(
      usage && usage.hourOldest !== null
        ? usage.hourOldest + HOUR_MS
        : now + HOUR_MS,
    ),
  }
}

function providerBlock(
  state: Omit<ProviderWaitState, 'block'>,
  lastError: string | null,
  requests: number[],
  usage: RequestUsage | undefined,
  fixedResetsAt: number | null,
): ProviderWaiting | null {
  const { plugin, dispatch, now } = state
  if (state.halted)
    return waiting(
      'access-denied',
      'Access was denied. Requests stay halted until the credentials are updated.',
    )
  if (dispatch?.dispatch?.stopped)
    return waiting(
      'stopped',
      dispatch.dispatch.failures > 0
        ? `Stopped after ${dispatch.dispatch.failures} failed jobs in a row`
        : 'Stopped to protect provider limits',
    )
  if (env.RUNTIME_KIND === 'cloudflare' && !env.SCRAPING_ENABLED)
    return waiting('paused', 'Scraping is disabled for this deployment')
  if (dispatch?.dispatch?.paused)
    return waiting(
      'paused',
      dispatch.dispatch.infrastructureFailures > 0
        ? 'Queue paused after dispatch errors'
        : 'Queue paused',
    )
  // An account-level provider runs task jobs only and has no item scraper.
  if (
    !plugin ||
    !(plugin.scrapeMediaItem || plugin.manifest.mediaTypes.length === 0)
  )
    return waiting(
      'not-configured',
      'No executable plugin is loaded for this provider',
    )
  const worker = dispatch?.worker
  if (worker?.blocked)
    return waiting('worker-offline', 'The local worker needs review')
  if (worker?.mode === 'local' && !worker.paired)
    return waiting('worker-offline', 'The local worker is not paired')
  if (worker?.mode === 'local' && !worker.online)
    return waiting('worker-offline', 'The local worker is offline')
  if (state.cooldownUntil !== null && state.cooldownUntil > now)
    return waiting(
      'cooldown',
      lastError ? `Cooling down: ${lastError}` : 'Cooling down',
      state.cooldownUntil,
    )
  if (state.budget && state.budget.used >= state.budget.limit)
    return waiting(
      'budget',
      state.budget.period === 'day'
        ? 'Daily request budget used'
        : 'Hourly request budget used',
      Date.parse(state.budget.resetsAt),
    )
  const hourly = hourlyBudget(
    requests,
    now,
    plugin.manifest.rateLimit.maxRequestsPerHour,
  )
  if (hourly.retryAt !== null)
    return waiting('rate-limit', 'Hourly request limit reached', hourly.retryAt)
  const fixed = plugin.manifest.rateLimit.fixedWindow
  if (
    fixed &&
    fixedResetsAt !== null &&
    ((usage?.fixedReads ?? 0) >= fixed.reads ||
      (usage?.fixedWrites ?? 0) >= fixed.writes)
  )
    return waiting('rate-limit', 'Request window limit reached', fixedResetsAt)
  return null
}

/**
 * Reads, with a bounded number of queries, everything that decides whether
 * the given providers' queued jobs can start.
 */
export async function loadProviderWaitStates(
  providers: string[],
  options: { running?: Map<string, number>; now?: number } = {},
): Promise<Map<string, ProviderWaitState>> {
  const ids = [...new Set(providers)]
  if (!ids.length) return new Map()
  const now = options.now ?? Date.now()
  const [rows, running, plugins, dispatches] = await Promise.all([
    db
      .select()
      .from(providerRequestState)
      .where(inArray(providerRequestState.provider, ids)),
    options.running ?? countRunningJobs(ids),
    Promise.all(ids.map((id) => getScrapePlugin(id))),
    Promise.all(ids.map((id) => readProviderDispatchStatus(id))),
  ])
  const stateRows = new Map(rows.map((row) => [row.provider, row]))
  const limits = ids.map((provider, index) => {
    const plugin = plugins[index] ?? null
    const rateLimit = plugin?.manifest.rateLimit
    const window = rateLimit?.fixedWindow
      ? fixedRequestWindow(rateLimit.fixedWindow.durationMs, now)
      : null
    return {
      provider,
      plugin,
      dispatch: dispatches[index] ?? null,
      budget: rateLimit
        ? effectiveRequestBudget(
            rateLimit,
            stateRows.get(provider)?.requestBudgetOverride,
          )
        : undefined,
      fixedFrom: window?.from ?? null,
      fixedResetsAt: window?.resetsAt ?? null,
    }
  })
  const usage = await readRequestUsage(limits, now)
  return new Map(
    limits.map((entry) => {
      const row = stateRows.get(entry.provider)
      const rateLimit = entry.plugin?.manifest.rateLimit
      const base = {
        provider: entry.provider,
        plugin: entry.plugin,
        now,
        halted: row?.halted ?? false,
        cooldownUntil: row?.cooldownUntil?.getTime() ?? null,
        running: running.get(entry.provider) ?? 0,
        concurrency: rateLimit
          ? rateLimit.concurrentRequests
            ? rateLimit.maxConcurrent
            : 1
          : null,
        nextAllowedAt: row?.nextAllowedAt?.getTime() ?? null,
        budget: entry.budget
          ? budgetUsage(entry.budget, usage.get(entry.provider), now)
          : null,
        dispatch: entry.dispatch,
      }
      return [
        entry.provider,
        {
          ...base,
          block: providerBlock(
            base,
            row?.lastError ?? null,
            row?.requests ?? [],
            usage.get(entry.provider),
            entry.fixedResetsAt,
          ),
        },
      ]
    }),
  )
}

/** Why the provider's next queued job has not started, ignoring job selection. */
export function providerTurn(state: ProviderWaitState): ProviderWaiting {
  if (state.block) return state.block
  if (state.concurrency !== null && state.running >= state.concurrency)
    return waiting(
      'concurrency',
      state.running === 1
        ? 'Waiting for 1 running job'
        : `Waiting for ${state.running} running jobs`,
    )
  return waiting(
    'queued',
    'Queued; nothing is blocking this provider',
    state.nextAllowedAt !== null && state.nextAllowedAt > state.now
      ? state.nextAllowedAt
      : null,
  )
}

export function jobWaiting(
  state: ProviderWaitState,
  jobId: string,
): ProviderWaiting {
  if (state.block) return state.block
  const selected = state.dispatch?.dispatch?.allowedJobIds ?? null
  if (selected !== null && !selected.includes(jobId))
    return waiting('paused', 'Not in the jobs selected to run')
  return providerTurn(state)
}

/**
 * The reason for the provider that will move first: one that is free wins,
 * otherwise the block that lifts soonest.
 */
export function firstWaiting(
  states: ProviderWaitState[],
): ProviderWaiting | null {
  const reasons = states.map(providerTurn)
  const free =
    reasons.find((reason) => reason.reason === 'queued') ??
    reasons.find((reason) => reason.reason === 'concurrency')
  if (free) return free
  return (
    [...reasons].sort(
      (a, b) =>
        (a.until === null ? Infinity : Date.parse(a.until)) -
        (b.until === null ? Infinity : Date.parse(b.until)),
    )[0] ?? null
  )
}

/** Adds why each queued job is waiting, reading provider state once. */
export async function withJobWaiting(jobs: Job[]): Promise<Job[]> {
  const states = await loadProviderWaitStates(
    jobs.filter((job) => job.status === 'queued').map((job) => job.provider),
  )
  return jobs.map((job) => {
    const state = states.get(job.provider)
    return {
      ...job,
      waiting:
        job.status === 'queued' && state ? jobWaiting(state, job.id) : null,
    }
  })
}
