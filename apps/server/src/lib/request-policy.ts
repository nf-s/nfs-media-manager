import { z } from 'zod'

export const HOUR_MS = 60 * 60 * 1000
export const DAY_MS = 24 * HOUR_MS
export const FAILURE_COOLDOWN_MS = 15 * 60 * 1000
export const MAX_CONSECUTIVE_PROVIDER_FAILURES = 5
/** Maximum time an interactive request waits for a provider slot. */
export const IN_REQUEST_SLOT_WAIT_MS = 10000

export function fixedRequestWindow(durationMs: number, now: number) {
  const from = Math.floor(now / durationMs) * durationMs
  return { from, resetsAt: from + durationMs }
}

const StructuredQuotaErrorSchema = z.object({
  error: z.object({
    code: z.number().int().optional(),
    errors: z.array(z.object({ reason: z.string() })).min(1),
  }),
})
const QuotaMessageSchema = z.object({
  Error: z.string().optional(),
  error: z.string().optional(),
  message: z.string().optional(),
  Message: z.string().optional(),
})

export function hasProviderQuotaError(
  value: unknown,
  allowMessageMatch: boolean,
): boolean {
  const structured = StructuredQuotaErrorSchema.safeParse(value)
  if (
    structured.success &&
    structured.data.error.errors.some(({ reason }) =>
      /^(?:dailyLimitExceeded|rateLimitExceeded|userRateLimitExceeded|quotaExceeded)$/.test(
        reason,
      ),
    )
  )
    return true
  // A denial mentioning quotas is not proof that access was only rate-limited.
  if (!allowMessageMatch) return false
  const message = QuotaMessageSchema.safeParse(value)
  return (
    message.success &&
    /rate.?limit|request.?limit|too many requests|quota|request limit/i.test(
      [
        message.data.Error,
        message.data.error,
        message.data.message,
        message.data.Message,
      ]
        .filter(Boolean)
        .join(' '),
    )
  )
}

export function requestBudgetWindow(period: 'hour' | 'day', now: number) {
  const midnight = Math.floor(now / DAY_MS) * DAY_MS
  return period === 'day'
    ? { from: midnight, resetsAt: midnight + DAY_MS }
    : { from: now - HOUR_MS, resetsAt: now + HOUR_MS }
}

export function unsignedHeaderInteger(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value.trim())) return null
  const number = Number(value)
  return Number.isSafeInteger(number) ? number : null
}

/**
 * The remaining allowance a response reports. `X-RateLimit-Reset` is an epoch
 * time in seconds; with `ietf`, `RateLimit-Reset` is the seconds until reset.
 */
export function responseQuota(headers: Headers, now: number, ietf = false) {
  const prefix = ietf ? 'ratelimit' : 'x-ratelimit'
  const limit = unsignedHeaderInteger(headers.get(`${prefix}-limit`))
  const remaining = unsignedHeaderInteger(headers.get(`${prefix}-remaining`))
  const resetSeconds = unsignedHeaderInteger(headers.get(`${prefix}-reset`))
  const resetMs =
    resetSeconds === null ? 0 : (ietf ? now : 0) + resetSeconds * 1000
  const resetAt =
    resetMs > now && Number.isFinite(new Date(resetMs).getTime())
      ? resetMs
      : null
  return {
    resetAt,
    exhausted:
      limit !== null && limit > 0 && remaining === 0 && resetAt !== null,
  }
}

export function retryAfterTime(
  value: string | null,
  now: number,
  minimumMs: number,
): number {
  const seconds = value === null || value.trim() === '' ? NaN : Number(value)
  const parsed = Number.isFinite(seconds)
    ? now + Math.max(0, seconds) * 1000
    : value
      ? Date.parse(value)
      : NaN
  return Math.max(
    now + minimumMs,
    Number.isFinite(new Date(parsed).getTime()) ? parsed : 0,
  )
}

export function rateLimitRetryAt(
  headers: Headers,
  now: number,
  fallbackMs: number,
  quota: ReturnType<typeof responseQuota> | null,
  authoritative = false,
  ietf = false,
) {
  // Some services report a daily reset even on short-window throttles.
  // Only an exhausted daily allowance should extend their Retry-After.
  // `RateLimit-Reset` counts seconds like `Retry-After` and stands in for it.
  const header =
    headers.get('retry-after') ?? (ietf ? headers.get('ratelimit-reset') : null)
  const retryAt = retryAfterTime(header, now, 0)
  return Math.max(
    !authoritative || quota?.exhausted ? (quota?.resetAt ?? 0) : 0,
    authoritative && retryAt > now
      ? retryAt
      : retryAfterTime(header, now, fallbackMs),
  )
}

export function hourlyBudget(
  requests: number[],
  now: number,
  maximum: number | undefined,
) {
  const recent = requests
    .filter((time) => time > now - HOUR_MS)
    .sort((a, b) => a - b)
  return {
    recent,
    retryAt:
      maximum !== undefined && recent.length >= maximum
        ? (recent[0] ?? now) + HOUR_MS
        : null,
  }
}
