import { createRoute } from '@hono/zod-openapi'
import { EnrichmentResultSchema } from '@repo/schemas/job'
import {
  SonovaultRefreshInputSchema,
  SonovaultRemovalInputSchema,
  SonovaultRemovalSchema,
  SonovaultSummarySchema,
  SonovaultTrackLookupInputSchema,
  SonovaultTrackParamsSchema,
  SonovaultTrackStateSchema,
  SonovaultTrackStatusInputSchema,
  SonovaultTrackStatusSchema,
} from '@repo/schemas/sonovault'
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
  getSonovaultSummary,
  getSonovaultTrackState,
  listSonovaultTrackStates,
  queueSonovaultRefresh,
  queueSonovaultTrackLookups,
  removeSonovaultData,
} from '@/services/sonovault-track-lookup'

const app = createOpenAPIApp()

app.openapi(
  createRoute({
    method: 'post',
    path: '/tracks/lookup',
    middleware: [authMiddleware(), mutationOriginMiddleware()],
    request: {
      body: {
        required: true,
        content: {
          'application/json': { schema: SonovaultTrackLookupInputSchema },
        },
      },
    },
    responses: {
      200: {
        description:
          'Queue one Sonovault bulk lookup per input type for the selected tracks that are due one',
        content: {
          'application/json': {
            schema: createResponseSchema(EnrichmentResultSchema),
          },
        },
      },
      401: jsonErrorResponse('Unauthorized'),
      422: validationErrorResponse,
      429: jsonErrorResponse('Sonovault is cooling down or halted'),
    },
  }),
  async (c) =>
    generateJsonResponse(
      c,
      await queueSonovaultTrackLookups(
        c.req.valid('json'),
        requireOwnerUser(c).id,
      ),
      200,
    ),
)

app.openapi(
  createRoute({
    method: 'post',
    path: '/tracks/lookup/status',
    middleware: [authMiddleware(), mutationOriginMiddleware()],
    request: {
      body: {
        required: true,
        content: {
          'application/json': { schema: SonovaultTrackStatusInputSchema },
        },
      },
    },
    responses: {
      200: {
        description:
          'Sonovault lookup, references and latest job of each track',
        content: {
          'application/json': {
            schema: createResponseSchema(SonovaultTrackStatusSchema),
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
      await listSonovaultTrackStates(c.req.valid('json')),
      200,
    )
  },
)

app.openapi(
  createRoute({
    method: 'get',
    path: '/tracks/lookup/{trackId}',
    middleware: [authMiddleware()],
    request: { params: SonovaultTrackParamsSchema },
    responses: {
      200: {
        description: 'Sonovault lookup, references and latest job of a track',
        content: {
          'application/json': {
            schema: createResponseSchema(SonovaultTrackStateSchema),
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
      await getSonovaultTrackState(c.req.valid('param').trackId),
      200,
    )
  },
)

app.openapi(
  createRoute({
    method: 'get',
    path: '/summary',
    middleware: [authMiddleware()],
    responses: {
      200: {
        description: 'What is stored from Sonovault and the credits left',
        content: {
          'application/json': {
            schema: createResponseSchema(SonovaultSummarySchema),
          },
        },
      },
      401: jsonErrorResponse('Unauthorized'),
    },
  }),
  async (c) => {
    requireOwnerUser(c)
    return generateJsonResponse(c, await getSonovaultSummary(), 200)
  },
)

app.openapi(
  createRoute({
    method: 'post',
    path: '/refresh',
    middleware: [authMiddleware(), mutationOriginMiddleware()],
    request: {
      body: {
        required: true,
        content: {
          'application/json': { schema: SonovaultRefreshInputSchema },
        },
      },
    },
    responses: {
      200: {
        description: 'Queue lookups for records older than 11 months',
        content: {
          'application/json': {
            schema: createResponseSchema(EnrichmentResultSchema),
          },
        },
      },
      401: jsonErrorResponse('Unauthorized'),
      422: validationErrorResponse,
      429: jsonErrorResponse('Sonovault is cooling down or halted'),
    },
  }),
  async (c) =>
    generateJsonResponse(
      c,
      await queueSonovaultRefresh(
        requireOwnerUser(c).id,
        c.req.valid('json').batchId,
      ),
      200,
    ),
)

app.openapi(
  createRoute({
    method: 'post',
    path: '/remove',
    middleware: [authMiddleware(), mutationOriginMiddleware()],
    request: {
      body: {
        required: true,
        content: {
          'application/json': { schema: SonovaultRemovalInputSchema },
        },
      },
    },
    responses: {
      200: {
        description:
          'Remove every Sonovault response, reference, lookup and primary ISRC',
        content: {
          'application/json': {
            schema: createResponseSchema(SonovaultRemovalSchema),
          },
        },
      },
      401: jsonErrorResponse('Unauthorized'),
      422: validationErrorResponse,
    },
  }),
  async (c) => {
    requireOwnerUser(c)
    c.req.valid('json')
    return generateJsonResponse(c, await removeSonovaultData(), 200)
  },
)

export default app
