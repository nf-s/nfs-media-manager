import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import type { Logger } from 'drizzle-orm/logger'
import type { BrowserBrowseTiming } from '@repo/schemas/performance'
import {
  SONOS_PAGE_HEADER,
  SONOS_REASON_HEADER,
  SonosPageHeaderSchema,
  SonosStateReasonSchema,
  type SonosStateReason,
} from '@repo/schemas/sonos'
import { env } from '@/env'
import type { SonosRateLimit } from '@/lib/sonos-rate-limit'

interface RequestLogDetails {
  requestId: string
  route: string
  page?: string
  visibility?: 'visible' | 'hidden'
  playbackRole?: 'driver' | 'follower'
  stateReason?: SonosStateReason
}

type RequestPhase =
  | 'accessCheck'
  | 'ids'
  | 'hydrate'
  | 'trackDetailHydrate'
  | 'trackDetailListening'
  | 'trackDetailNames'
  | 'trackDetailAlternate'
  | 'count'
  | 'facets'
  | 'facetRead'
  | 'facetBuild'
  | 'facetLive'

interface RequestBrowseProfile {
  grouped: boolean
  depth: 'first' | 'near' | 'deep'
  listening: boolean
  listeningUse?: 'filter' | 'column' | 'both'
  filtered: boolean
  sort: 'added' | 'title' | 'plays' | 'other'
  playSort?: 'scrobbles' | 'listeningScrobbles'
  recordingOrderLookup?: 'hit' | 'miss'
}

interface PhaseMetrics {
  durationMs: number
  drizzleStatementCount: number
}

interface RequestLogContext {
  details: RequestLogDetails
  drizzleStatementCount: number
  phases: Partial<Record<RequestPhase, PhaseMetrics>>
  browse?: RequestBrowseProfile
  recordingOrderRefreshDue?: boolean
}

interface SonosDispatch {
  attemptId: string
  operation: string
  method: string
}

type RequestEvent =
  | ({ event: 'browser.browse' } & BrowserBrowseTiming)
  | { event: 'database.probe'; outcome: 'ok' | 'failed'; durationMs: number }
  | {
      event:
        | 'database.facet-maintenance'
        | 'database.recording-order-maintenance'
      source?: 'scheduled' | 'browse'
      outcome: 'published' | 'skipped' | 'failed'
      durationMs: number
    }
  | ({ event: 'api.request'; method: string; status: number } & PhaseMetrics & {
        phases?: RequestLogContext['phases']
        browse?: RequestBrowseProfile
      })
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
const phaseContext = new AsyncLocalStorage<{
  request: RequestLogContext
  drizzleStatementCount: number
}>()
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
    ...context.getStore()?.details,
    ...event,
  }
  // Workers indexes object fields. Node process logs use one JSON record per line.
  try {
    console.info(
      env.RUNTIME_KIND === 'cloudflare' ? record : JSON.stringify(record),
    )
  } catch {
    // Log delivery failures must not replace an API response or provider result.
  }
}

/** route is a registered handler pattern, never the requested URL. */
export function setRequestLogRoute(route: string, headers: Headers) {
  const current = context.getStore()?.details
  if (!current || current.route === route) return
  current.route = route
  delete current.page
  delete current.visibility
  delete current.stateReason
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
  const current = context.getStore()?.details
  if (current) current.playbackRole = role
}

export function setRequestBrowseProfile({
  grouped,
  depth,
  listening,
  listeningUse,
  filtered,
  sort,
  playSort,
}: RequestBrowseProfile) {
  const current = context.getStore()
  if (current)
    current.browse = {
      grouped,
      depth,
      listening,
      listeningUse,
      filtered,
      sort,
      playSort,
    }
}

export function recordRecordingOrderLookup(
  outcome: 'hit' | 'miss',
  canRefreshAfterBrowse = false,
) {
  const current = context.getStore()
  if (!current?.browse) return
  current.browse.recordingOrderLookup = outcome
  current.recordingOrderRefreshDue = outcome === 'miss' && canRefreshAfterBrowse
}

/** Drizzle calls the hook at execution time, including for prepared statements. */
export const requestQueryLogger: Logger = {
  logQuery() {
    const current = context.getStore()
    if (!current) return
    current.drizzleStatementCount += 1
    const phase = phaseContext.getStore()
    if (phase?.request === current) phase.drizzleStatementCount += 1
  },
}

export async function measureRequestPhase<T>(
  phase: RequestPhase,
  execute: () => Promise<T>,
): Promise<T> {
  const current = context.getStore()
  if (!current) return execute()

  const metrics = { request: current, drizzleStatementCount: 0 }
  const start = performance.now()
  try {
    return await phaseContext.run(metrics, execute)
  } finally {
    const previous = current.phases[phase]
    current.phases[phase] = {
      durationMs: (previous?.durationMs ?? 0) + (performance.now() - start),
      drizzleStatementCount:
        (previous?.drizzleStatementCount ?? 0) + metrics.drizzleStatementCount,
    }
  }
}

/** Owns one access record at the HTTP entry point, including early responses. */
export async function logApiRequest(
  request: Request,
  respond: () => Response | Promise<Response>,
  requestRecordingOrderRefresh?: () => void,
) {
  const current: RequestLogContext = {
    details: { requestId: randomUUID(), route: 'unmatched' },
    drizzleStatementCount: 0,
    phases: {},
  }
  const response = await context.run(current, async () => {
    const start = performance.now()
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
        durationMs: performance.now() - start,
        drizzleStatementCount: current.drizzleStatementCount,
        ...(current.browse && { browse: current.browse }),
        ...(Object.keys(current.phases).length && {
          phases: { ...current.phases },
        }),
      })
    }
  })
  if (
    response.ok &&
    request.method === 'GET' &&
    current.recordingOrderRefreshDue &&
    (current.details.route === '/api/v1/tracks/browse-page' ||
      current.details.route === '/api/v1/tracks/browse-count')
  ) {
    try {
      requestRecordingOrderRefresh?.()
    } catch {
      // A best-effort maintenance registration must not change the response.
    }
  }
  return response
}
