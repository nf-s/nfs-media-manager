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
import { authMiddleware, mutationOriginMiddleware } from '@/middlewares/auth'
import albums from '@/routes/albums'
import films from '@/routes/films'
import tracks from '@/routes/tracks'
import playlists from '@/routes/playlists'
import filmCollections from '@/routes/film-collections'
import jobs from '@/routes/jobs'
import imports from '@/routes/imports'
import albumImports from '@/routes/album-imports'
import spotify from '@/routes/spotify'
import lastfm from '@/routes/lastfm'
import youtube from '@/routes/youtube'
import subscriptions from '@/routes/subscriptions'
import media from '@/routes/media'
import providers from '@/routes/providers'
import tags from '@/routes/tags'
import manualAdd from '@/routes/manual-add'
import ai from '@/routes/ai'
import { z } from '@hono/zod-openapi'
import { createRoute } from '@hono/zod-openapi'

const app = createOpenAPIApp({
  strict: false,
})

// Workers compress responses at the edge; pre-compressing an internal service
// response causes a second compression pass through the Next.js proxy.
if (env.RUNTIME_KIND !== 'cloudflare') app.use(compress())
app.use(logger())
app.use('*', async (c, next) => {
  c.header('Cache-Control', 'private, no-store')
  c.header('CDN-Cache-Control', 'no-store')
  c.header('Cloudflare-CDN-Cache-Control', 'no-store')
  c.header('Referrer-Policy', 'no-referrer')
  await next()
})
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

app.use('*', mutationOriginMiddleware())

app.on(['POST', 'GET'], '/api/auth/*', async (c) => {
  return auth.handler(c.req.raw)
})

const requireOwner = authMiddleware()
app.use('*', (c, next) => {
  // Health probes and the OAuth relays carry no library/account data. The
  // completion endpoints still require the owner session and validate state.
  if (
    ['GET', 'HEAD'].includes(c.req.method) &&
    [
      '/api/v1/healthcheck',
      '/api/v1/healthcheck/',
      '/api/v1/spotify/callback',
      '/api/v1/spotify/callback/',
      '/api/v1/youtube/callback',
      '/api/v1/youtube/callback/',
    ].includes(c.req.path)
  )
    return next()
  return requireOwner(c, next)
})

const v1ApiBase = app.basePath('/api/v1')

v1ApiBase.route('/albums', albums)
v1ApiBase.route('/films', films)
v1ApiBase.route('/tracks', tracks)
v1ApiBase.route('/playlists', playlists)
v1ApiBase.route('/collections', filmCollections)
v1ApiBase.route('/media', media)
v1ApiBase.route('/providers', providers)
v1ApiBase.route('/scrape/jobs', jobs)
v1ApiBase.route('/imports', imports)
v1ApiBase.route('/album-imports', albumImports)
v1ApiBase.route('/spotify', spotify)
v1ApiBase.route('/lastfm', lastfm)
v1ApiBase.route('/youtube', youtube)
v1ApiBase.route('/subscriptions', subscriptions)
v1ApiBase.route('/tags', tags)
v1ApiBase.route('/manual-add', manualAdd)
v1ApiBase.route('/ai', ai)

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
