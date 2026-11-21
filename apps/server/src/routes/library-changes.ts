import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import {
  LibraryChangeListQuerySchema,
  LibraryChangePageSchema,
  LibraryChangeParamsSchema,
  LibraryChangeSchema,
  TrackMergePlanRequestSchema,
  TrackMergePlanSchema,
  TrackMergeRequestSchema,
} from '@repo/schemas/library-changes'
import {
  createOpenAPIApp,
  createResponseSchema,
  jsonErrorResponse,
  type AppEnv,
  validationErrorResponse,
} from '@/lib/openapi'
import { generateJsonResponse } from '@/lib/response'
import { authMiddleware, mutationOriginMiddleware } from '@/middlewares/auth'
import {
  listLibraryChanges,
  redoLibraryChange,
  undoLibraryChange,
} from '@/services/library-changes'
import { planTrackMerge } from '@/services/track-merge-plan'
import { mergeTracks } from '@/services/track-merges'

const changeResponse = (description: string) => ({
  description,
  content: {
    'application/json': { schema: createResponseSchema(LibraryChangeSchema) },
  },
})

const app: OpenAPIHono<AppEnv> = createOpenAPIApp()
  .openapi(
    createRoute({
      method: 'get',
      path: '/',
      middleware: [authMiddleware()],
      request: { query: LibraryChangeListQuerySchema },
      responses: {
        200: {
          description: 'Recorded merges, moves and separations, newest first',
          content: {
            'application/json': {
              schema: createResponseSchema(LibraryChangePageSchema),
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
        await listLibraryChanges(c.req.valid('query')),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/track-merges/plan',
      middleware: [authMiddleware()],
      request: {
        body: {
          required: true,
          content: {
            'application/json': { schema: TrackMergePlanRequestSchema },
          },
        },
      },
      responses: {
        200: {
          description:
            'What merging the selected tracks would move, and any reason to review it first',
          content: {
            'application/json': {
              schema: createResponseSchema(TrackMergePlanSchema),
            },
          },
        },
        401: jsonErrorResponse('Unauthorized'),
        404: jsonErrorResponse('Track not found'),
        422: validationErrorResponse,
      },
    }),
    async (c) =>
      generateJsonResponse(c, await planTrackMerge(c.req.valid('json')), 200),
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/track-merges',
      middleware: [authMiddleware(), mutationOriginMiddleware()],
      request: {
        body: {
          required: true,
          content: { 'application/json': { schema: TrackMergeRequestSchema } },
        },
      },
      responses: {
        200: changeResponse(
          'Merged the selected tracks into one and recorded the change',
        ),
        401: jsonErrorResponse('Unauthorized'),
        403: jsonErrorResponse('Forbidden'),
        404: jsonErrorResponse('Track not found'),
        409: jsonErrorResponse('Tracks cannot be merged'),
        422: validationErrorResponse,
      },
    }),
    async (c) =>
      generateJsonResponse(c, await mergeTracks(c.req.valid('json')), 200),
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/:id/undo',
      middleware: [authMiddleware(), mutationOriginMiddleware()],
      request: { params: LibraryChangeParamsSchema },
      responses: {
        200: changeResponse('Put every name the change moved back'),
        401: jsonErrorResponse('Unauthorized'),
        403: jsonErrorResponse('Forbidden'),
        404: jsonErrorResponse('Change not found'),
        409: jsonErrorResponse('Change cannot be undone'),
        422: validationErrorResponse,
      },
    }),
    async (c) =>
      generateJsonResponse(
        c,
        await undoLibraryChange(c.req.valid('param').id),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/:id/redo',
      middleware: [authMiddleware(), mutationOriginMiddleware()],
      request: { params: LibraryChangeParamsSchema },
      responses: {
        200: changeResponse('Made an undone change again'),
        401: jsonErrorResponse('Unauthorized'),
        403: jsonErrorResponse('Forbidden'),
        404: jsonErrorResponse('Change not found'),
        409: jsonErrorResponse('Change cannot be made again'),
        422: validationErrorResponse,
      },
    }),
    async (c) =>
      generateJsonResponse(
        c,
        await redoLibraryChange(c.req.valid('param').id),
        200,
      ),
  )

export default app
