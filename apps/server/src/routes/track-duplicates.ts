import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import { z } from 'zod'
import { LibraryChangeSchema } from '@repo/schemas/library-changes'
import { TrackMatchDiagnosticsQuerySchema } from '@repo/schemas/match-diagnostics'
import {
  DuplicateReviewPageSchema,
  DuplicateReviewQuerySchema,
  TrackDuplicateCountQuerySchema,
  TrackDuplicateCountSchema,
  TrackDuplicateLayoutSchema,
  TrackDuplicatesSchema,
  TrackSeparationRequestSchema,
} from '@repo/schemas/track-duplicates'
import {
  createOpenAPIApp,
  createResponseSchema,
  jsonErrorResponse,
  type AppEnv,
  validationErrorResponse,
} from '@/lib/openapi'
import { generateJsonResponse } from '@/lib/response'
import {
  authMiddleware,
  mutationOriginMiddleware,
  requireOwnerUser,
} from '@/middlewares/auth'
import {
  countTrackDuplicateGroups,
  keepTracksSeparate,
  listTrackDuplicates,
  readDuplicateReview,
  readTrackDuplicateLayout,
} from '@/services/track-duplicates'

/** Mounted at `/library-changes/track-separations`. */
export const trackSeparations: OpenAPIHono<AppEnv> = createOpenAPIApp().openapi(
  createRoute({
    method: 'post',
    path: '/',
    middleware: [authMiddleware(), mutationOriginMiddleware()],
    request: {
      body: {
        required: true,
        content: {
          'application/json': { schema: TrackSeparationRequestSchema },
        },
      },
    },
    responses: {
      200: {
        description:
          'Stored that the tracks are different and recorded the change',
        content: {
          'application/json': {
            schema: createResponseSchema(LibraryChangeSchema),
          },
        },
      },
      401: jsonErrorResponse('Unauthorized'),
      403: jsonErrorResponse('Forbidden'),
      404: jsonErrorResponse('Track not found'),
      409: jsonErrorResponse('Tracks are already kept separate'),
      422: validationErrorResponse,
    },
  }),
  async (c) =>
    generateJsonResponse(c, await keepTracksSeparate(c.req.valid('json')), 200),
)

/** Mounted at `/tracks`, before the tracks routes. */
export const trackDuplicates: OpenAPIHono<AppEnv> = createOpenAPIApp()
  .openapi(
    createRoute({
      method: 'get',
      path: '/duplicates/review',
      middleware: [authMiddleware()],
      request: { query: DuplicateReviewQuerySchema },
      responses: {
        200: {
          description:
            'Decisions and evidence from the latest duplicate review',
          content: {
            'application/json': {
              schema: createResponseSchema(DuplicateReviewPageSchema),
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
        await readDuplicateReview(c.req.valid('query')),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/duplicates/count',
      middleware: [authMiddleware()],
      request: { query: TrackDuplicateCountQuerySchema },
      responses: {
        200: {
          description: 'Number of possible duplicate groups',
          content: {
            'application/json': {
              schema: createResponseSchema(TrackDuplicateCountSchema),
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
        await countTrackDuplicateGroups(c.req.valid('query')),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/duplicates/layout',
      middleware: [authMiddleware()],
      request: { query: TrackMatchDiagnosticsQuerySchema },
      responses: {
        200: {
          description:
            'Possible duplicate groups in Matches order, with the rows of each',
          content: {
            'application/json': {
              schema: createResponseSchema(TrackDuplicateLayoutSchema),
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
        await readTrackDuplicateLayout(
          c.req.valid('query'),
          requireOwnerUser(c).id,
        ),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/:id/duplicates',
      middleware: [authMiddleware()],
      request: { params: z.object({ id: z.string().min(1).max(200) }) },
      responses: {
        200: {
          description: 'Possible duplicate groups the track is in',
          content: {
            'application/json': {
              schema: createResponseSchema(TrackDuplicatesSchema),
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
        await listTrackDuplicates(c.req.valid('param').id),
        200,
      ),
  )
