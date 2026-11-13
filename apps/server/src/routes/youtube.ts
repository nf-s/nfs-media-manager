import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import { createMiddleware } from 'hono/factory'
import type { Context } from 'hono'
import {
  YoutubeAuthorizeInputSchema,
  YoutubeAuthorizeResultSchema,
  YoutubeCallbackSchema,
  YoutubeDisconnectResultSchema,
} from '@repo/schemas/youtube'
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
  authorizeYoutube,
  disconnectYoutube,
  finishYoutubeAuthorization,
  youtubeCallbackDestination,
} from '@/services/youtube-oauth'

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
    method: 'post',
    path: '/authorize',
    middleware: [authMiddleware(), sameOrigin],
    request: {
      body: {
        required: true,
        content: {
          'application/json': { schema: YoutubeAuthorizeInputSchema },
        },
      },
    },
    responses: {
      200: {
        description:
          'Explicit OAuth authorization URL for read-only YouTube access',
        content: {
          'application/json': {
            schema: createResponseSchema(YoutubeAuthorizeResultSchema),
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
      await authorizeYoutube(
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
    request: { query: YoutubeCallbackSchema },
    responses: {
      302: { description: 'Relay to the configured authenticated API origin' },
      422: validationErrorResponse,
    },
  }),
  (c) => c.redirect(youtubeCallbackDestination(c.req.valid('query')), 302),
)

app.openapi(
  createRoute({
    method: 'get',
    path: '/complete',
    middleware: [authMiddleware()],
    request: { query: YoutubeCallbackSchema },
    responses: {
      302: {
        description:
          'Return to the YouTube import page, without exposing tokens or authorization codes',
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
      const result = await finishYoutubeAuthorization(
        c.req.valid('query'),
        current.userId,
        current.sessionId,
      )
      connected = result.connected
      returnOrigin = result.returnOrigin
    } catch {
      /* Never expose token responses, codes or state in the redirect. */
    }
    const destination = new URL('/imports/youtube', returnOrigin)
    destination.search = new URLSearchParams({
      mediaType: 'subscription',
      youtube: connected ? 'connected' : 'error',
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
          'Delete this user account tokens and pending authorization locally; stored videos are kept',
        content: {
          'application/json': {
            schema: createResponseSchema(YoutubeDisconnectResultSchema),
          },
        },
      },
      401: jsonErrorResponse('Unauthorized'),
    },
  }),
  async (c) =>
    generateJsonResponse(c, await disconnectYoutube(actor(c).userId), 200),
)

app.onError((error, c) =>
  error instanceof ServerError
    ? c.json(error.response, error.response.statusCode)
    : generateJsonResponse(c, null, 500, 'YouTube operation failed'),
)

export default app
