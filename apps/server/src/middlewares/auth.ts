import { createMiddleware } from 'hono/factory'
import type { Context } from 'hono'
import { APIError } from 'better-auth/api'
import { auth, type AuthType } from '@/lib/auth'
import { ServerError } from '@/lib/error'
import { env } from '@/env'
import { measureRequestPhase } from '@/lib/request-log'
import { isMutationOriginAllowed, isOwnerUser } from '@/lib/owner'
import { authenticateApiKey } from '@/services/api-keys'

type AuthContext = Context<{ Variables: AuthType }>

function readBearerKey(headers: Headers): string | undefined {
  return /^Bearer +([^\s,]+)$/i.exec(headers.get('authorization') ?? '')?.[1]
}

export function requireOwnerUser(c: AuthContext) {
  const user = c.get('user')
  if (!user)
    throw new ServerError({
      statusCode: 401,
      message: 'Unauthorized',
      description: 'An owner session or valid API key is required.',
    })
  return user
}

export function requireBrowserSession(c: AuthContext) {
  const session = c.get('session')
  if (!session)
    throw new ServerError({
      statusCode: c.get('apiKeyId') ? 403 : 401,
      message: 'An owner browser session is required',
    })
  return { user: requireOwnerUser(c), session }
}

async function resolveCredentials(c: AuthContext) {
  const headers = c.req.raw.headers
  if (headers.has('authorization')) {
    const key = readBearerKey(headers)
    const result = key ? await authenticateApiKey(key) : null
    if (result?.status === 'limited') {
      c.header('Retry-After', String(result.retryAfter))
      throw new ServerError({
        statusCode: 429,
        message: 'API key request limit reached',
      })
    }
    c.set('apiKeyId', result?.id ?? null)
    c.set('user', result?.user ?? null)
    c.set('session', null)
    return
  }

  let session
  try {
    session = await auth.api.getSession({ headers })
  } catch (error) {
    if (error instanceof APIError && error.status === 'FORBIDDEN') {
      throw new ServerError({ statusCode: 403, message: 'Forbidden' })
    }
    throw error
  }
  if (
    session &&
    (session.user.id !== session.session.userId ||
      !isOwnerUser(session.user, env))
  ) {
    throw new ServerError({ statusCode: 403, message: 'Forbidden' })
  }
  c.set('apiKeyId', null)
  c.set('user', session?.user ?? null)
  c.set('session', session?.session ?? null)
}

export function authMiddleware({ sessionOnly = false } = {}) {
  return createMiddleware<{ Variables: AuthType }>(async (c, next) => {
    c.header('Cache-Control', 'no-store')
    if (c.get('session') === undefined)
      await measureRequestPhase('auth', () => resolveCredentials(c))
    requireOwnerUser(c)
    if (sessionOnly) requireBrowserSession(c)
    await next()
  })
}

export function mutationOriginMiddleware() {
  return createMiddleware(async (c, next) => {
    const headers = c.req.raw.headers
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) &&
      !isMutationOriginAllowed(headers, env) &&
      !(
        // Versioned API middleware must verify the explicit bearer credential.
        // Never use a session if this request supplies an Authorization header.
        (
          c.req.path.startsWith('/api/v1/') &&
          readBearerKey(headers) &&
          !headers.has('origin') &&
          !headers.has('referer') &&
          !headers.has('sec-fetch-site') &&
          !headers.has('sec-fetch-mode')
        )
      )
    ) {
      throw new ServerError({
        statusCode: 403,
        message: 'Request origin is not allowed',
      })
    }
    await next()
  })
}
