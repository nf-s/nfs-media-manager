import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import { DrizzleQueryError } from 'drizzle-orm'
import type { Logger } from 'drizzle-orm/logger'
import { ZodError } from 'zod'
import {
  albumBrowseFields,
  filmBrowseFields,
  LIBRARY_PLAYLIST_FILTER_FIELD,
  trackBrowseFields,
} from '@repo/schemas/browse'
import type { BrowserBrowseTiming } from '@repo/schemas/performance'
import {
  SONOS_PAGE_HEADER,
  SONOS_REASON_HEADER,
  SonosPageHeaderSchema,
  SonosStateReasonSchema,
  type SonosStateReason,
} from '@repo/schemas/sonos'
import { env } from '@/env'
import { ProviderResponseStorageError } from '@/lib/provider-response-history'
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
  | 'catalogWriteLock'
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

export interface ListeningRuleProfile {
  count: 'one' | 'multiple'
  match: 'all' | 'any'
  period: 'all' | 'dates' | 'rolling' | 'mixed'
  threshold:
    | 'present'
    | 'absent'
    | 'presentAndAbsent'
    | 'count'
    | 'presenceAndCount'
}

interface RequestBrowseProfile {
  grouped: boolean
  depth: 'first' | 'near' | 'deep'
  listening: boolean
  listeningUse?: 'filter' | 'column' | 'both'
  listeningRules?: ListeningRuleProfile
  filtered: boolean
  searchTerms?: 'one' | 'multiple'
  creatorScoped?: boolean
  sort: 'added' | 'title' | 'plays' | 'other'
  sortField?: string
  filterFields?: string[]
  rangeFields?: string[]
  /** Where Tags filters and the Tags sort read tags: `auto` or `track,album`. */
  tagLevels?: string
  playSort?: 'scrobbles' | 'listeningScrobbles'
  recordingOrderLookup?: 'hit' | 'miss'
}

interface PhaseMetrics {
  durationMs: number
  drizzleStatementCount: number
}

/** Device feed rows that could not be rendered, by entity: no IDs or content. */
type DeviceRenderFailures = Partial<Record<string, number>>

interface RequestLogContext {
  details: RequestLogDetails
  drizzleStatementCount: number
  phases: Partial<Record<RequestPhase, PhaseMetrics>>
  browse?: RequestBrowseProfile
  catalogFailure?: CatalogFailure
  recordingOrderRefreshDue?: boolean
  renderFailures?: DeviceRenderFailures
}

type CatalogFailure =
  | 'lock-timeout'
  | 'query-cancelled'
  | 'transaction-conflict'
  | 'database'
  | 'provider-evidence'
  | 'data-validation'
  | 'other'

interface SonosDispatch {
  attemptId: string
  operation: string
  method: string
}

type RequestEvent =
  | ({ event: 'browser.browse' } & BrowserBrowseTiming)
  | {
      event: 'job.activity'
      outcome: 'stage' | 'failed'
      stage: string
      previousStage?: string
      previousDurationMs?: number
    }
  | { event: 'database.probe'; outcome: 'ok' | 'failed'; durationMs: number }
  | {
      event:
        | 'database.facet-maintenance'
        | 'database.album-facet-maintenance'
        | 'database.recording-order-maintenance'
        | 'database.duplicate-maintenance'
        | 'database.device-feed-maintenance'
      source?: 'scheduled' | 'browse'
      outcome: 'published' | 'skipped' | 'failed'
      durationMs: number
      renderFailures?: DeviceRenderFailures
    }
  | ({ event: 'api.request'; method: string; status: number } & PhaseMetrics & {
        phases?: RequestLogContext['phases']
        browse?: RequestBrowseProfile
        catalogFailure?: CatalogFailure
        renderFailures?: DeviceRenderFailures
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

const catalogRoutes = new Set([
  '/api/v1/catalog/spotify-album-reference',
  '/api/v1/playback/catalog',
])
const catalogLockRoutes = new Set([
  ...catalogRoutes,
  '/api/v1/library-changes/track-merges',
  '/api/v1/tracks/:id/merge',
  '/api/v1/tidal/similar/:kind/:id',
])

export function recordCatalogRequestFailure(error: unknown) {
  const current = context.getStore()
  if (!current || !catalogRoutes.has(current.details.route)) return

  let failure: CatalogFailure = 'other'
  if (error instanceof ProviderResponseStorageError)
    failure = 'provider-evidence'
  else if (error instanceof ZodError) failure = 'data-validation'
  else if (error instanceof DrizzleQueryError) {
    const cause = error.cause
    const code =
      cause && typeof cause === 'object' && 'code' in cause ? cause.code : null
    if (code === '55P03') failure = 'lock-timeout'
    else if (code === '57014') failure = 'query-cancelled'
    else if (code === '40P01' || code === '40001')
      failure = 'transaction-conflict'
    else failure = 'database'
  }
  current.catalogFailure = failure
}

export function measureCatalogWriteLock<T>(acquire: () => Promise<T>) {
  const current = context.getStore()
  return current && catalogLockRoutes.has(current.details.route)
    ? measureRequestPhase('catalogWriteLock', async () => acquire())
    : acquire()
}

export function writeRequestLog(event: RequestEvent) {
  const record = {
    timestamp: new Date().toISOString(),
    ...(event.event === 'job.activity' ? {} : context.getStore()?.details),
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

// Plugin and caller-defined fields can contain installation-specific names.
const publicBrowseFields = new Set([
  ...[...albumBrowseFields, ...filmBrowseFields, ...trackBrowseFields].map(
    (field) => field.key,
  ),
  'listeningScrobbles',
  LIBRARY_PLAYLIST_FILTER_FIELD,
])

function logBrowseField(key: string) {
  return publicBrowseFields.has(key) ? key : 'other'
}

function logBrowseFields(fields?: string[]) {
  if (fields?.length) return [...new Set(fields.map(logBrowseField))].sort()
}

export function setRequestBrowseProfile({
  grouped,
  depth,
  listening,
  listeningUse,
  listeningRules,
  filtered,
  searchTerms,
  creatorScoped,
  sort,
  sortField,
  filterFields,
  rangeFields,
  tagLevels,
  playSort,
}: RequestBrowseProfile) {
  const current = context.getStore()
  if (current)
    current.browse = {
      grouped,
      depth,
      listening,
      listeningUse,
      listeningRules:
        grouped && listeningRules
          ? {
              count: listeningRules.count,
              match: listeningRules.match,
              period: listeningRules.period,
              threshold: listeningRules.threshold,
            }
          : undefined,
      filtered,
      searchTerms,
      creatorScoped,
      sort,
      sortField: sortField && logBrowseField(sortField),
      filterFields: logBrowseFields(filterFields),
      rangeFields: logBrowseFields(rangeFields),
      tagLevels,
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

/** Adds device feed rows the request could not render to its record. */
export function recordDeviceRenderFailures(failures: DeviceRenderFailures) {
  const current = context.getStore()
  if (!current) return
  for (const [entity, count] of Object.entries(failures)) {
    if (!count) continue
    current.renderFailures ??= {}
    current.renderFailures[entity] =
      (current.renderFailures[entity] ?? 0) + count
  }
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
        ...(status >= 500 &&
          current.catalogFailure && { catalogFailure: current.catalogFailure }),
        ...(current.renderFailures && {
          renderFailures: current.renderFailures,
        }),
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
