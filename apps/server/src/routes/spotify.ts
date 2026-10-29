import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import { createMiddleware } from 'hono/factory'
import type { Context } from 'hono'
import {
  SpotifyAccountStatusSchema,
  SpotifyAuthorizeInputSchema,
  SpotifyAuthorizeResultSchema,
  SpotifyCallbackSchema,
  SpotifyDisconnectResultSchema,
  SpotifySavedAlbumsInputSchema,
} from '@repo/schemas/spotify'
import { AlbumImportPreviewSchema } from '@repo/schemas/album-imports'
import { env } from '@/env'
import { ServerError } from '@/lib/error'
import {
  createOpenAPIApp,
  createResponseSchema,
  jsonErrorResponse,
  validationErrorResponse,
  type AppEnv,
} from '@/lib/openapi'
import { generateJsonResponse } from '@/lib/response'
import { authMiddleware } from '@/middlewares/auth'
import {
  authorizeSpotify,
  disconnectSpotify,
  finishSpotifyAuthorization,
  getSpotifyAccountStatus,
  spotifyCallbackDestination,
} from '@/services/spotify-oauth'
import { previewSpotifyAlbums } from '@/services/spotify-imports'

function actor(c: Context<AppEnv>) {
  const user = c.get('user')
  const session = c.get('session')
  if (!user || !session)
    throw new ServerError({ statusCode: 401, message: 'Unauthorized' })
  return { userId: user.id, sessionId: session.id }
}

const sameOrigin = createMiddleware<AppEnv>(async (c, next) => {
  const origin = c.req.header('origin')
  if (
    (origin && !env.TRUSTED_ORIGINS.includes(origin)) ||
    c.req.header('sec-fetch-site') === 'cross-site'
  ) {
    throw new ServerError({
      statusCode: 403,
      message: 'Request origin is not allowed',
    })
  }
  await next()
})

const app: OpenAPIHono<AppEnv> = createOpenAPIApp()
app.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store')
  c.header('Referrer-Policy', 'no-referrer')
  await next()
})
app.openapi(
  createRoute({
    method: 'get',
    path: '/status',
    middleware: [authMiddleware()],
    responses: {
      200: {
        description: 'Local account connection status; no Spotify requests',
        content: {
          'application/json': {
            schema: createResponseSchema(SpotifyAccountStatusSchema),
          },
        },
      },
      401: jsonErrorResponse('Unauthorized'),
    },
  }),
  async (c) =>
    generateJsonResponse(
      c,
      await getSpotifyAccountStatus(actor(c).userId),
      200,
    ),
)

app.openapi(
  createRoute({
    method: 'post',
    path: '/authorize',
    middleware: [authMiddleware(), sameOrigin],
    request: {
      body: {
        required: true,
        content: {
          'application/json': { schema: SpotifyAuthorizeInputSchema },
        },
      },
    },
    responses: {
      200: {
        description: 'Explicit read-only OAuth authorization URL',
        content: {
          'application/json': {
            schema: createResponseSchema(SpotifyAuthorizeResultSchema),
          },
        },
      },
      401: jsonErrorResponse('Unauthorized'),
      422: validationErrorResponse,
    },
  }),
  async (c) => {
    const current = actor(c)
    return generateJsonResponse(
      c,
      await authorizeSpotify(
        current.userId,
        current.sessionId,
        c.req.header('origin'),
      ),
      200,
    )
  },
)

app.openapi(
  createRoute({
    method: 'get',
    path: '/callback',
    request: { query: SpotifyCallbackSchema },
    responses: {
      302: { description: 'Relay to the configured authenticated API origin' },
      422: validationErrorResponse,
    },
  }),
  (c) => c.redirect(spotifyCallbackDestination(c.req.valid('query')), 302),
)

app.openapi(
  createRoute({
    method: 'get',
    path: '/complete',
    middleware: [authMiddleware()],
    request: { query: SpotifyCallbackSchema },
    responses: {
      302: {
        description:
          'Return to album imports, without exposing tokens or authorization codes',
      },
      401: jsonErrorResponse('Unauthorized'),
      422: validationErrorResponse,
    },
  }),
  async (c) => {
    const current = actor(c)
    let connected = false
    let returnOrigin = env.APP_URL
    try {
      const result = await finishSpotifyAuthorization(
        c.req.valid('query'),
        current.userId,
        current.sessionId,
      )
      connected = result.connected
      returnOrigin = result.returnOrigin
    } catch {
      /* Never expose token responses, codes or state in the redirect. */
    }
    const destination = new URL('/imports/spotify', returnOrigin)
    destination.search = new URLSearchParams({
      mediaType: 'album',
      spotify: connected ? 'connected' : 'error',
    }).toString()
    return c.redirect(destination.toString(), 302)
  },
)

app.openapi(
  createRoute({
    method: 'delete',
    path: '/account',
    middleware: [authMiddleware(), sameOrigin],
    responses: {
      200: {
        description:
          'Delete this user account tokens and pending authorization locally',
        content: {
          'application/json': {
            schema: createResponseSchema(SpotifyDisconnectResultSchema),
          },
        },
      },
      401: jsonErrorResponse('Unauthorized'),
    },
  }),
  async (c) =>
    generateJsonResponse(c, await disconnectSpotify(actor(c).userId), 200),
)

app.openapi(
  createRoute({
    method: 'post',
    path: '/preview',
    middleware: [authMiddleware(), sameOrigin],
    request: {
      body: {
        required: true,
        content: {
          'application/json': { schema: SpotifySavedAlbumsInputSchema },
        },
      },
    },
    responses: {
      200: {
        description:
          'Explicit bounded saved album discovery; no canonical writes or jobs',
        content: {
          'application/json': {
            schema: createResponseSchema(AlbumImportPreviewSchema),
          },
        },
      },
      401: jsonErrorResponse('Unauthorized'),
      422: validationErrorResponse,
    },
  }),
  async (c) =>
    generateJsonResponse(
      c,
      await previewSpotifyAlbums(c.req.valid('json'), actor(c).userId),
      200,
    ),
)

app.onError((error, c) =>
  error instanceof ServerError
    ? c.json(error.response, error.response.statusCode)
    : generateJsonResponse(c, null, 500, 'Spotify operation failed'),
)

export default app
