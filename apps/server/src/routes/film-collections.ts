import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import { z } from 'zod'
import { BrowseCountSchema } from '@repo/schemas/browse'
import {
  FilmCollectionBrowsePageSchema,
  FilmCollectionBrowseQuerySchema,
  FilmCollectionDetailSchema,
  FilmCollectionQuerySchema,
  FilmCollectionSummarySchema,
} from '@repo/schemas/film-collections'
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
  countFilmCollections,
  getFilmCollection,
  listFilmCollectionBrowsePage,
} from '@/services/film-collections'

const app: OpenAPIHono<AppEnv> = createOpenAPIApp()
  .openapi(
    createRoute({
      method: 'get',
      path: '/',
      middleware: [authMiddleware()],
      request: { query: FilmCollectionBrowseQuerySchema },
      responses: {
        200: {
          description:
            'One page of stored collections containing library films',
          content: {
            'application/json': {
              schema: createResponseSchema(
                z.array(FilmCollectionSummarySchema),
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
      const page = await listFilmCollectionBrowsePage({
        ...query,
        includeSources: query.includeSources ?? 'true',
      })
      return generateJsonResponse(c, page.items, 200)
    },
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/browse-page',
      middleware: [authMiddleware()],
      request: { query: FilmCollectionBrowseQuerySchema },
      responses: {
        200: {
          description: 'Collection rows with a continuation indicator',
          content: {
            'application/json': {
              schema: createResponseSchema(FilmCollectionBrowsePageSchema),
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
        await listFilmCollectionBrowsePage(c.req.valid('query')),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/browse-count',
      middleware: [authMiddleware()],
      request: { query: FilmCollectionBrowseQuerySchema },
      responses: {
        200: {
          description: 'Exact count of stored collections matching the search',
          content: {
            'application/json': {
              schema: createResponseSchema(BrowseCountSchema),
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
        await countFilmCollections(c.req.valid('query')),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/:id',
      middleware: [authMiddleware()],
      request: {
        params: z.object({ id: z.string().min(1) }),
        query: FilmCollectionQuerySchema,
      },
      responses: {
        200: {
          description:
            'Collection films, sorted before pagination; stored positions preserve gaps',
          content: {
            'application/json': {
              schema: createResponseSchema(FilmCollectionDetailSchema),
            },
          },
        },
        401: jsonErrorResponse('Unauthorized'),
        404: jsonErrorResponse('Collection not found'),
        422: validationErrorResponse,
      },
    }),
    async (c) =>
      generateJsonResponse(
        c,
        await getFilmCollection(c.req.valid('param').id, c.req.valid('query')),
        200,
      ),
  )

export default app
