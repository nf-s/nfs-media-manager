import { createMiddleware } from 'hono/factory'
import { APIError } from 'better-auth/api'
import { auth, type AuthType } from '@/lib/auth'
import { ServerError } from '@/lib/error'
import { env } from '@/env'
import { isMutationOriginAllowed, isOwnerUser } from '@/lib/owner'

export function authMiddleware() {
  return createMiddleware<{ Variables: AuthType }>(async (c, next) => {
    c.header('Cache-Control', 'no-store')
    if (c.get('session') === undefined) {
      try {
        const session = await auth.api.getSession({
          headers: c.req.raw.headers,
        })
        c.set('user', session?.user ?? null)
        c.set('session', session?.session ?? null)
      } catch (error) {
        if (error instanceof APIError && error.status === 'FORBIDDEN') {
          throw new ServerError({ statusCode: 403, message: 'Forbidden' })
        }
        throw error
      }
    }

    if (!c.get('session') || !c.get('user')) {
      throw new ServerError({
        statusCode: 401,
        message: 'Unauthorized',
        description: 'You must be signed in to access this resource.',
      })
    }

    if (
      c.get('user')?.id !== c.get('session')?.userId ||
      !isOwnerUser(c.get('user'), env)
    ) {
      throw new ServerError({ statusCode: 403, message: 'Forbidden' })
    }

    await next()
  })
}

export function mutationOriginMiddleware() {
  return createMiddleware(async (c, next) => {
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) &&
      !isMutationOriginAllowed(c.req.raw.headers, env)
    ) {
      throw new ServerError({
        statusCode: 403,
        message: 'Request origin is not allowed',
      })
    }
    await next()
  })
}
