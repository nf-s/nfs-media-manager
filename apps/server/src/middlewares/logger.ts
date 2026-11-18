import { createMiddleware } from 'hono/factory'
import { routePath } from 'hono/route'
import { setRequestLogRoute } from '@/lib/request-log'

export function logger() {
  return createMiddleware(async (c, next) => {
    setRequestLogRoute(routePath(c, -1), c.req.raw.headers)
    await next()
  })
}
