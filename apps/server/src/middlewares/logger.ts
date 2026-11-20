import { createMiddleware } from 'hono/factory'
import { matchedRoutes } from 'hono/route'
import { setRequestLogRoute } from '@/lib/request-log'

export function logger() {
  return createMiddleware(async (c, next) => {
    const routes = matchedRoutes(c)
    const candidate = routes.find(({ method }) => method !== 'ALL')
    // Downstream Sonos logs and early responses need a label before dispatch.
    if (candidate) setRequestLogRoute(candidate.path, c.req.raw.headers)
    try {
      await next()
    } finally {
      const resolved = routes[c.req.routeIndex]
      if (resolved && resolved.method !== 'ALL' && resolved !== candidate)
        setRequestLogRoute(resolved.path, c.req.raw.headers)
    }
  })
}
