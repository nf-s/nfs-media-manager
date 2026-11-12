import { readClientIp, trustedClientIpHeader } from './api-proxy'
import { privateResponse } from './private-response'

function requiresAuthRateLimit(request: Request): boolean {
  const path = decodeURIComponent(new URL(request.url).pathname)
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '')
    .toLowerCase()
  if (!path.startsWith('/api/auth/')) return false
  if (request.method === 'OPTIONS') return false
  if (path === '/api/auth/sign-out' && request.method === 'POST') return false
  if (
    path === '/api/auth/get-session' &&
    (request.method === 'GET' || request.method === 'HEAD')
  )
    return false
  return true
}

export async function protectCloudAuth(
  request: Request,
  limiter: CloudflareEnv['AUTH_RATE_LIMITER'] | undefined,
  next: (request: Request) => Promise<Response>,
): Promise<Response> {
  let limited: boolean
  try {
    limited = requiresAuthRateLimit(request)
  } catch {
    return privateResponse(new Response(null, { status: 404 }))
  }

  // Never accept client-supplied forwarding headers as proof of source address.
  const clientIp = readClientIp(request.headers.get('cf-connecting-ip'))
  const headers = new Headers(request.headers)
  headers.delete(trustedClientIpHeader)
  if (clientIp) headers.set(trustedClientIpHeader, clientIp)

  if (limited) {
    if (!limiter || !clientIp) {
      return privateResponse(
        Response.json(
          { message: 'Authentication unavailable' },
          { status: 503 },
        ),
      )
    }
    try {
      // One ephemeral key across login, disabled signup and reset endpoints.
      const { success } = await limiter.limit({ key: clientIp })
      if (!success) {
        return privateResponse(
          Response.json(
            { message: 'Too many authentication attempts' },
            { status: 429, headers: { 'Retry-After': '60' } },
          ),
        )
      }
    } catch {
      return privateResponse(
        Response.json(
          { message: 'Authentication unavailable' },
          { status: 503 },
        ),
      )
    }
  }

  return next(new Request(request, { headers }))
}
