import { randomUUID } from 'node:crypto'
import { and, count, eq, gt, gte, lt, min } from 'drizzle-orm'
import { z } from 'zod'
import {
  ProviderRequestError,
  ProviderItemNotFoundError,
  isProviderItemNotFoundError,
  type MediaProviderPlugin,
  type MediaPluginTestContext,
} from '@repo/media-plugin-sdk'
import { db } from '@/lib/db'
import {
  ProviderRequestBudgetSchema,
  type ProviderRequestBudget,
} from '@repo/schemas/provider'
import { providerRequestState, providerRequestEvent } from '@/schemas/db'
import {
  FAILURE_COOLDOWN_MS,
  HOUR_MS,
  hourlyBudget,
  retryAfterTime,
  responseQuota,
  rateLimitRetryAt,
  requestBudgetWindow,
  hasProviderQuotaError,
  fixedRequestWindow,
} from '@/lib/request-policy'

export function effectiveRequestBudget(
  rateLimit: MediaProviderPlugin['manifest']['rateLimit'],
  override: unknown,
) {
  if (
    rateLimit.configurableRequestBudget &&
    override !== null &&
    override !== undefined
  )
    return ProviderRequestBudgetSchema.parse(override)
  return rateLimit.requestBudget
}

// Query the durable event log, not the rolling-hour cache, so mode changes
// and process restarts never reset daily usage. Called under the reservation lock.
async function budgetUsage(
  client: Pick<typeof db, 'select'>,
  provider: string,
  budget: ProviderRequestBudget,
  now: number,
) {
  const window = requestBudgetWindow(budget.period, now)
  const [usage] = await client
    .select({ used: count(), oldest: min(providerRequestEvent.requestedAt) })
    .from(providerRequestEvent)
    .where(
      and(
        eq(providerRequestEvent.provider, provider),
        budget.period === 'day'
          ? gte(providerRequestEvent.requestedAt, new Date(window.from))
          : gt(providerRequestEvent.requestedAt, new Date(window.from)),
        lt(providerRequestEvent.requestedAt, new Date(now + 1)),
      ),
    )
  const resetsAt =
    budget.period === 'hour' && usage?.oldest
      ? new Date(usage.oldest).getTime() + HOUR_MS
      : window.resetsAt
  return {
    budget,
    used: usage?.used ?? 0,
    resetsAt: new Date(resetsAt).toISOString(),
  }
}

export async function getProviderBudgetStatus(
  provider: string,
  rateLimit: MediaProviderPlugin['manifest']['rateLimit'],
) {
  if (!rateLimit.requestBudget && !rateLimit.configurableRequestBudget)
    return undefined
  const [state] = await db
    .select()
    .from(providerRequestState)
    .where(eq(providerRequestState.provider, provider))
  const budget = effectiveRequestBudget(rateLimit, state?.requestBudgetOverride)
  return budget ? budgetUsage(db, provider, budget, Date.now()) : undefined
}

type Reservation =
  | { kind: 'ready'; token: string }
  | { kind: 'wait'; ms: number }
  | { kind: 'blocked'; until: number | null; reason: string }
const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms))
const RequestTimeoutSchema = z
  .number()
  .int()
  .positive()
  .max(180000)
  .default(15000)

async function readBoundedBody(
  response: Response,
  limit = 10 * 1024 * 1024,
): Promise<string> {
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel()
    throw new Error('Response exceeds size limit')
  }
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    let chunk = await reader.read()
    while (!chunk.done) {
      bytes += chunk.value.byteLength
      if (bytes > limit) {
        await reader.cancel()
        throw new Error('Response exceeds size limit')
      }
      chunks.push(chunk.value)
      chunk = await reader.read()
    }
    return Buffer.concat(chunks).toString('utf8')
  } finally {
    reader.releaseLock()
  }
}

async function reserve(
  plugin: MediaProviderPlugin,
  method: string,
  timeoutMs: number,
): Promise<Reservation> {
  return db.transaction(async (tx) => {
    const provider = plugin.manifest.id
    await tx
      .insert(providerRequestState)
      .values({ provider })
      .onConflictDoNothing()
    const [state] = await tx
      .select()
      .from(providerRequestState)
      .where(eq(providerRequestState.provider, provider))
      .for('update')
    if (!state) throw new Error('Missing provider request state')
    const now = Date.now()
    if (state.halted)
      return {
        kind: 'blocked',
        until: null,
        reason:
          'Provider access was denied. Requests are halted; check access before explicitly updating credentials.',
      }
    if (state.cooldownUntil && state.cooldownUntil.getTime() > now)
      return {
        kind: 'blocked',
        until: state.cooldownUntil.getTime(),
        reason: state.lastError ?? 'Provider cooldown',
      }
    const requestClass = method.toUpperCase() === 'GET' ? 'read' : 'write'
    const fixedWindow = plugin.manifest.rateLimit.fixedWindow
    if (fixedWindow) {
      const window = fixedRequestWindow(fixedWindow.durationMs, now)
      const [usage] = await tx
        .select({ used: count() })
        .from(providerRequestEvent)
        .where(
          and(
            eq(providerRequestEvent.provider, provider),
            eq(providerRequestEvent.requestClass, requestClass),
            gte(providerRequestEvent.requestedAt, new Date(window.from)),
            lt(providerRequestEvent.requestedAt, new Date(window.resetsAt)),
          ),
        )
      const limit =
        requestClass === 'read' ? fixedWindow.reads : fixedWindow.writes
      if ((usage?.used ?? 0) >= limit)
        return {
          kind: 'blocked',
          until: window.resetsAt,
          reason: `Fixed-window ${requestClass} request budget exhausted`,
        }
    }
    const requestBudget = effectiveRequestBudget(
      plugin.manifest.rateLimit,
      state.requestBudgetOverride,
    )
    if (requestBudget) {
      const usage = await budgetUsage(tx, provider, requestBudget, now)
      if (usage.used >= requestBudget.limit)
        return {
          kind: 'blocked',
          until: Date.parse(usage.resetsAt),
          reason:
            requestBudget.period === 'day'
              ? 'Daily request budget exhausted (resets at midnight UTC)'
              : 'Hourly request budget exhausted',
        }
    }
    const budget = hourlyBudget(
      state.requests,
      now,
      plugin.manifest.rateLimit.maxRequestsPerHour,
    )
    if (budget.retryAt !== null) {
      await tx
        .update(providerRequestState)
        .set({
          cooldownUntil: new Date(budget.retryAt),
          lastError: 'Hourly request budget exhausted',
          updatedAt: new Date(),
        })
        .where(eq(providerRequestState.provider, provider))
      return {
        kind: 'blocked',
        until: budget.retryAt,
        reason: 'Hourly request budget exhausted',
      }
    }
    if (state.leaseUntil && state.leaseUntil.getTime() > now)
      return {
        kind: 'wait',
        ms: Math.min(500, state.leaseUntil.getTime() - now),
      }
    const leases = state.requestLeases.filter((lease) => lease.expiresAt > now)
    const concurrency = plugin.manifest.rateLimit.concurrentRequests
      ? plugin.manifest.rateLimit.maxConcurrent
      : 1
    if (leases.length >= concurrency) return { kind: 'wait', ms: 50 }
    const wait = (state.nextAllowedAt?.getTime() ?? 0) - now
    if (wait > 0) return { kind: 'wait', ms: Math.min(wait, 1000) }
    const token = randomUUID()
    await tx
      .insert(providerRequestEvent)
      .values({ id: token, provider, requestedAt: new Date(now), requestClass })
    await tx
      .update(providerRequestState)
      .set({
        requests: [...budget.recent, now],
        nextAllowedAt: new Date(now + plugin.manifest.rateLimit.minTimeMs),
        ...(plugin.manifest.rateLimit.concurrentRequests
          ? {
              requestLeases: [
                ...leases,
                { id: token, expiresAt: now + timeoutMs + 5000 },
              ],
            }
          : {
              leaseId: token,
              leaseUntil: new Date(now + timeoutMs + 5000),
              requestLeases: leases,
            }),
        updatedAt: new Date(),
      })
      .where(eq(providerRequestState.provider, provider))
    return { kind: 'ready', token }
  })
}

export async function recordProviderFailure(
  plugin: MediaProviderPlugin,
  error: unknown,
  leaseId?: string,
) {
  if (isProviderItemNotFoundError(error)) return
  if (error instanceof ProviderRequestError && error.recorded && !leaseId)
    return
  const provider = plugin.manifest.id
  await db.transaction(async (tx) => {
    await tx
      .insert(providerRequestState)
      .values({ provider })
      .onConflictDoNothing()
    const [state] = await tx
      .select()
      .from(providerRequestState)
      .where(eq(providerRequestState.provider, provider))
      .for('update')
    if (!state) return
    const count = state.failureCount + 1
    const failureCooldown =
      plugin.manifest.rateLimit.failureCooldownMs ?? FAILURE_COOLDOWN_MS
    const retryAt =
      error instanceof ProviderRequestError ? (error.retryAt ?? 0) : 0
    const requestBackoff =
      failureCooldown === 0 &&
      error instanceof ProviderRequestError &&
      error.code === 'request-failed'
        ? retryAt
        : 0
    const requested = requestBackoff ? 0 : retryAt
    const scheduledRateLimit =
      plugin.manifest.rateLimit.retryAfterIsAuthoritative &&
      error instanceof ProviderRequestError &&
      error.code === 'rate-limit'
    const until = Math.max(
      state.cooldownUntil?.getTime() ?? 0,
      requested,
      count >= 2 && failureCooldown > 0 && !scheduledRateLimit
        ? Date.now() + failureCooldown
        : 0,
    )
    await tx
      .update(providerRequestState)
      .set({
        failureCount: count,
        halted:
          state.halted ||
          (error instanceof ProviderRequestError &&
            error.code === 'access-denied'),
        cooldownUntil: until > Date.now() ? new Date(until) : null,
        ...(requestBackoff
          ? {
              nextAllowedAt: new Date(
                Math.max(state.nextAllowedAt?.getTime() ?? 0, requestBackoff),
              ),
            }
          : {}),
        lastError:
          error instanceof ProviderRequestError
            ? error.message
            : 'Provider execution failed',
        ...(leaseId === state.leaseId
          ? { leaseId: null, leaseUntil: null }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(providerRequestState.provider, provider))
  })
}

export async function recordProviderSuccess(provider: string) {
  await db.transaction(async (tx) => {
    const [state] = await tx
      .select()
      .from(providerRequestState)
      .where(eq(providerRequestState.provider, provider))
      .for('update')
    if (!state) return
    const blocked =
      state.halted || (state.cooldownUntil?.getTime() ?? 0) > Date.now()
    await tx
      .update(providerRequestState)
      .set({
        failureCount: blocked ? state.failureCount : 0,
        lastError: blocked ? state.lastError : null,
        updatedAt: new Date(),
      })
      .where(eq(providerRequestState.provider, provider))
  })
}

async function recordResponseQuota(provider: string, resetAt: number) {
  await db.transaction(async (tx) => {
    const [state] = await tx
      .select()
      .from(providerRequestState)
      .where(eq(providerRequestState.provider, provider))
      .for('update')
    if (!state || (state.cooldownUntil?.getTime() ?? 0) >= resetAt) return
    await tx
      .update(providerRequestState)
      .set({
        cooldownUntil: new Date(resetAt),
        lastError: state.halted
          ? state.lastError
          : 'Provider response quota exhausted',
        updatedAt: new Date(),
      })
      .where(eq(providerRequestState.provider, provider))
  })
}

export async function clearProviderAccessHalt(provider: string) {
  // An explicit credential update may clear access denial, but never quota cooldowns.
  await db
    .update(providerRequestState)
    .set({ halted: false, updatedAt: new Date() })
    .where(eq(providerRequestState.provider, provider))
}

export async function getProviderSafety(provider: string) {
  const [state] = await db
    .select()
    .from(providerRequestState)
    .where(eq(providerRequestState.provider, provider))
  return {
    halted: state?.halted ?? false,
    cooldownUntil:
      state?.cooldownUntil && state.cooldownUntil.getTime() > Date.now()
        ? state.cooldownUntil.toISOString()
        : null,
    consecutiveFailures: state?.failureCount ?? 0,
    requestsLastHour:
      state?.requests.filter((time) => time > Date.now() - HOUR_MS).length ?? 0,
    lastError: state?.lastError ?? null,
  }
}

export function createProviderRequest(
  plugin: MediaProviderPlugin,
  assertActive?: () => Promise<void>,
  configuration: { timeoutMs?: number } = {},
): MediaPluginTestContext['request'] {
  const timeoutMs = RequestTimeoutSchema.parse(configuration.timeoutMs)
  return async (url, init, options) => {
    await assertActive?.()
    let reservation = await reserve(plugin, init?.method ?? 'GET', timeoutMs)
    while (reservation.kind === 'wait') {
      await delay(reservation.ms)
      await assertActive?.()
      reservation = await reserve(plugin, init?.method ?? 'GET', timeoutMs)
    }
    if (reservation.kind === 'blocked')
      throw new ProviderRequestError(
        reservation.until === null
          ? reservation.reason
          : `${reservation.reason}. Retry after ${new Date(reservation.until).toISOString()}.`,
        reservation.until === null ? 'access-denied' : 'cooldown',
        reservation.until,
        true,
      )
    const token = reservation.token
    let requestStarted = false
    try {
      await assertActive?.()
      const timeout = AbortSignal.timeout(timeoutMs)
      requestStarted = true
      const response = await fetch(url, {
        ...init,
        redirect: 'error',
        signal: init?.signal
          ? AbortSignal.any([init.signal, timeout])
          : timeout,
      })
      const quota = plugin.manifest.rateLimit.respectRateLimitHeaders
        ? responseQuota(response.headers, Date.now())
        : null
      // Persist before reading the body: a parsing/size failure must not lose quota state.
      if (response.ok && quota?.exhausted && quota.resetAt !== null)
        await recordResponseQuota(plugin.manifest.id, quota.resetAt)
      const jsonResponse =
        response.headers.get('content-type')?.toLowerCase().includes('json') ??
        false
      let body = ''
      if (response.ok) {
        body = await readBoundedBody(response)
      } else if (response.status === 403 && jsonResponse) {
        try {
          body = await readBoundedBody(response, 16 * 1024)
        } catch {
          // Malformed, oversized or unreadable denial bodies cannot clear an access halt.
        }
      } else {
        try {
          await response.body?.cancel()
        } catch {
          // Header-based failures, especially 429, must survive body cancellation errors.
        }
      }
      let apiLimit = false
      if (jsonResponse && (response.ok || response.status === 403)) {
        try {
          apiLimit = hasProviderQuotaError(JSON.parse(body), response.ok)
        } catch {
          /* Malformed success bodies reach the adapter; failed responses retain HTTP classification. */
        }
      }
      if (!response.ok || apiLimit) {
        if (response.status === 404 && options?.notFoundOn404) {
          throw new ProviderItemNotFoundError(
            'Provider has no matching item (HTTP 404)',
          )
        }
        const limited = response.status === 429 || apiLimit
        const denied = response.status === 401 || response.status === 403
        const errorBackoff = plugin.manifest.rateLimit.errorBackoffMs ?? 60000
        const until = limited
          ? rateLimitRetryAt(
              response.headers,
              Date.now(),
              plugin.manifest.rateLimit.rateLimitCooldownMs ?? 60000,
              quota,
              plugin.manifest.rateLimit.retryAfterIsAuthoritative,
            )
          : (response.status === 400 || response.status >= 500) &&
              (errorBackoff > 0 || response.headers.has('retry-after'))
            ? retryAfterTime(
                response.headers.get('retry-after'),
                Date.now(),
                errorBackoff,
              )
            : null
        throw new ProviderRequestError(
          limited
            ? 'Provider rate limit reached'
            : `Provider request failed (HTTP ${response.status})`,
          limited ? 'rate-limit' : denied ? 'access-denied' : 'request-failed',
          until,
        )
      }
      return new Response(
        response.status === 204 || response.status === 205 ? null : body,
        {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        },
      )
    } catch (error) {
      if (!requestStarted) throw error
      if (isProviderItemNotFoundError(error)) throw error
      const safe =
        error instanceof ProviderRequestError
          ? error
          : new ProviderRequestError(
              'Provider request failed or timed out',
              'request-failed',
              null,
              false,
              { cause: error },
            )
      await recordProviderFailure(plugin, safe, token)
      throw new ProviderRequestError(
        safe.message,
        safe.code,
        safe.retryAt,
        true,
        { cause: safe },
      )
    } finally {
      await db.transaction(async (tx) => {
        const [state] = await tx
          .select()
          .from(providerRequestState)
          .where(eq(providerRequestState.provider, plugin.manifest.id))
          .for('update')
        if (state)
          await tx
            .update(providerRequestState)
            .set({
              ...(state.leaseId === token
                ? { leaseId: null, leaseUntil: null }
                : {}),
              requestLeases: state.requestLeases.filter(
                (lease) => lease.id !== token && lease.expiresAt > Date.now(),
              ),
            })
            .where(eq(providerRequestState.provider, plugin.manifest.id))
      })
    }
  }
}
