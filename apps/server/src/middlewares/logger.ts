import { createMiddleware } from 'hono/factory'

export function logger() {
  return createMiddleware(async (c, next) => {
    const startedAt = Date.now()
    await next()
    const durationMs = Date.now() - startedAt

    console.info(
      `${c.req.method} ${new URL(c.req.url).pathname} ${c.res.status} ${durationMs}ms`,
    )
  })
}
