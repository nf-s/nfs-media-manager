import { createRoute } from '@hono/zod-openapi'
import {
  TidalSimilarAddParamsSchema,
  TidalSimilarAddResultSchema,
  TidalSimilarParamsSchema,
  TidalSimilarSchema,
  TidalTrackMatchAcceptInputSchema,
  TidalTrackMatchInputSchema,
  TidalTrackMatchParamsSchema,
  TidalTrackMatchReviewSchema,
  TidalTrackMatchRunSchema,
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
  matchTidalTracks,
} from '@/services/tidal-track-match'
import { getTidalSimilar, refreshTidalSimilar } from '@/services/tidal-similar'
import { addTidalSimilarToLibrary } from '@/services/tidal-similar-library'

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
        description:
          'Match each selected track with an ISRC on TIDAL in this request',
        content: {
          'application/json': {
            schema: createResponseSchema(TidalTrackMatchRunSchema),
          },
        },
      },
      401: jsonErrorResponse('Unauthorized'),
      422: validationErrorResponse,
      429: jsonErrorResponse('TIDAL is rate limited, busy or halted'),
    },
  }),
  async (c) =>
    generateJsonResponse(
      c,
      await matchTidalTracks(c.req.valid('json'), requireOwnerUser(c).id),
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

app.openapi(
  createRoute({
    method: 'get',
    path: '/similar/{kind}/{id}',
    middleware: [authMiddleware()],
    request: { params: TidalSimilarParamsSchema },
    responses: {
      200: {
        description:
          'Similar albums or tracks from TIDAL and how each can be played',
        content: {
          'application/json': {
            schema: createResponseSchema(TidalSimilarSchema),
          },
        },
      },
      401: jsonErrorResponse('Unauthorized'),
      404: jsonErrorResponse('Album or track not found'),
    },
  }),
  async (c) => {
    requireOwnerUser(c)
    return generateJsonResponse(
      c,
      await getTidalSimilar(c.req.valid('param')),
      200,
    )
  },
)

app.openapi(
  createRoute({
    method: 'post',
    path: '/similar/{kind}/{id}',
    middleware: [authMiddleware(), mutationOriginMiddleware()],
    request: { params: TidalSimilarParamsSchema },
    responses: {
      200: {
        description:
          'Match an unmatched item on TIDAL, or else read its similar items, in this request',
        content: {
          'application/json': {
            schema: createResponseSchema(TidalSimilarSchema),
          },
        },
      },
      401: jsonErrorResponse('Unauthorized'),
      404: jsonErrorResponse('Album or track not found'),
      409: jsonErrorResponse(
        'The album has no UPC, the track no ISRC, or a match is running',
      ),
      429: jsonErrorResponse('TIDAL is rate limited, busy or halted'),
    },
  }),
  async (c) =>
    generateJsonResponse(
      c,
      await refreshTidalSimilar(c.req.valid('param'), requireOwnerUser(c).id),
      200,
    ),
)

app.openapi(
  createRoute({
    method: 'post',
    path: '/similar/{kind}/{id}/{tidalId}/library',
    middleware: [authMiddleware(), mutationOriginMiddleware()],
    request: { params: TidalSimilarAddParamsSchema },
    responses: {
      200: {
        description: 'Library ID of the stored suggestion',
        content: {
          'application/json': {
            schema: createResponseSchema(TidalSimilarAddResultSchema),
          },
        },
      },
      401: jsonErrorResponse('Unauthorized'),
      404: jsonErrorResponse(
        'The library item or stored suggestion was not found',
      ),
      409: jsonErrorResponse('The selected item is hidden in the library'),
      422: validationErrorResponse,
    },
  }),
  async (c) => {
    requireOwnerUser(c)
    return generateJsonResponse(
      c,
      await addTidalSimilarToLibrary(c.req.valid('param')),
      200,
    )
  },
)

export default app
