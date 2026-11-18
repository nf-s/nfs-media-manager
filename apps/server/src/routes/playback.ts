import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import { bodyLimit } from 'hono/body-limit'
import { createMiddleware } from 'hono/factory'
import {
  PlaybackReleaseInputSchema,
  PlaybackReleaseResultSchema,
  PlaybackSyncInputSchema,
  PlaybackSyncResultSchema,
} from '@repo/schemas/playback'
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
import { setPlaybackLogRole } from '@/lib/request-log'
import { generateJsonResponse } from '@/lib/response'
import { authMiddleware, requireBrowserSession } from '@/middlewares/auth'
import {
  releaseUserPlayback,
  syncUserPlayback,
} from '@/services/playback-session-store'

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

/** A saved session holds the queue and source progress, up to 2 MB. */
const sessionBodyLimit = bodyLimit({
  maxSize: 2 * 1024 * 1024,
  onError: (c) =>
    generateJsonResponse(c, null, 413, 'Playback state exceeds the size limit'),
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
    path: '/session',
    security: ownerSessionSecurity,
    middleware: [browserSession, sameOrigin, sessionBodyLimit],
    request: {
      body: {
        required: true,
        content: { 'application/json': { schema: PlaybackSyncInputSchema } },
      },
    },
    responses: {
      200: {
        description:
          "Renew or take the driver lease, save the driver's state and read the account's shared playback session",
        content: {
          'application/json': {
            schema: createResponseSchema(PlaybackSyncResultSchema),
          },
        },
      },
      401: jsonErrorResponse('Owner browser session required'),
      403: jsonErrorResponse('Forbidden'),
      413: jsonErrorResponse('Playback state exceeds the size limit'),
      422: validationErrorResponse,
      503: jsonErrorResponse('Playback sessions unavailable'),
    },
  }),
  async (c) => {
    const result = await syncUserPlayback(
      requireBrowserSession(c).user.id,
      c.req.valid('json'),
    )
    setPlaybackLogRole(result.role)
    return generateJsonResponse(c, result, 200)
  },
)

app.openapi(
  createRoute({
    method: 'post',
    path: '/session/release',
    security: ownerSessionSecurity,
    middleware: [browserSession, sameOrigin, sessionBodyLimit],
    request: {
      body: {
        required: true,
        content: {
          'application/json': { schema: PlaybackReleaseInputSchema },
        },
      },
    },
    responses: {
      200: {
        description:
          "Give up the driver lease, saving the client's last state when its revision is current",
        content: {
          'application/json': {
            schema: createResponseSchema(PlaybackReleaseResultSchema),
          },
        },
      },
      401: jsonErrorResponse('Owner browser session required'),
      403: jsonErrorResponse('Forbidden'),
      413: jsonErrorResponse('Playback state exceeds the size limit'),
      422: validationErrorResponse,
      503: jsonErrorResponse('Playback sessions unavailable'),
    },
  }),
  async (c) =>
    generateJsonResponse(
      c,
      await releaseUserPlayback(
        requireBrowserSession(c).user.id,
        c.req.valid('json'),
      ),
      200,
    ),
)

export default app
