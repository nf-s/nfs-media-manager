import { z } from 'zod'
import {
  requestBudgetWindow,
  unsignedHeaderInteger,
} from '@/lib/request-policy'
import { SONOS_CONTROL_API } from '@/lib/sonos-api'

const controlApi = new URL(SONOS_CONTROL_API)
const QuotaSchema = z.object({
  error: z.literal('Quota violation.'),
  'allowed quota': z.enum([
    '20000 per day per user',
    '600 per minute per user',
    '1000 per minute per client',
  ]),
})
const SpikeArrestSchema = z.object({
  fault: z.object({
    detail: z.object({
      errorcode: z.literal('policies.ratelimit.SpikeArrestViolation'),
    }),
  }),
})

type SonosRateLimitReason =
  | 'daily-quota'
  | 'user-minute-quota'
  | 'app-minute-quota'
  | 'spike-arrest'
  | 'unknown'

export type SonosRateLimit = {
  reason: SonosRateLimitReason
  retryAt: (now: number, failureCount: number) => number
}

export function sonosControlPath(input: string | URL) {
  try {
    const url = input instanceof URL ? input : new URL(input)
    return url.origin === controlApi.origin &&
      url.pathname.startsWith(`${controlApi.pathname}/`)
      ? url.pathname.slice(controlApi.pathname.length)
      : null
  } catch {
    return null
  }
}

function decodedBody(text: string | undefined): unknown {
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function rateLimitReason(
  headers: Headers,
  body: unknown,
): SonosRateLimitReason {
  const quota = QuotaSchema.safeParse(body)
  if (quota.success) {
    switch (quota.data['allowed quota']) {
      case '20000 per day per user':
        return 'daily-quota'
      case '600 per minute per user':
        return 'user-minute-quota'
      case '1000 per minute per client':
        return 'app-minute-quota'
    }
  }
  if (SpikeArrestSchema.safeParse(body).success) return 'spike-arrest'
  if (unsignedHeaderInteger(headers.get('ratelimit-remaining')) === 0) {
    const limit = unsignedHeaderInteger(headers.get('ratelimit-limit'))
    if (limit === 600) return 'user-minute-quota'
    if (limit === 1000) return 'app-minute-quota'
  }
  return 'unknown'
}

function deadline(seconds: number | null, receivedAt: number) {
  if (seconds === null || seconds <= 0) return null
  const retryAt = receivedAt + seconds * 1000
  return Number.isFinite(new Date(retryAt).getTime()) ? retryAt : null
}

/** Interpret only Sonos's documented 429 fields. The error body is read once and discarded. */
export function sonosRateLimit(
  headers: Headers,
  receivedAt: number,
  text: string | undefined,
): SonosRateLimit {
  const reason = rateLimitReason(headers, decodedBody(text))
  if (reason === 'daily-quota')
    return {
      reason,
      retryAt: () => requestBudgetWindow('day', receivedAt).resetsAt,
    }

  const retryAfter = deadline(
    unsignedHeaderInteger(headers.get('retry-after')),
    receivedAt,
  )
  const reset =
    reason === 'user-minute-quota' || reason === 'app-minute-quota'
      ? deadline(
          unsignedHeaderInteger(headers.get('ratelimit-reset')),
          receivedAt,
        )
      : null
  const supplied = retryAfter ?? reset
  return {
    reason,
    retryAt: (now, failureCount) => {
      if (supplied !== null && reason !== 'spike-arrest') return supplied
      const base = 1000 * 2 ** Math.max(0, Math.min(5, failureCount - 1))
      const backoff = now + base + Math.floor(Math.random() * base * 0.5)
      return Math.max(supplied ?? 0, backoff)
    },
  }
}
