import {
  BrowseCountSchema,
  BrowseFacetQuerySchema,
  BrowseFieldSchema,
  BrowsePageSliceSchema,
} from '@repo/schemas/browse'
import { listBrowseFields, queryBrowseCounts } from '@/services/browse'
import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import { z } from 'zod'
import {
  FilmDetailSchema,
  FilmFilterOptionSchema,
  FilmListItemSchema,
  FilmPatchSchema,
  FilmQuerySchema,
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
  getFilmDetail,
  listFilmBrowsePage,
  listFilmFilterOptions,
  listFilms,
  patchFilm,
} from '@/services/media'
import { ServerError } from '@/lib/error'
import {
  FilmSelectionQuerySchema,
  FilmSelectionPageSchema,
} from '@repo/schemas/film-selection'
import { listFilmSelection } from '@/services/film-selection'
import {
  MatchDiagnosticsPageSchema,
  MatchDiagnosticsQuerySchema,
} from '@repo/schemas/match-diagnostics'
import { listMediaMatchDiagnostics } from '@/services/media-match-diagnostics'

const app: OpenAPIHono<AppEnv> = createOpenAPIApp()

app.openapi(
  createRoute({
    method: 'get',
    path: '/match-diagnostics',
    middleware: [authMiddleware()],
    request: { query: MatchDiagnosticsQuerySchema },
    responses: {
      200: {
        description: 'Library films and their stored provider matches',
        content: {
          'application/json': {
            schema: createResponseSchema(MatchDiagnosticsPageSchema),
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
      await listMediaMatchDiagnostics('film', c.req.valid('query')),
      200,
    ),
)

app.openapi(
  createRoute({
    method: 'get',
    path: '/browse-page',
    middleware: [authMiddleware()],
    request: { query: FilmQuerySchema },
    responses: {
      200: {
        description: 'Browse rows with a continuation indicator',
        content: {
          'application/json': {
            schema: createResponseSchema(
              BrowsePageSliceSchema(FilmListItemSchema),
            ),
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
      await listFilmBrowsePage(c.req.valid('query')),
      200,
    ),
)

app.openapi(
  createRoute({
    method: 'get',
    path: '/browse-count',
    middleware: [authMiddleware()],
    request: { query: FilmQuerySchema },
    responses: {
      200: {
        description: 'Exact count for the current browse filters',
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
      await queryBrowseCounts('film', c.req.valid('query')),
      200,
    ),
)

app
  .openapi(
    createRoute({
      method: 'get',
      path: '/selection',
      middleware: [authMiddleware()],
      request: { query: FilmSelectionQuerySchema },
      responses: {
        200: {
          description: 'Films with provider-specific scrape freshness',
          content: {
            'application/json': {
              schema: createResponseSchema(FilmSelectionPageSchema),
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
        await listFilmSelection(c.req.valid('query')),
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
    async (c) => generateJsonResponse(c, await listBrowseFields('film'), 200),
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/',
      middleware: [authMiddleware()],
      request: {
        query: FilmQuerySchema,
      },
      responses: {
        200: {
          description: 'Film list',
          content: {
            'application/json': {
              schema: createResponseSchema(
                PaginatedDataSchema(FilmListItemSchema),
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
      const data = await listFilms(query)
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
        422: validationErrorResponse,
        200: {
          description: 'Film filter options',
          content: {
            'application/json': {
              schema: createResponseSchema(z.array(FilmFilterOptionSchema)),
            },
          },
        },
        401: jsonErrorResponse('Unauthorized'),
      },
    }),
    async (c) => {
      const data = await listFilmFilterOptions(c.req.valid('query'))
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
          description: 'Film detail',
          content: {
            'application/json': {
              schema: createResponseSchema(FilmDetailSchema),
            },
          },
        },
        401: jsonErrorResponse('Unauthorized'),
        404: jsonErrorResponse('Film not found'),
      },
    }),
    async (c) => {
      const record = await getFilmDetail(c.req.valid('param').id)
      if (!record) {
        throw new ServerError({
          statusCode: 404,
          message: 'Film not found',
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
              schema: FilmPatchSchema,
            },
          },
        },
      },
      responses: {
        200: {
          description: 'Film updated',
          content: {
            'application/json': {
              schema: createResponseSchema(FilmDetailSchema),
            },
          },
        },
        401: jsonErrorResponse('Unauthorized'),
        404: jsonErrorResponse('Film not found'),
      },
    }),
    async (c) => {
      const { id } = c.req.valid('param')
      await patchFilm(id, c.req.valid('json'), c.get('user')?.id ?? null)
      const updated = await getFilmDetail(id)
      if (!updated) {
        throw new ServerError({
          statusCode: 404,
          message: 'Film not found',
        })
      }

      return generateJsonResponse(c, updated, 200, 'Film updated')
    },
  )

export default app
