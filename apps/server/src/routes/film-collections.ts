import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import { z } from 'zod'
import {
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
  getFilmCollection,
  listFilmCollections,
} from '@/services/film-collections'

const app: OpenAPIHono<AppEnv> = createOpenAPIApp()
  .openapi(
    createRoute({
      method: 'get',
      path: '/',
      middleware: [authMiddleware()],
      responses: {
        200: {
          description: 'Stored collections containing library films',
          content: {
            'application/json': {
              schema: createResponseSchema(
                z.array(FilmCollectionSummarySchema),
              ),
            },
          },
        },
        401: jsonErrorResponse('Unauthorized'),
      },
    }),
    async (c) => generateJsonResponse(c, await listFilmCollections(), 200),
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
