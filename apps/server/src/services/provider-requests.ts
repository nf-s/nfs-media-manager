import { randomUUID } from 'node:crypto'
import { and, count, eq, gt, gte, lt, min } from 'drizzle-orm'
import {
  PluginRequestTimeoutSchema,
  ProviderRequestError,
  ProviderItemNotFoundError,
  isProviderItemNotFoundError,
  type MediaProviderPlugin,
  type MediaPluginTestContext,
} from '@repo/media-plugin-sdk'
import { db } from '@/lib/db'
import {
  PROVIDER_ERROR_BODY_BYTES,
  captureProviderResponseEvidence,
  type CapturedProviderBody,
} from '@/lib/job-diagnostics'
import { getProviderTransport } from '@/services/provider-transport'
import {
  ProviderRequestBudgetSchema,
  ProviderQuotaHeadersSchema,
  type ProviderRequestBudget,
  type ProviderRequestDiagnostics,
} from '@repo/schemas/provider'
import { providerRequestState, providerRequestEvent } from '@/schemas/db'
import {
  FAILURE_COOLDOWN_MS,
  HOUR_MS,
  MAX_CONSECUTIVE_PROVIDER_FAILURES,
  hourlyBudget,
  retryAfterTime,
  responseQuota,
  rateLimitRetryAt,
  requestBudgetWindow,
  hasProviderQuotaError,
  fixedRequestWindow,
  unsignedHeaderInteger,
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

type ReadyReservation = {
  kind: 'ready'
  token: string
  reservedAt: number
  dispatchBefore: number
}
type Reservation =
  | ReadyReservation
  | { kind: 'wait'; ms: number }
  | {
      kind: 'blocked'
      until: number | null
      reason: string
      source: 'local-cooldown' | 'local-budget' | 'local-access-halt'
    }
const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms))
const LEASE_GRACE_MS = 5000
const DISPATCH_WINDOW_MS = 4000
const RequestTimeoutSchema = PluginRequestTimeoutSchema.default(15000)
const TRANSIENT_MAX_ATTEMPTS = 3
const TRANSIENT_RETRY_WINDOW_MS = 60000
const ERROR_BODY_CAPTURE_TIMEOUT_MS = 1000

type TransientDisposition = 'retry' | 'backoff' | 'cooldown'

interface TransientFailure {
  retryAt: number
  retryBefore: number
  disposition: TransientDisposition
}

interface ProviderRequestRetry {
  error: ProviderRequestError
  attempt: number
  retryAt: number
}

interface PendingProviderRetry {
  error: ProviderRequestError
  retryAt: number
  retryBefore: number
}

function responseDiagnostics(
  response: Response,
  receivedAt: number,
  quotaError: boolean,
): ProviderRequestDiagnostics {
  const quotaHeaders = ProviderQuotaHeadersSchema.parse(
    Object.fromEntries(
      ProviderQuotaHeadersSchema.keyof().options.flatMap((name) => {
        const value = unsignedHeaderInteger(response.headers.get(name))
        return value === null ? [] : [[name, value]]
      }),
    ),
  )
  const retryAfter = response.headers.get('retry-after')?.trim()
  const seconds = unsignedHeaderInteger(retryAfter ?? null)
  const at =
    retryAfter &&
    retryAfter.length <= 128 &&
    /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(
      retryAfter,
    )
      ? Date.parse(retryAfter)
      : NaN
  return {
    source: 'provider-response',
    httpStatus: response.status,
    responseReceivedAt: new Date(receivedAt).toISOString(),
    quotaError,
    ...(seconds !== null
      ? { retryAfter: { seconds } }
      : Number.isFinite(at)
        ? { retryAfter: { at: new Date(at).toISOString() } }
        : {}),
    ...(Object.keys(quotaHeaders).length ? { quotaHeaders } : {}),
  }
}

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

function responseContentType(response: Response): string | null {
  const type = response.headers.get('content-type')?.split(';', 1)[0]?.trim()
  return type &&
    /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/i.test(
      type,
    )
    ? type.toLowerCase()
    : null
}

function capturedErrorText(
  text: string,
  relayed: boolean,
): CapturedProviderBody {
  if (!text)
    return relayed
      ? { state: 'unavailable', reason: 'local-response' }
      : { state: 'empty' }
  if (Buffer.byteLength(text) > PROVIDER_ERROR_BODY_BYTES)
    return { state: 'unavailable', reason: 'byte-limit' }
  return { state: 'captured', text, relayed }
}

async function readErrorBody(
  response: Response,
  signal: AbortSignal,
  relayed: boolean,
  contentType: string | null,
): Promise<CapturedProviderBody> {
  if (!response.body) return capturedErrorText('', relayed)
  if (response.body.locked)
    return { state: 'unavailable', reason: 'read-failed' }
  if (
    Number(response.headers.get('content-length')) > PROVIDER_ERROR_BODY_BYTES
  ) {
    void response.body.cancel().catch(() => undefined)
    return { state: 'unavailable', reason: 'byte-limit' }
  }
  if (
    contentType &&
    !contentType.startsWith('text/') &&
    !/(?:\/|\+)(?:json|xml)$/.test(contentType)
  ) {
    void response.body.cancel().catch(() => undefined)
    return { state: 'unavailable', reason: 'unsupported-format' }
  }
  const reader = response.body.getReader()
  const cancel = () => {
    void reader.cancel().catch(() => undefined)
  }
  signal.addEventListener('abort', cancel, { once: true })
  let complete = false
  try {
    const chunks: Uint8Array[] = []
    let bytes = 0
    for (;;) {
      signal.throwIfAborted()
      const chunk = await reader.read()
      signal.throwIfAborted()
      if (chunk.done) {
        complete = true
        break
      }
      bytes += chunk.value.byteLength
      if (bytes > PROVIDER_ERROR_BODY_BYTES)
        return { state: 'unavailable', reason: 'byte-limit' }
      chunks.push(chunk.value)
    }
    return capturedErrorText(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        Buffer.concat(chunks),
      ),
      relayed,
    )
  } catch {
    return { state: 'unavailable', reason: 'read-failed' }
  } finally {
    signal.removeEventListener('abort', cancel)
    if (!complete) cancel()
    reader.releaseLock()
  }
}

async function reserve(
  plugin: MediaProviderPlugin,
  method: string,
  timeoutMs: number,
  localWorker = false,
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
    if (
      localWorker &&
      (plugin.manifest.rateLimit.concurrentRequests ||
        plugin.manifest.rateLimit.fixedWindow ||
        effectiveRequestBudget(
          plugin.manifest.rateLimit,
          state.requestBudgetOverride,
        )?.period === 'day')
    )
      throw new ProviderRequestError(
        'Local workers currently require serial, rolling-hour provider limits',
        'request-failed',
        null,
        true,
      )
    const now = Date.now()
    if (state.halted)
      return {
        kind: 'blocked',
        source: 'local-access-halt',
        until: null,
        reason:
          'Provider access was denied. Requests are halted; check access before explicitly updating credentials.',
      }
    if (state.cooldownUntil && state.cooldownUntil.getTime() > now)
      return {
        kind: 'blocked',
        source: 'local-cooldown',
        until: state.cooldownUntil.getTime(),
        reason: 'Provider cooldown is active',
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
          source: 'local-budget',
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
          source: 'local-budget',
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
        source: 'local-budget',
        until: budget.retryAt,
        reason: 'Hourly request budget exhausted',
      }
    }
    if (state.leaseUntil && state.leaseUntil.getTime() > now)
      return {
        kind: 'wait',
        ms: Math.min(
          plugin.manifest.rateLimit.concurrentRequests ? 10 : 500,
          state.leaseUntil.getTime() - now,
        ),
      }
    // An expired dispatch lock may belong to a process that sent its request
    // but never persisted the start time. Do not reclaim it with stale spacing.
    const abandonedSpacing = state.leaseId
      ? (state.leaseUntil?.getTime() ?? 0) +
        plugin.manifest.rateLimit.minTimeMs -
        now
      : 0
    if (abandonedSpacing > 0)
      return { kind: 'wait', ms: Math.min(abandonedSpacing, 1000) }
    const leases = state.requestLeases.filter((lease) => lease.expiresAt > now)
    const concurrency = plugin.manifest.rateLimit.concurrentRequests
      ? plugin.manifest.rateLimit.maxConcurrent
      : 1
    if (leases.length >= concurrency) return { kind: 'wait', ms: 50 }
    const wait = (state.nextAllowedAt?.getTime() ?? 0) - now
    if (wait > 0) return { kind: 'wait', ms: Math.min(wait, 1000) }
    const token = randomUUID()
    const dispatchBefore = Math.min(
      now + DISPATCH_WINDOW_MS,
      fixedWindow
        ? fixedRequestWindow(fixedWindow.durationMs, now).resetsAt
        : Infinity,
      requestBudget?.period === 'day'
        ? requestBudgetWindow('day', now).resetsAt
        : Infinity,
    )
    const expiresAt = now + timeoutMs + LEASE_GRACE_MS
    await tx
      .insert(providerRequestEvent)
      .values({ id: token, provider, requestedAt: new Date(now), requestClass })
    await tx
      .update(providerRequestState)
      .set({
        requests: [...budget.recent, now],
        nextAllowedAt: new Date(now + plugin.manifest.rateLimit.minTimeMs),
        // Concurrent providers also hold this lock until actual dispatch pacing
        // is durable; their in-flight slots remain in requestLeases afterwards.
        leaseId: token,
        leaseUntil: new Date(expiresAt),
        requestLeases: plugin.manifest.rateLimit.concurrentRequests
          ? [...leases, { id: token, expiresAt }]
          : leases,
        updatedAt: new Date(),
      })
      .where(eq(providerRequestState.provider, provider))
    return { kind: 'ready', token, reservedAt: now, dispatchBefore }
  })
}

function expiredReservation() {
  return new ProviderRequestError(
    'Provider request reservation expired before dispatch',
    'request-failed',
    null,
    true,
  )
}

async function checkDispatch(provider: string, reservation: ReadyReservation) {
  const [state] = await db
    .select()
    .from(providerRequestState)
    .where(eq(providerRequestState.provider, provider))
  if (state?.halted)
    throw new ProviderRequestError(
      'Provider access is halted',
      'access-denied',
      null,
      true,
      { diagnostics: { source: 'local-access-halt' } },
    )
  if (state?.cooldownUntil && state.cooldownUntil.getTime() > Date.now())
    throw new ProviderRequestError(
      `Provider cooldown is active. Retry after ${state.cooldownUntil.toISOString()}.`,
      'cooldown',
      state.cooldownUntil.getTime(),
      true,
      { diagnostics: { source: 'local-cooldown' } },
    )
  if (state?.leaseId !== reservation.token) throw expiredReservation()
}

async function recordDispatch(
  plugin: MediaProviderPlugin,
  reservation: ReadyReservation,
  startedAt: number,
) {
  await db.transaction(async (tx) => {
    const [state] = await tx
      .select()
      .from(providerRequestState)
      .where(eq(providerRequestState.provider, plugin.manifest.id))
      .for('update')
    if (!state || state.leaseId !== reservation.token)
      throw new Error('Provider dispatch lease lost')
    // Move, never refund, the reservation so rolling budgets cannot age out
    // earlier than the actual request. The dispatch lock excludes new reserves.
    const requestIndex = state.requests.lastIndexOf(reservation.reservedAt)
    await tx
      .update(providerRequestEvent)
      .set({ requestedAt: new Date(startedAt) })
      .where(eq(providerRequestEvent.id, reservation.token))
    await tx
      .update(providerRequestState)
      .set({
        requests: state.requests.map((time, index) =>
          index === requestIndex ? Math.max(time, startedAt) : time,
        ),
        nextAllowedAt: new Date(
          Math.max(
            state.nextAllowedAt?.getTime() ?? 0,
            startedAt + plugin.manifest.rateLimit.minTimeMs,
          ),
        ),
        ...(plugin.manifest.rateLimit.concurrentRequests
          ? { leaseId: null, leaseUntil: null }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(providerRequestState.provider, plugin.manifest.id))
  })
}

export async function recordProviderFailure(
  plugin: MediaProviderPlugin,
  error: unknown,
  transient?: TransientDisposition,
) {
  if (isProviderItemNotFoundError(error)) return
  if (error instanceof ProviderRequestError && error.recorded && !transient)
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
    const count = state.failureCount + (transient === 'retry' ? 0 : 1)
    const failureCooldown =
      plugin.manifest.rateLimit.failureCooldownMs ?? FAILURE_COOLDOWN_MS
    const retryAt =
      error instanceof ProviderRequestError ? (error.retryAt ?? 0) : 0
    const delaysNextRequest = transient
      ? transient !== 'cooldown'
      : failureCooldown === 0 &&
        error instanceof ProviderRequestError &&
        error.code === 'request-failed'
    const requestBackoff = delaysNextRequest ? retryAt : 0
    const requested = requestBackoff ? 0 : retryAt
    const scheduledRateLimit =
      plugin.manifest.rateLimit.retryAfterIsAuthoritative &&
      error instanceof ProviderRequestError &&
      error.code === 'rate-limit'
    const until = Math.max(
      state.cooldownUntil?.getTime() ?? 0,
      requested,
      transient !== 'retry' &&
        count >= MAX_CONSECUTIVE_PROVIDER_FAILURES &&
        failureCooldown > 0 &&
        !scheduledRateLimit
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

// Local responses may arrive after their job has timed out. Preserve restrictive
// safety evidence independently of job completion; never clear a prior restriction.
export async function protectProviderFromLocalResponse(
  plugin: MediaProviderPlugin,
  status: number,
  headers: Headers,
  body: string,
) {
  let quotaError = false
  if (headers.get('content-type')?.includes('json')) {
    try {
      quotaError = hasProviderQuotaError(
        JSON.parse(body),
        status >= 200 && status < 300,
      )
    } catch {
      /* HTTP status remains authoritative. */
    }
  }
  const limited = status === 429 || quotaError
  const denied = !limited && (status === 401 || status === 403)
  if (!limited && !denied) return
  const retryAt = limited
    ? rateLimitRetryAt(
        headers,
        Date.now(),
        plugin.manifest.rateLimit.rateLimitCooldownMs ?? 60000,
        responseQuota(headers, Date.now()),
        plugin.manifest.rateLimit.retryAfterIsAuthoritative,
      )
    : null
  await db.transaction(async (tx) => {
    await tx
      .insert(providerRequestState)
      .values({ provider: plugin.manifest.id })
      .onConflictDoNothing()
    const [state] = await tx
      .select()
      .from(providerRequestState)
      .where(eq(providerRequestState.provider, plugin.manifest.id))
      .for('update')
    if (!state) throw new Error('Missing provider safety state')
    await tx
      .update(providerRequestState)
      .set({
        halted: state.halted || denied,
        cooldownUntil:
          retryAt === null
            ? state.cooldownUntil
            : new Date(Math.max(state.cooldownUntil?.getTime() ?? 0, retryAt)),
        lastError: limited
          ? 'Local worker reported a provider rate limit'
          : 'Local worker reported provider access denial',
        updatedAt: new Date(),
      })
      .where(eq(providerRequestState.provider, plugin.manifest.id))
  })
}

export function createProviderRequest(
  plugin: MediaProviderPlugin,
  assertActive?: () => Promise<void>,
  configuration: {
    timeoutMs?: number
    onRetry?: (retry: ProviderRequestRetry) => Promise<void>
  } = {},
): MediaPluginTestContext['request'] {
  const timeoutMs = RequestTimeoutSchema.parse(
    configuration.timeoutMs === undefined
      ? plugin.manifest.rateLimit.requestTimeoutMs
      : configuration.timeoutMs,
  )
  const failRetry = async (
    pending: PendingProviderRetry,
    reason: string,
  ): Promise<never> => {
    const error = new ProviderRequestError(
      `${pending.error.message}. ${reason}`,
      pending.error.code,
      pending.retryAt,
      true,
      { cause: pending.error, diagnostics: pending.error.diagnostics },
    )
    await recordProviderFailure(plugin, error, 'backoff')
    throw error
  }
  const expireRetry = (pending: PendingProviderRetry) =>
    failRetry(pending, 'Request retry window expired.')
  const requestOnce = async (
    retryPolicy: { attempt: number; pending?: PendingProviderRetry } | null,
    ...[url, init, options]: Parameters<MediaPluginTestContext['request']>
  ) => {
    await assertActive?.()
    init?.signal?.throwIfAborted()
    const transport = await getProviderTransport(plugin)
    if (options?.requireLocalTransport && !transport)
      throw new ProviderRequestError(
        'Provider credentials are required for direct provider requests',
        'request-failed',
        null,
        true,
      )
    if (
      transport &&
      ((init?.method ?? 'GET').toUpperCase() !== 'GET' || init?.body)
    )
      throw new ProviderRequestError(
        'Local workers support metadata GET requests only',
        'request-failed',
        null,
        true,
      )
    const pending = retryPolicy?.pending
    if (pending && Date.now() >= pending.retryBefore) await expireRetry(pending)
    let reservation = await reserve(
      plugin,
      init?.method ?? 'GET',
      timeoutMs,
      transport !== null,
    )
    while (reservation.kind === 'wait') {
      await delay(reservation.ms)
      await assertActive?.()
      init?.signal?.throwIfAborted()
      if (pending && Date.now() >= pending.retryBefore)
        await expireRetry(pending)
      reservation = await reserve(
        plugin,
        init?.method ?? 'GET',
        timeoutMs,
        transport !== null,
      )
    }
    if (reservation.kind === 'blocked')
      throw new ProviderRequestError(
        reservation.until === null
          ? reservation.reason
          : `${reservation.reason}. Retry after ${new Date(reservation.until).toISOString()}.`,
        reservation.until === null ? 'access-denied' : 'cooldown',
        reservation.until,
        true,
        { diagnostics: { source: reservation.source } },
      )
    const token = reservation.token
    const reservedAt = reservation.reservedAt
    let requestStartedAt: number | undefined
    let remoteAccountingComplete = false
    let transient: TransientFailure | undefined
    let retainResponseEvidence: (() => Promise<void>) | undefined
    try {
      await checkDispatch(plugin.manifest.id, reservation)
      const timeout = AbortSignal.timeout(timeoutMs)
      const signal = init?.signal
        ? AbortSignal.any([init.signal, timeout])
        : timeout
      signal.throwIfAborted()
      const dispatchBefore = pending
        ? Math.min(reservation.dispatchBefore, pending.retryBefore)
        : reservation.dispatchBefore
      const startedAt = Date.now()
      // No async work between this deadline check and fetch. The full timeout
      // still fits inside the durable lease, with a margin for abort delivery.
      if (pending && startedAt >= pending.retryBefore)
        await expireRetry(pending)
      if (startedAt >= dispatchBefore) throw expiredReservation()
      requestStartedAt = startedAt
      const responsePromise = (
        transport
          ? transport.execute(String(url), {
              dispatchBefore,
              expiresAt: dispatchBefore + timeoutMs,
            })
          : fetch(url, { ...init, redirect: 'manual', signal })
      ).then((response) => ({ response, receivedAt: Date.now() }))
      const activeReservation = reservation
      const recordRemoteReceipt = async () => {
        requestStartedAt = Date.now()
        await recordDispatch(plugin, activeReservation, requestStartedAt)
        remoteAccountingComplete = true
      }
      // Remote attempts retain their lease until completion or the full execution
      // horizon. Receipt-time accounting deliberately overestimates usage/spacing.
      const dispatchPromise = transport
        ? responsePromise.then(recordRemoteReceipt, recordRemoteReceipt)
        : recordDispatch(plugin, reservation, startedAt)
      const [responseResult, dispatchResult] = await Promise.allSettled([
        responsePromise,
        dispatchPromise,
      ])
      if (responseResult.status === 'rejected') throw responseResult.reason
      const { response, receivedAt: responseReceivedAt } = responseResult.value
      const quota = plugin.manifest.rateLimit.respectRateLimitHeaders
        ? responseQuota(response.headers, Date.now())
        : null
      // Persist before reading the body: a parsing/size failure must not lose quota state.
      if (response.ok && quota?.exhausted && quota.resetAt !== null)
        await recordResponseQuota(plugin.manifest.id, quota.resetAt)
      const contentType = responseContentType(response)
      const jsonResponse =
        response.headers.get('content-type')?.toLowerCase().includes('json') ??
        false
      let body = ''
      let errorBody: CapturedProviderBody | undefined
      const inspectDenial = response.status === 403 && jsonResponse
      const captureErrorBody = () =>
        readErrorBody(
          response,
          AbortSignal.any([
            signal,
            AbortSignal.timeout(ERROR_BODY_CAPTURE_TIMEOUT_MS),
          ]),
          transport !== null,
          contentType,
        )
      if (response.ok) {
        body = await readBoundedBody(response)
      } else if (inspectDenial) {
        // A structured quota denial is the only failed response that needs its
        // body classified before persisting provider safety.
        errorBody = await captureErrorBody()
        if (errorBody.state === 'captured') body = errorBody.text
      }
      let apiLimit = false
      if (jsonResponse && (response.ok || response.status === 403)) {
        try {
          apiLimit = hasProviderQuotaError(JSON.parse(body), response.ok)
        } catch {
          /* Malformed success bodies reach the adapter; failed responses retain HTTP classification. */
        }
      }
      const redirected = response.status >= 300 && response.status < 400
      if (redirected || !response.ok || apiLimit) {
        const transientStatus = [502, 503, 504].includes(response.status)
        const transientQuota =
          retryPolicy !== null && transientStatus && quota?.exhausted === true
        const diagnostics = responseDiagnostics(
          response,
          responseReceivedAt,
          apiLimit || transientQuota,
        )
        const attachEvidence = (error: Error) => {
          retainResponseEvidence = async () => {
            const evidenceBody =
              errorBody ??
              (response.ok
                ? capturedErrorText(body, transport !== null)
                : await captureErrorBody())
            captureProviderResponseEvidence(
              error,
              diagnostics,
              contentType,
              evidenceBody,
              url,
              init?.headers,
            )
          }
        }
        if (response.status === 404 && options?.notFoundOn404) {
          const error = new ProviderItemNotFoundError(
            'Provider has no matching item (HTTP 404)',
          )
          attachEvidence(error)
          throw error
        }
        const limited = response.status === 429 || apiLimit || transientQuota
        const denied = response.status === 401 || response.status === 403
        const now = Date.now()
        const retryAfter = response.headers.get('retry-after')
        const errorBackoff = plugin.manifest.rateLimit.errorBackoffMs ?? 60000
        if (
          retryPolicy &&
          !limited &&
          !denied &&
          dispatchResult.status === 'fulfilled' &&
          transientStatus
        ) {
          const wait = retryPolicy.attempt === 1 ? 5000 : 10000
          const retryAt = retryAfterTime(
            retryAfter,
            responseReceivedAt,
            Math.max(wait, plugin.manifest.rateLimit.errorBackoffMs ?? 0),
          )
          const retryBefore =
            pending?.retryBefore ??
            responseReceivedAt + TRANSIENT_RETRY_WINDOW_MS
          const canRetry =
            retryPolicy.attempt < TRANSIENT_MAX_ATTEMPTS &&
            Math.max(now, retryAt) < retryBefore
          transient = {
            retryAt,
            retryBefore,
            disposition:
              retryAt > responseReceivedAt + TRANSIENT_RETRY_WINDOW_MS
                ? 'cooldown'
                : canRetry
                  ? 'retry'
                  : 'backoff',
          }
        }
        const until = limited
          ? rateLimitRetryAt(
              response.headers,
              responseReceivedAt,
              plugin.manifest.rateLimit.rateLimitCooldownMs ?? 60000,
              quota,
              plugin.manifest.rateLimit.retryAfterIsAuthoritative,
            )
          : (transient?.retryAt ??
            ((response.status === 400 || response.status >= 500) &&
            (errorBackoff > 0 || retryAfter !== null)
              ? retryAfterTime(retryAfter, responseReceivedAt, errorBackoff)
              : null))
        const error = new ProviderRequestError(
          limited
            ? response.status === 429
              ? 'Provider rate limit reached (HTTP 429)'
              : `Provider quota error (HTTP ${response.status})`
            : `Provider request failed (HTTP ${response.status})`,
          limited ? 'rate-limit' : denied ? 'access-denied' : 'request-failed',
          until,
          false,
          { diagnostics },
        )
        attachEvidence(error)
        throw error
      }
      // HTTP safety signals take precedence over dispatch bookkeeping errors.
      if (dispatchResult.status === 'rejected') throw dispatchResult.reason
      return new Response(
        response.status === 204 || response.status === 205 ? null : body,
        {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        },
      )
    } catch (error) {
      if (requestStartedAt === undefined) throw error
      if (isProviderItemNotFoundError(error)) {
        await retainResponseEvidence?.()
        throw error
      }
      if (error instanceof ProviderRequestError && error.recorded) throw error
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
      await recordProviderFailure(plugin, safe, transient?.disposition)
      await retainResponseEvidence?.()
      const recorded = new ProviderRequestError(
        safe.message,
        safe.code,
        safe.retryAt,
        true,
        { cause: safe, diagnostics: safe.diagnostics },
      )
      if (transient?.disposition === 'retry')
        return {
          error: recorded,
          retryAt: transient.retryAt,
          retryBefore: transient.retryBefore,
        }
      throw recorded
    } finally {
      await db.transaction(async (tx) => {
        const [state] = await tx
          .select()
          .from(providerRequestState)
          .where(eq(providerRequestState.provider, plugin.manifest.id))
          .for('update')
        if (state) {
          const accountingAt = requestStartedAt
          const recoverRemoteAccounting =
            transport !== null &&
            !remoteAccountingComplete &&
            accountingAt !== undefined
          if (recoverRemoteAccounting && accountingAt !== undefined)
            await tx
              .update(providerRequestEvent)
              .set({ requestedAt: new Date(accountingAt) })
              .where(eq(providerRequestEvent.id, token))
          await tx
            .update(providerRequestState)
            .set({
              ...(recoverRemoteAccounting && accountingAt !== undefined
                ? {
                    requests: state.requests.map((time, index) =>
                      index === state.requests.lastIndexOf(reservedAt)
                        ? Math.max(time, accountingAt)
                        : time,
                    ),
                  }
                : {}),
              ...(requestStartedAt === undefined
                ? {}
                : {
                    nextAllowedAt: new Date(
                      Math.max(
                        state.nextAllowedAt?.getTime() ?? 0,
                        requestStartedAt + plugin.manifest.rateLimit.minTimeMs,
                      ),
                    ),
                  }),
              ...(state.leaseId === token
                ? { leaseId: null, leaseUntil: null }
                : {}),
              requestLeases: state.requestLeases.filter(
                (lease) => lease.id !== token && lease.expiresAt > Date.now(),
              ),
            })
            .where(eq(providerRequestState.provider, plugin.manifest.id))
        }
      })
    }
  }
  const onRetry = configuration.onRetry
  return async (...args) => {
    const [, init] = args
    const retryEnabled =
      onRetry !== undefined &&
      !plugin.manifest.rateLimit.concurrentRequests &&
      (init?.method ?? 'GET').toUpperCase() === 'GET' &&
      init?.body == null
    let pending: PendingProviderRetry | undefined
    for (let attempt = 1; ; attempt += 1) {
      const result = await requestOnce(
        retryEnabled ? { attempt, pending } : null,
        ...args,
      )
      if (result instanceof Response) return result
      pending = result
      if (Date.now() >= result.retryBefore) await expireRetry(result)
      try {
        await onRetry?.({
          error: result.error,
          attempt: attempt + 1,
          retryAt: result.retryAt,
        })
      } catch {
        await failRetry(result, 'Could not record the request retry.')
      }
    }
  }
}
