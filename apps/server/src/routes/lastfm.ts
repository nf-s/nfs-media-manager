import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import { createMiddleware } from 'hono/factory'
import {
  LastfmSyncInputSchema,
  LastfmSyncStatusSchema,
} from '@repo/schemas/lastfm'
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
  getLastfmSyncStatus,
  runLastfmSyncStep,
  startLastfmSync,
  stopLastfmSync,
} from '@/services/lastfm-scrobbles'

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

const statusResponse = (description: string) => ({
  description,
  content: {
    'application/json': {
      schema: createResponseSchema(LastfmSyncStatusSchema),
    },
  },
})
const emptyBody = {
  required: true,
  content: { 'application/json': { schema: LastfmSyncInputSchema } },
}

const app: OpenAPIHono<AppEnv> = createOpenAPIApp()
  .openapi(
    createRoute({
      method: 'get',
      path: '/sync',
      middleware: [authMiddleware()],
      responses: {
        200: statusResponse('Stored scrobble sync status; no Last.fm requests'),
        401: jsonErrorResponse('Unauthorized'),
      },
    }),
    async (c) => generateJsonResponse(c, await getLastfmSyncStatus(), 200),
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/sync',
      middleware: [authMiddleware(), sameOrigin],
      request: { body: emptyBody },
      responses: {
        200: statusResponse(
          'Start a scrobble sync or resume an unfinished one',
        ),
        401: jsonErrorResponse('Unauthorized'),
        422: validationErrorResponse,
      },
    }),
    async (c) =>
      generateJsonResponse(
        c,
        await startLastfmSync(c.get('user')?.id ?? null),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/sync/step',
      middleware: [authMiddleware(), sameOrigin],
      request: { body: emptyBody },
      responses: {
        200: statusResponse('Fetch further pages of a running sync'),
        401: jsonErrorResponse('Unauthorized'),
        422: validationErrorResponse,
      },
    }),
    async (c) => generateJsonResponse(c, await runLastfmSyncStep(), 200),
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/sync/stop',
      middleware: [authMiddleware(), sameOrigin],
      request: { body: emptyBody },
      responses: {
        200: statusResponse('Stop a running sync; stored scrobbles are kept'),
        401: jsonErrorResponse('Unauthorized'),
        422: validationErrorResponse,
      },
    }),
    async (c) => generateJsonResponse(c, await stopLastfmSync(), 200),
  )

app.onError((error, c) =>
  error instanceof ServerError
    ? c.json(error.response, error.response.statusCode)
    : generateJsonResponse(c, null, 500, 'Last.fm sync failed'),
)

export default app
