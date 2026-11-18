import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import { z } from 'zod'
import {
  AlbumCollectionBrowsePageSchema,
  AlbumCollectionBrowseQuerySchema,
  AlbumCollectionDetailSchema,
  AlbumCollectionQuerySchema,
} from '@repo/schemas/album-collections'
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
  countAlbumCollections,
  countFilmCollections,
  getAlbumCollection,
  getFilmCollection,
  listAlbumCollectionBrowsePage,
  listFilmCollectionBrowsePage,
} from '@/services/collections'

function readResponses<T extends z.ZodTypeAny>(description: string, schema: T) {
  return {
    200: {
      description,
      content: { 'application/json': { schema: createResponseSchema(schema) } },
    },
    401: jsonErrorResponse('Unauthorized'),
    422: validationErrorResponse,
  }
}

function collectionRoutes<
  BrowseQuery extends z.ZodObject,
  BrowsePage extends z.ZodTypeAny,
  DetailQuery extends z.ZodObject,
  Detail extends z.ZodTypeAny,
>(
  browseQuery: BrowseQuery,
  browsePage: BrowsePage,
  detailQuery: DetailQuery,
  detail: Detail,
) {
  return {
    browsePage: createRoute({
      method: 'get',
      path: '/browse-page',
      middleware: [authMiddleware()],
      request: { query: browseQuery },
      responses: readResponses(
        'Collection rows with a continuation indicator',
        browsePage,
      ),
    }),
    browseCount: createRoute({
      method: 'get',
      path: '/browse-count',
      middleware: [authMiddleware()],
      request: { query: browseQuery },
      responses: readResponses(
        'Exact count of stored collections matching the search',
        BrowseCountSchema,
      ),
    }),
    detail: createRoute({
      method: 'get',
      path: '/:id',
      middleware: [authMiddleware()],
      request: {
        params: z.object({ id: z.string().min(1) }),
        query: detailQuery,
      },
      responses: {
        ...readResponses(
          'Collection members, sorted before pagination with stored positions preserved',
          detail,
        ),
        404: jsonErrorResponse('Collection not found'),
      },
    }),
  }
}

const films = collectionRoutes(
  FilmCollectionBrowseQuerySchema,
  FilmCollectionBrowsePageSchema,
  FilmCollectionQuerySchema,
  FilmCollectionDetailSchema,
)
const albums = collectionRoutes(
  AlbumCollectionBrowseQuerySchema,
  AlbumCollectionBrowsePageSchema,
  AlbumCollectionQuerySchema,
  AlbumCollectionDetailSchema,
)

export const filmCollections: OpenAPIHono<AppEnv> = createOpenAPIApp()
  .openapi(
    createRoute({
      method: 'get',
      path: '/',
      middleware: [authMiddleware()],
      request: { query: FilmCollectionBrowseQuerySchema },
      responses: readResponses(
        'One page of stored collections containing library films',
        z.array(FilmCollectionSummarySchema),
      ),
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
  .openapi(films.browsePage, async (c) =>
    generateJsonResponse(
      c,
      await listFilmCollectionBrowsePage(c.req.valid('query')),
      200,
    ),
  )
  .openapi(films.browseCount, async (c) =>
    generateJsonResponse(
      c,
      await countFilmCollections(c.req.valid('query')),
      200,
    ),
  )
  .openapi(films.detail, async (c) =>
    generateJsonResponse(
      c,
      await getFilmCollection(c.req.valid('param').id, c.req.valid('query')),
      200,
    ),
  )

export const albumCollections: OpenAPIHono<AppEnv> = createOpenAPIApp()
  .openapi(albums.browsePage, async (c) =>
    generateJsonResponse(
      c,
      await listAlbumCollectionBrowsePage(c.req.valid('query')),
      200,
    ),
  )
  .openapi(albums.browseCount, async (c) =>
    generateJsonResponse(
      c,
      await countAlbumCollections(c.req.valid('query')),
      200,
    ),
  )
  .openapi(albums.detail, async (c) =>
    generateJsonResponse(
      c,
      await getAlbumCollection(c.req.valid('param').id, c.req.valid('query')),
      200,
    ),
  )
