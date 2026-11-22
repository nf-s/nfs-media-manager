import { createRoute } from '@hono/zod-openapi'
import { EnrichmentResultSchema } from '@repo/schemas/job'
import {
  TidalTrackMatchAcceptInputSchema,
  TidalTrackMatchInputSchema,
  TidalTrackMatchParamsSchema,
  TidalTrackMatchReviewSchema,
  TidalTrackMatchStatusInputSchema,
  TidalTrackMatchStatusSchema,
} from '@repo/schemas/tidal'
import {
  createOpenAPIApp,
  createResponseSchema,
  jsonErrorResponse,
  validationErrorResponse,
} from '@/lib/openapi'
import { generateJsonResponse } from '@/lib/response'
import {
  authMiddleware,
  mutationOriginMiddleware,
  requireOwnerUser,
} from '@/middlewares/auth'
import {
  acceptTidalTrackMatch,
  getTidalTrackMatch,
  listTidalTrackMatchStatuses,
  queueTidalTrackMatches,
} from '@/services/tidal-track-match'

const app = createOpenAPIApp()

app.openapi(
  createRoute({
    method: 'post',
    path: '/tracks/match',
    middleware: [authMiddleware(), mutationOriginMiddleware()],
    request: {
      body: {
        required: true,
        content: {
          'application/json': { schema: TidalTrackMatchInputSchema },
        },
      },
    },
    responses: {
      200: {
        description: 'Queue one TIDAL ISRC match per eligible selected track',
        content: {
          'application/json': {
            schema: createResponseSchema(EnrichmentResultSchema),
          },
        },
      },
      401: jsonErrorResponse('Unauthorized'),
      422: validationErrorResponse,
      429: jsonErrorResponse('TIDAL is cooling down or halted'),
    },
  }),
  async (c) =>
    generateJsonResponse(
      c,
      await queueTidalTrackMatches(c.req.valid('json'), requireOwnerUser(c).id),
      200,
    ),
)

app.openapi(
  createRoute({
    method: 'post',
    path: '/tracks/match/status',
    middleware: [authMiddleware(), mutationOriginMiddleware()],
    request: {
      body: {
        required: true,
        content: {
          'application/json': { schema: TidalTrackMatchStatusInputSchema },
        },
      },
    },
    responses: {
      200: {
        description: 'Latest TIDAL match job for each requested track',
        content: {
          'application/json': {
            schema: createResponseSchema(TidalTrackMatchStatusSchema),
          },
        },
      },
      401: jsonErrorResponse('Unauthorized'),
      422: validationErrorResponse,
    },
  }),
  async (c) => {
    requireOwnerUser(c)
    return generateJsonResponse(
      c,
      await listTidalTrackMatchStatuses(c.req.valid('json')),
      200,
    )
  },
)

app.openapi(
  createRoute({
    method: 'get',
    path: '/tracks/match/{trackId}',
    middleware: [authMiddleware()],
    request: { params: TidalTrackMatchParamsSchema },
    responses: {
      200: {
        description: 'Latest TIDAL match job and the candidates for review',
        content: {
          'application/json': {
            schema: createResponseSchema(TidalTrackMatchReviewSchema),
          },
        },
      },
      401: jsonErrorResponse('Unauthorized'),
      404: jsonErrorResponse('Library track not found'),
    },
  }),
  async (c) => {
    requireOwnerUser(c)
    return generateJsonResponse(
      c,
      await getTidalTrackMatch(c.req.valid('param').trackId),
      200,
    )
  },
)

app.openapi(
  createRoute({
    method: 'post',
    path: '/tracks/match/{trackId}/accept',
    middleware: [authMiddleware(), mutationOriginMiddleware()],
    request: {
      params: TidalTrackMatchParamsSchema,
      body: {
        required: true,
        content: {
          'application/json': { schema: TidalTrackMatchAcceptInputSchema },
        },
      },
    },
    responses: {
      200: {
        description: 'The track linked to the chosen TIDAL track',
        content: {
          'application/json': {
            schema: createResponseSchema(TidalTrackMatchReviewSchema),
          },
        },
      },
      401: jsonErrorResponse('Unauthorized'),
      404: jsonErrorResponse('Track, match or stored candidate was not found'),
      409: jsonErrorResponse('A newer TIDAL match is queued or running'),
      422: validationErrorResponse,
    },
  }),
  async (c) => {
    requireOwnerUser(c)
    return generateJsonResponse(
      c,
      await acceptTidalTrackMatch({
        ...c.req.valid('param'),
        ...c.req.valid('json'),
      }),
      200,
    )
  },
)

export default app
