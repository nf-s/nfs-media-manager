import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import {
  SONOS_PAGE_HEADER,
  SONOS_REASON_HEADER,
  SonosPageHeaderSchema,
  SonosStateReasonSchema,
  type SonosStateReason,
} from '@repo/schemas/sonos'
import { env } from '@/env'
import type { SonosRateLimit } from '@/lib/sonos-rate-limit'

interface RequestLogContext {
  requestId: string
  route: string
  page?: string
  visibility?: 'visible' | 'hidden'
  playbackRole?: 'driver' | 'follower'
  stateReason?: SonosStateReason
}

interface SonosDispatch {
  attemptId: string
  operation: string
  method: string
}

type RequestEvent =
  | { event: 'api.request'; method: string; status: number; durationMs: number }
  | (SonosDispatch & { event: 'sonos.dispatch' })
  | (SonosDispatch & {
      event: 'sonos.request'
      status: number | null
      durationMs: number
      outcome:
        | 'success'
        | 'http_error'
        | 'network_error'
        | 'timeout'
        | 'aborted'
      retryAfterMs?: number
    })
  | (SonosDispatch & {
      event: 'sonos.rate-limit'
      reason: SonosRateLimit['reason']
      retryAt: number | null
    })
  | {
      event: 'sonos.blocked'
      reason: 'cooldown' | 'access-denied'
      retryAt?: number
    }

const context = new AsyncLocalStorage<RequestLogContext>()
const methods = new Set([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
])

export function writeRequestLog(event: RequestEvent) {
  const record = {
    timestamp: new Date().toISOString(),
    ...context.getStore(),
    ...event,
  }
  // Workers indexes object fields. Node process logs use one JSON record per line.
  console.info(
    env.RUNTIME_KIND === 'cloudflare' ? record : JSON.stringify(record),
  )
}

/** route is a registered handler pattern, never the requested URL. */
export function setRequestLogRoute(route: string, headers: Headers) {
  const current = context.getStore()
  if (!current) return
  current.route = route
  if (
    !route.startsWith('/api/v1/sonos/') &&
    route !== '/api/v1/playback/session'
  )
    return
  const parsed = SonosPageHeaderSchema.safeParse(headers.get(SONOS_PAGE_HEADER))
  if (parsed.success) {
    const [id, visibility] = parsed.data
    current.page = createHash('sha256').update(id).digest('hex').slice(0, 16)
    current.visibility = visibility
  }
  if (route.endsWith('/state')) {
    const reason = SonosStateReasonSchema.safeParse(
      headers.get(SONOS_REASON_HEADER),
    )
    if (reason.success) current.stateReason = reason.data
  }
}

export function setPlaybackLogRole(role: 'driver' | 'follower') {
  const current = context.getStore()
  if (current) current.playbackRole = role
}

/** Owns one access record at the HTTP entry point, including early responses. */
export function logApiRequest(
  request: Request,
  respond: () => Response | Promise<Response>,
) {
  return context.run(
    { requestId: randomUUID(), route: 'unmatched' },
    async () => {
      const start = Date.now()
      let status = 500
      try {
        const response = await respond()
        status = response.status
        return response
      } finally {
        writeRequestLog({
          event: 'api.request',
          method: methods.has(request.method) ? request.method : 'OTHER',
          status,
          durationMs: Date.now() - start,
        })
      }
    },
  )
}
