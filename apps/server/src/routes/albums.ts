import { BrowseFieldSchema } from '@repo/schemas/browse'
import { listBrowseFields } from '@/services/browse'
import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import { z } from 'zod'
import {
  AlbumDetailSchema,
  AlbumFilterOptionSchema,
  AlbumListItemSchema,
  AlbumPatchSchema,
  AlbumQuerySchema,
} from '@repo/schemas/media'
import { PaginatedDataSchema } from '@repo/schemas/common'
import { authMiddleware } from '@/middlewares/auth'
import {
  createOpenAPIApp,
  createResponseSchema,
  jsonErrorResponse,
  type AppEnv,
  validationErrorResponse,
} from '@/lib/openapi'
import { generateJsonResponse } from '@/lib/response'
import {
  getAlbumDetail,
  listAlbumFilterOptions,
  listAlbums,
  patchAlbum,
} from '@/services/media'
import { ServerError } from '@/lib/error'
import {
  AlbumSelectionPageSchema,
  AlbumSelectionQuerySchema,
} from '@repo/schemas/album-selection'
import { listAlbumSelection } from '@/services/album-selection'

const app: OpenAPIHono<AppEnv> = createOpenAPIApp()
  .openapi(
    createRoute({
      method: 'get',
      path: '/selection',
      middleware: [authMiddleware()],
      request: { query: AlbumSelectionQuerySchema },
      responses: {
        200: {
          description: 'Albums with provider-specific scrape freshness',
          content: {
            'application/json': {
              schema: createResponseSchema(AlbumSelectionPageSchema),
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
        await listAlbumSelection(c.req.valid('query')),
        200,
      ),
  )
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
    async (c) => generateJsonResponse(c, await listBrowseFields('album'), 200),
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/',
      middleware: [authMiddleware()],
      request: {
        query: AlbumQuerySchema,
      },
      responses: {
        200: {
          description: 'Album list',
          content: {
            'application/json': {
              schema: createResponseSchema(
                PaginatedDataSchema(AlbumListItemSchema),
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
      const data = await listAlbums(query)
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
      responses: {
        200: {
          description: 'Album filter options',
          content: {
            'application/json': {
              schema: createResponseSchema(z.array(AlbumFilterOptionSchema)),
            },
          },
        },
        401: jsonErrorResponse('Unauthorized'),
      },
    }),
    async (c) => {
      const data = await listAlbumFilterOptions()
      return generateJsonResponse(c, data, 200)
    },
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/:id',
      middleware: [authMiddleware()],
      request: {
        params: z.object({
          id: z.string().min(1),
        }),
      },
      responses: {
        200: {
          description: 'Album detail',
          content: {
            'application/json': {
              schema: createResponseSchema(AlbumDetailSchema),
            },
          },
        },
        401: jsonErrorResponse('Unauthorized'),
        404: jsonErrorResponse('Album not found'),
      },
    }),
    async (c) => {
      const record = await getAlbumDetail(c.req.valid('param').id)
      if (!record) {
        throw new ServerError({
          statusCode: 404,
          message: 'Album not found',
        })
      }

      return generateJsonResponse(c, record, 200)
    },
  )
  .openapi(
    createRoute({
      method: 'patch',
      path: '/:id',
      middleware: [authMiddleware()],
      request: {
        params: z.object({
          id: z.string().min(1),
        }),
        body: {
          required: true,
          content: {
            'application/json': {
              schema: AlbumPatchSchema,
            },
          },
        },
      },
      responses: {
        200: {
          description: 'Album updated',
          content: {
            'application/json': {
              schema: createResponseSchema(AlbumDetailSchema),
            },
          },
        },
        401: jsonErrorResponse('Unauthorized'),
        404: jsonErrorResponse('Album not found'),
      },
    }),
    async (c) => {
      const { id } = c.req.valid('param')
      await patchAlbum(id, c.req.valid('json'), c.get('user')?.id ?? null)
      const updated = await getAlbumDetail(id)
      if (!updated) {
        throw new ServerError({
          statusCode: 404,
          message: 'Album not found',
        })
      }

      return generateJsonResponse(c, updated, 200, 'Album updated')
    },
  )

export default app
