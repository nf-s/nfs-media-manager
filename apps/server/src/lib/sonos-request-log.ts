import { randomUUID } from 'node:crypto'
import { ProviderRequestError } from '@repo/media-plugin-sdk'
import { writeRequestLog } from '@/lib/request-log'
import { retryAfterTime } from '@/lib/request-policy'
import {
  SONOS_CONTROL_API,
  SONOS_TOKEN_API,
  type SonosRequest,
} from '@/lib/sonos-api'

const controlApi = new URL(SONOS_CONTROL_API)
const tokenApi = new URL(SONOS_TOKEN_API)
type TokenOperation = 'oauth.exchange' | 'oauth.refresh'
type SonosMethod = 'GET' | 'POST' | 'UNKNOWN'

/** Report known operations without copying a URL segment to the log. */
function operationFor(
  input: string | URL,
  method: SonosMethod,
  tokenOperation: TokenOperation,
) {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return 'unknown'
  }
  if (url.origin === tokenApi.origin && url.pathname === tokenApi.pathname)
    return method === 'POST' ? tokenOperation : 'unknown'
  if (
    url.origin !== controlApi.origin ||
    !url.pathname.startsWith(`${controlApi.pathname}/`)
  )
    return 'unknown'
  const path = url.pathname.slice(controlApi.pathname.length)
  if (method === 'GET') {
    if (path === '/households') return 'households.list'
    if (/^\/households\/[^/]+\/groups$/.test(path)) return 'groups.list'
  }
  const endpoint = /^\/groups\/[^/]+\/(.+)$/.exec(path)?.[1]
  switch (`${method} ${endpoint}`) {
    case 'GET playback':
      return 'group.playback'
    case 'GET playbackMetadata':
      return 'group.metadata'
    case 'GET groupVolume':
      return 'group.volume'
    case 'POST playback/play':
      return 'group.play'
    case 'POST playback/pause':
      return 'group.pause'
    case 'POST playback/skipToNextTrack':
      return 'group.next'
    case 'POST playback/skipToPreviousTrack':
      return 'group.previous'
    case 'POST playback/seek':
      return 'group.seek'
    case 'POST groupVolume':
      return 'group.set-volume'
    case 'POST playback/content':
      return 'group.load-content'
    default:
      return 'unknown'
  }
}

function failedOutcome(signal: AbortSignal | null | undefined) {
  if (!signal?.aborted) return 'network_error'
  return signal.reason instanceof DOMException &&
    signal.reason.name === 'TimeoutError'
    ? 'timeout'
    : 'aborted'
}

/** Measures the dispatch up to response headers or a fetch failure. */
export function createSonosRequestFetch(tokenOperation: TokenOperation) {
  return async (url: string | URL, init: RequestInit): Promise<Response> => {
    const method =
      init.method === 'POST'
        ? 'POST'
        : init.method === undefined || init.method === 'GET'
          ? 'GET'
          : 'UNKNOWN'
    const attempt = {
      attemptId: randomUUID(),
      operation: operationFor(url, method, tokenOperation),
      method,
    }
    writeRequestLog({ event: 'sonos.dispatch', ...attempt })
    const startedAt = performance.now()
    let response: Response
    try {
      response = await fetch(url, init)
    } catch (error) {
      writeRequestLog({
        event: 'sonos.request',
        ...attempt,
        status: null,
        durationMs: Math.round(performance.now() - startedAt),
        outcome: failedOutcome(init.signal),
      })
      throw error
    }
    const durationMs = Math.round(performance.now() - startedAt)
    const receivedAt = Date.now()
    const retryAfterMs =
      retryAfterTime(response.headers.get('retry-after'), receivedAt, 0) -
      receivedAt
    writeRequestLog({
      event: 'sonos.request',
      ...attempt,
      status: response.status,
      durationMs,
      outcome: response.ok ? 'success' : 'http_error',
      ...(retryAfterMs > 0 ? { retryAfterMs } : {}),
    })
    return response
  }
}

/** Records an attempted operation that the local provider gate refused to send. */
export function logSonosBlocked(request: SonosRequest): SonosRequest {
  return async (...args) => {
    try {
      return await request(...args)
    } catch (error) {
      if (error instanceof ProviderRequestError) {
        const source = error.diagnostics?.source
        if (source === 'local-cooldown' || source === 'local-access-halt')
          writeRequestLog({
            event: 'sonos.blocked',
            reason: source === 'local-cooldown' ? 'cooldown' : 'access-denied',
            ...(error.retryAt !== null && Number.isSafeInteger(error.retryAt)
              ? { retryAt: error.retryAt }
              : {}),
          })
      }
      throw error
    }
  }
}
