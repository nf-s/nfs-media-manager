import { createRoute } from '@hono/zod-openapi'
import { EnrichmentResultSchema } from '@repo/schemas/job'
import {
  SonovaultCandidateAcceptResultSchema,
  SonovaultCandidateDecisionInputSchema,
  SonovaultCandidateParamsSchema,
  SonovaultCandidateStatusInputSchema,
  SonovaultCandidateStatusListSchema,
  SonovaultTrackCandidateReviewSchema,
  SonovaultTrackNameLookupInputSchema,
} from '@repo/schemas/sonovault-candidates'
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
  acceptSonovaultTrackCandidate,
  getSonovaultCandidateReview,
  listSonovaultCandidateReviews,
  queueSonovaultTrackNameLookups,
  rejectSonovaultTrackCandidate,
} from '@/services/sonovault-track-candidates'

const app = createOpenAPIApp()

app.openapi(
  createRoute({
    method: 'post',
    path: '/tracks/candidates/lookup',
    middleware: [authMiddleware(), mutationOriginMiddleware()],
    request: {
      body: {
        required: true,
        content: {
          'application/json': { schema: SonovaultTrackNameLookupInputSchema },
        },
      },
    },
    responses: {
      200: {
        description:
          'Queue Sonovault lookups by artist and title for tracks with neither a Spotify ID nor an ISRC',
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
      await queueSonovaultTrackNameLookups(
        c.req.valid('json'),
        requireOwnerUser(c).id,
      ),
      200,
    ),
)

app.openapi(
  createRoute({
    method: 'post',
    path: '/tracks/candidates/status',
    middleware: [authMiddleware(), mutationOriginMiddleware()],
    request: {
      body: {
        required: true,
        content: {
          'application/json': { schema: SonovaultCandidateStatusInputSchema },
        },
      },
    },
    responses: {
      200: {
        description:
          'Sonovault candidates and the latest lookup by artist and title of each track',
        content: {
          'application/json': {
            schema: createResponseSchema(SonovaultCandidateStatusListSchema),
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
      await listSonovaultCandidateReviews(c.req.valid('json')),
      200,
    )
  },
)

app.openapi(
  createRoute({
    method: 'get',
    path: '/tracks/candidates/{trackId}',
    middleware: [authMiddleware()],
    request: { params: SonovaultCandidateParamsSchema },
    responses: {
      200: {
        description: 'Sonovault candidates of a track',
        content: {
          'application/json': {
            schema: createResponseSchema(SonovaultTrackCandidateReviewSchema),
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
      await getSonovaultCandidateReview(c.req.valid('param').trackId),
      200,
    )
  },
)

app.openapi(
  createRoute({
    method: 'post',
    path: '/tracks/candidates/{trackId}/accept',
    middleware: [authMiddleware(), mutationOriginMiddleware()],
    request: {
      params: SonovaultCandidateParamsSchema,
      body: {
        required: true,
        content: {
          'application/json': { schema: SonovaultCandidateDecisionInputSchema },
        },
      },
    },
    responses: {
      200: {
        description:
          'Accept a Sonovault candidate: its references and ISRC, then its Spotify ID through a Spotify track job',
        content: {
          'application/json': {
            schema: createResponseSchema(SonovaultCandidateAcceptResultSchema),
          },
        },
      },
      401: jsonErrorResponse('Unauthorized'),
      404: jsonErrorResponse('Library track or candidate not found'),
      409: jsonErrorResponse('The candidate was already reviewed'),
      422: validationErrorResponse,
    },
  }),
  async (c) =>
    generateJsonResponse(
      c,
      await acceptSonovaultTrackCandidate({
        trackId: c.req.valid('param').trackId,
        sonovaultTrackId: c.req.valid('json').sonovaultTrackId,
        userId: requireOwnerUser(c).id,
      }),
      200,
    ),
)

app.openapi(
  createRoute({
    method: 'post',
    path: '/tracks/candidates/{trackId}/reject',
    middleware: [authMiddleware(), mutationOriginMiddleware()],
    request: {
      params: SonovaultCandidateParamsSchema,
      body: {
        required: true,
        content: {
          'application/json': { schema: SonovaultCandidateDecisionInputSchema },
        },
      },
    },
    responses: {
      200: {
        description: 'Reject a Sonovault candidate; it is not offered again',
        content: {
          'application/json': {
            schema: createResponseSchema(SonovaultTrackCandidateReviewSchema),
          },
        },
      },
      401: jsonErrorResponse('Unauthorized'),
      404: jsonErrorResponse('Library track or candidate not found'),
      409: jsonErrorResponse('The candidate was already reviewed'),
      422: validationErrorResponse,
    },
  }),
  async (c) => {
    requireOwnerUser(c)
    return generateJsonResponse(
      c,
      await rejectSonovaultTrackCandidate({
        trackId: c.req.valid('param').trackId,
        sonovaultTrackId: c.req.valid('json').sonovaultTrackId,
      }),
      200,
    )
  },
)

export default app
