import { createMiddleware } from 'hono/factory'
import { auth, type AuthType } from '@/lib/auth'
import { ServerError } from '@/lib/error'

export function authMiddleware() {
  return createMiddleware<{ Variables: AuthType }>(async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers })

    if (!session) {
      throw new ServerError({
        statusCode: 401,
        message: 'Unauthorized',
        description: 'You must be signed in to access this resource.',
      })
    }

    c.set('user', session.user)
    c.set('session', session.session)

    await next()
  })
}
