import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import { z } from 'zod'
import { BrowseFacetQuerySchema, BrowseFieldSchema } from '@repo/schemas/browse'
import { PaginatedDataSchema } from '@repo/schemas/common'
import {
  TrackDetailSchema,
  TrackFilterOptionSchema,
  TrackListItemSchema,
  TrackQuerySchema,
} from '@repo/schemas/tracks'
import { ServerError } from '@/lib/error'
import {
  createOpenAPIApp,
  createResponseSchema,
  jsonErrorResponse,
  type AppEnv,
  validationErrorResponse,
} from '@/lib/openapi'
import { generateJsonResponse } from '@/lib/response'
import { authMiddleware } from '@/middlewares/auth'
import { listBrowseFields } from '@/services/browse'
import {
  getTrackDetail,
  listTrackFilterOptions,
  listTracks,
} from '@/services/tracks'

const app: OpenAPIHono<AppEnv> = createOpenAPIApp()
  .openapi(
    createRoute({
      method: 'get',
      path: '/fields',
      middleware: [authMiddleware()],
      responses: {
        200: {
          description: 'Browse fields',
          content: {
            'application/json': {
              schema: createResponseSchema(z.array(BrowseFieldSchema)),
            },
          },
        },
        401: jsonErrorResponse('Unauthorized'),
      },
    }),
    async (c) => generateJsonResponse(c, await listBrowseFields('track'), 200),
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/',
      middleware: [authMiddleware()],
      request: { query: TrackQuerySchema },
      responses: {
        200: {
          description: 'Track list',
          content: {
            'application/json': {
              schema: createResponseSchema(
                PaginatedDataSchema(TrackListItemSchema),
              ),
            },
          },
        },
        401: jsonErrorResponse('Unauthorized'),
        422: validationErrorResponse,
      },
    }),
    async (c) => {
      const query = c.req.valid('query')
      const data = await listTracks(query)
      return generateJsonResponse(
        c,
        { ...data, page: query.page, size: query.size },
        200,
      )
    },
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/facets',
      middleware: [authMiddleware()],
      request: { query: BrowseFacetQuerySchema },
      responses: {
        200: {
          description: 'Track filter options',
          content: {
            'application/json': {
              schema: createResponseSchema(z.array(TrackFilterOptionSchema)),
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
        await listTrackFilterOptions(c.req.valid('query')),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/:id',
      middleware: [authMiddleware()],
      request: { params: z.object({ id: z.string().min(1) }) },
      responses: {
        200: {
          description:
            'Track detail with its library album, playlists and stored scrobbles',
          content: {
            'application/json': {
              schema: createResponseSchema(TrackDetailSchema),
            },
          },
        },
        401: jsonErrorResponse('Unauthorized'),
        404: jsonErrorResponse('Track not found'),
      },
    }),
    async (c) => {
      const record = await getTrackDetail(c.req.valid('param').id)
      if (!record)
        throw new ServerError({ statusCode: 404, message: 'Track not found' })
      return generateJsonResponse(c, record, 200)
    },
  )

export default app
