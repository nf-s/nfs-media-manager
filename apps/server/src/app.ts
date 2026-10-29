import { Scalar } from '@scalar/hono-api-reference'
import { compress } from 'hono/compress'
import { cors } from 'hono/cors'
import { secureHeaders } from 'hono/secure-headers'
import { env } from '@/env'
import { auth } from '@/lib/auth'
import { ServerError } from '@/lib/error'
import {
  createOpenAPIApp,
  createResponseSchema,
  jsonErrorResponse,
} from '@/lib/openapi'
import { generateJsonResponse } from '@/lib/response'
import { logger } from '@/middlewares/logger'
import albums from '@/routes/albums'
import films from '@/routes/films'
import jobs from '@/routes/jobs'
import imports from '@/routes/imports'
import albumImports from '@/routes/album-imports'
import spotify from '@/routes/spotify'
import media from '@/routes/media'
import providers from '@/routes/providers'
import tags from '@/routes/tags'
import { z } from '@hono/zod-openapi'
import { createRoute } from '@hono/zod-openapi'

const app = createOpenAPIApp({
  strict: false,
})

app.use(compress())
app.use(logger())
app.use(
  cors({
    origin: env.TRUSTED_ORIGINS,
    allowHeaders: ['Content-Type', 'Authorization'],
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    credentials: true,
    exposeHeaders: ['Content-Type', 'Authorization'],
  }),
)
app.use('*', secureHeaders())

app.use('*', async (c, next) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers })

  if (!session) {
    c.set('user', null)
    c.set('session', null)
    return next()
  }

  c.set('user', session.user)
  c.set('session', session.session)

  return next()
})

app.on(['POST', 'GET'], '/api/auth/*', async (c) => {
  return auth.handler(c.req.raw)
})

const v1ApiBase = app.basePath('/api/v1')

v1ApiBase.route('/albums', albums)
v1ApiBase.route('/films', films)
v1ApiBase.route('/media', media)
v1ApiBase.route('/providers', providers)
v1ApiBase.route('/scrape/jobs', jobs)
v1ApiBase.route('/imports', imports)
v1ApiBase.route('/album-imports', albumImports)
v1ApiBase.route('/spotify', spotify)
v1ApiBase.route('/tags', tags)

const v1ApiRoutes = v1ApiBase
  .openapi(
    createRoute({
      method: 'get',
      path: '/healthcheck',
      responses: {
        200: {
          description: 'Service healthcheck.',
          content: {
            'application/json': {
              schema: createResponseSchema(
                z.object({
                  message: z.string(),
                }),
              ),
            },
          },
        },
        500: jsonErrorResponse('Healthcheck failed'),
      },
    }),
    (c) => generateJsonResponse(c, { message: 'OK' }, 200),
  )
  .doc('/doc', (c) => ({
    openapi: '3.0.0',
    info: {
      version: '0.0.1',
      title: 'NFS Media Manager API',
      description: 'Private media admin API.',
    },
    servers: [
      {
        url: (() => {
          const proto = c.req.header('x-forwarded-proto')
          const host = c.req.header('x-forwarded-host') ?? c.req.header('host')
          if (proto && host) return `${proto}://${host}`
          return new URL(c.req.url).origin
        })(),
        description: 'Current environment',
      },
    ],
  }))
  .get('/scalar', Scalar({ url: '/api/v1/doc' }))

app.onError(async (err, c) => {
  if (err instanceof ServerError) {
    return c.json(err.response, err.response.statusCode)
  }

  if (err instanceof Error) {
    return generateJsonResponse(
      c,
      env.NODE_ENV === 'production'
        ? null
        : {
            cause: err.cause,
            stack: err.stack,
          },
      500,
      'Internal Server Error',
    )
  }

  return generateJsonResponse(
    c,
    env.NODE_ENV === 'production' ? null : err,
    500,
    'Internal Server Error',
  )
})

app.notFound((c) =>
  generateJsonResponse(
    c,
    null,
    404,
    "Endpoint you're looking for is not found: " + c.req.url,
  ),
)

export default app
