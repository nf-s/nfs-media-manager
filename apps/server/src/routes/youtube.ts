import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import { createMiddleware } from 'hono/factory'
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
  ownerSessionSecurity,
  validationErrorResponse,
  type AppEnv,
} from '@/lib/openapi'
import { generateJsonResponse } from '@/lib/response'
import { authMiddleware, requireBrowserSession } from '@/middlewares/auth'
import {
  authorizeYoutube,
  disconnectYoutube,
  finishYoutubeAuthorization,
  youtubeCallbackDestination,
} from '@/services/youtube-oauth'

const browserSession = authMiddleware({ sessionOnly: true })

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
    security: ownerSessionSecurity,
    middleware: [browserSession, sameOrigin],
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
      401: jsonErrorResponse('Owner browser session required'),
      403: jsonErrorResponse('Forbidden'),
      422: validationErrorResponse,
    },
  }),
  async (c) => {
    const { user, session } = requireBrowserSession(c)
    return generateJsonResponse(
      c,
      await authorizeYoutube(user.id, session.id, c.req.header('origin')),
      200,
    )
  },
)

app.openapi(
  createRoute({
    method: 'get',
    path: '/callback',
    security: [],
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
    security: ownerSessionSecurity,
    middleware: [browserSession],
    request: { query: YoutubeCallbackSchema },
    responses: {
      302: {
        description:
          'Return to the YouTube import page, without exposing tokens or authorization codes',
      },
      401: jsonErrorResponse('Owner browser session required'),
      403: jsonErrorResponse('Forbidden'),
      422: validationErrorResponse,
    },
  }),
  async (c) => {
    const { user, session } = requireBrowserSession(c)
    let connected = false
    let returnOrigin = env.APP_URL
    try {
      const result = await finishYoutubeAuthorization(
        c.req.valid('query'),
        user.id,
        session.id,
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
    security: ownerSessionSecurity,
    middleware: [browserSession, sameOrigin],
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
      401: jsonErrorResponse('Owner browser session required'),
      403: jsonErrorResponse('Forbidden'),
    },
  }),
  async (c) =>
    generateJsonResponse(
      c,
      await disconnectYoutube(requireBrowserSession(c).user.id),
      200,
    ),
)

app.onError((error, c) =>
  error instanceof ServerError
    ? c.json(error.response, error.response.statusCode)
    : generateJsonResponse(c, null, 500, 'YouTube operation failed'),
)

export default app
