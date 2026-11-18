import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import { createMiddleware } from 'hono/factory'
import {
  PlaybackClientIdSchema,
  SONOS_PLAYBACK_CLIENT_HEADER,
} from '@repo/schemas/playback'
import {
  SonosAccountStatusSchema,
  SonosAuthorizeInputSchema,
  SonosAuthorizeResultSchema,
  SonosCallbackSchema,
  SonosCommandResultSchema,
  SonosCommandSchema,
  SonosContentInputSchema,
  SonosContentResultSchema,
  SonosDisconnectResultSchema,
  SonosGroupIdSchema,
  SonosGroupStateQuerySchema,
  SonosGroupStateSchema,
  SonosPlaybackMatchSchema,
  SonosPlaybackQuerySchema,
  SonosRoomsSchema,
} from '@repo/schemas/sonos'
import { z } from 'zod'
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
import {
  authMiddleware,
  requireBrowserSession,
  requireOwnerUser,
} from '@/middlewares/auth'
import {
  authorizeSonos,
  disconnectSonos,
  findSonosPlayback,
  finishSonosAuthorization,
  getSonosAccountStatus,
  getSonosGroupState,
  getSonosRooms,
  loadSonosContent,
  sendSonosCommand,
  sonosCallbackDestination,
} from '@/services/sonos-oauth'
import { canUserDispatchSonos } from '@/services/playback-session-store'

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

const playbackDriver = createMiddleware<AppEnv>(async (c, next) => {
  if (c.get('apiKeyId')) return next()
  const client = PlaybackClientIdSchema.nullable().safeParse(
    c.req.header(SONOS_PLAYBACK_CLIENT_HEADER) ?? null,
  )
  if (!client.success)
    throw new ServerError({
      statusCode: 422,
      message: 'Invalid playback client',
    })
  if (!(await canUserDispatchSonos(requireOwnerUser(c).id, client.data)))
    throw new ServerError({
      statusCode: 403,
      message: 'Switch playback control to this page and try again.',
    })
  return next()
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
        description: 'Local account connection status; no Sonos requests',
        content: {
          'application/json': {
            schema: createResponseSchema(SonosAccountStatusSchema),
          },
        },
      },
      401: jsonErrorResponse('Unauthorized'),
    },
  }),
  async (c) =>
    generateJsonResponse(
      c,
      await getSonosAccountStatus(requireOwnerUser(c).id),
      200,
    ),
)

app.openapi(
  createRoute({
    method: 'get',
    path: '/rooms',
    middleware: [authMiddleware(), playbackDriver],
    responses: {
      200: {
        description:
          'Rooms and groups, what they play and the controls Sonos accepts for them',
        content: {
          'application/json': {
            schema: createResponseSchema(SonosRoomsSchema),
          },
        },
      },
      401: jsonErrorResponse('Unauthorized'),
      403: jsonErrorResponse('Playback control is required'),
      422: validationErrorResponse,
    },
  }),
  async (c) =>
    generateJsonResponse(c, await getSonosRooms(requireOwnerUser(c).id), 200),
)

app.openapi(
  createRoute({
    method: 'get',
    path: '/playback',
    middleware: [authMiddleware(), playbackDriver],
    request: { query: SonosPlaybackQuerySchema },
    responses: {
      200: {
        description:
          'The Sonos group playing this Spotify track, with its controls and volume; null when none matches',
        content: {
          'application/json': {
            schema: createResponseSchema(SonosPlaybackMatchSchema),
          },
        },
      },
      401: jsonErrorResponse('Unauthorized'),
      403: jsonErrorResponse('Playback control is required'),
      422: validationErrorResponse,
    },
  }),
  async (c) =>
    generateJsonResponse(
      c,
      await findSonosPlayback(requireOwnerUser(c).id, c.req.valid('query')),
      200,
    ),
)

app.openapi(
  createRoute({
    method: 'post',
    path: '/groups/{groupId}/command',
    security: ownerSessionSecurity,
    middleware: [browserSession, sameOrigin, playbackDriver],
    request: {
      params: z.object({ groupId: SonosGroupIdSchema }),
      body: {
        required: true,
        content: { 'application/json': { schema: SonosCommandSchema } },
      },
    },
    responses: {
      200: {
        description: 'Transport or volume command sent to the Sonos group',
        content: {
          'application/json': {
            schema: createResponseSchema(SonosCommandResultSchema),
          },
        },
      },
      401: jsonErrorResponse('Owner browser session required'),
      403: jsonErrorResponse('Forbidden'),
      422: validationErrorResponse,
    },
  }),
  async (c) =>
    generateJsonResponse(
      c,
      await sendSonosCommand(
        requireBrowserSession(c).user.id,
        c.req.valid('param').groupId,
        c.req.valid('json'),
      ),
      200,
    ),
)

app.openapi(
  createRoute({
    method: 'get',
    path: '/groups/{groupId}/state',
    middleware: [authMiddleware(), playbackDriver],
    request: {
      params: z.object({ groupId: SonosGroupIdSchema }),
      query: SonosGroupStateQuerySchema,
    },
    responses: {
      200: {
        description:
          'What the Sonos group plays now, its position and controls, and its volume when asked for',
        content: {
          'application/json': {
            schema: createResponseSchema(SonosGroupStateSchema),
          },
        },
      },
      401: jsonErrorResponse('Unauthorized'),
      403: jsonErrorResponse('Playback control is required'),
      422: validationErrorResponse,
    },
  }),
  async (c) =>
    generateJsonResponse(
      c,
      await getSonosGroupState(
        requireOwnerUser(c).id,
        c.req.valid('param').groupId,
        c.req.valid('query'),
      ),
      200,
    ),
)

app.openapi(
  createRoute({
    method: 'post',
    path: '/groups/{groupId}/content',
    security: ownerSessionSecurity,
    middleware: [browserSession, sameOrigin, playbackDriver],
    request: {
      params: z.object({ groupId: SonosGroupIdSchema }),
      body: {
        required: true,
        content: { 'application/json': { schema: SonosContentInputSchema } },
      },
    },
    responses: {
      200: {
        description:
          "Spotify tracks or albums loaded into the Sonos group's queue",
        content: {
          'application/json': {
            schema: createResponseSchema(SonosContentResultSchema),
          },
        },
      },
      401: jsonErrorResponse('Owner browser session required'),
      403: jsonErrorResponse('Forbidden'),
      409: jsonErrorResponse(
        "The household's Spotify account is not known yet",
      ),
      422: validationErrorResponse,
    },
  }),
  async (c) =>
    generateJsonResponse(
      c,
      await loadSonosContent(
        requireBrowserSession(c).user.id,
        c.req.valid('param').groupId,
        c.req.valid('json'),
      ),
      200,
    ),
)

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
          'application/json': { schema: SonosAuthorizeInputSchema },
        },
      },
    },
    responses: {
      200: {
        description: 'Explicit OAuth authorization URL for Sonos control',
        content: {
          'application/json': {
            schema: createResponseSchema(SonosAuthorizeResultSchema),
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
      await authorizeSonos(user.id, session.id, c.req.header('origin')),
      200,
    )
  },
)

app.openapi(
  createRoute({
    method: 'get',
    path: '/callback',
    security: [],
    request: { query: SonosCallbackSchema },
    responses: {
      302: { description: 'Relay to the configured authenticated API origin' },
      422: validationErrorResponse,
    },
  }),
  (c) => c.redirect(sonosCallbackDestination(c.req.valid('query')), 302),
)

app.openapi(
  createRoute({
    method: 'get',
    path: '/complete',
    security: ownerSessionSecurity,
    middleware: [browserSession],
    request: { query: SonosCallbackSchema },
    responses: {
      302: {
        description:
          'Return to the app, where the player reports the result, without exposing tokens or authorization codes',
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
      const result = await finishSonosAuthorization(
        c.req.valid('query'),
        user.id,
        session.id,
      )
      connected = result.connected
      returnOrigin = result.returnOrigin
    } catch {
      /* Never expose token responses, codes or state in the redirect. */
    }
    const destination = new URL('/albums', returnOrigin)
    destination.search = new URLSearchParams({
      player: connected ? 'sonos-connected' : 'sonos-error',
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
          'Delete this user account tokens and pending authorization locally',
        content: {
          'application/json': {
            schema: createResponseSchema(SonosDisconnectResultSchema),
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
      await disconnectSonos(requireBrowserSession(c).user.id),
      200,
    ),
)

app.onError((error, c) =>
  error instanceof ServerError
    ? c.json(error.response, error.response.statusCode)
    : generateJsonResponse(c, null, 500, 'Sonos operation failed'),
)

export default app
