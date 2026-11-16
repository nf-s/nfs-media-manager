import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import {
  MatchSearchInputSchema,
  MatchSearchResultSchema,
  UnresolvedMatchListSchema,
  UnresolvedMatchQuerySchema,
} from '@repo/schemas/find-match'
import {
  createOpenAPIApp,
  createResponseSchema,
  jsonErrorResponse,
  validationErrorResponse,
  type AppEnv,
} from '@/lib/openapi'
import { ServerError } from '@/lib/error'
import { generateJsonResponse } from '@/lib/response'
import { authMiddleware, mutationOriginMiddleware } from '@/middlewares/auth'
import {
  listUnresolvedMatches,
  searchMatchCandidates,
} from '@/services/find-match'

const app: OpenAPIHono<AppEnv> = createOpenAPIApp()
app.use('*', mutationOriginMiddleware())
app.openapi(
  createRoute({
    method: 'post',
    path: '/search',
    middleware: [authMiddleware()],
    request: {
      body: {
        required: true,
        content: { 'application/json': { schema: MatchSearchInputSchema } },
      },
    },
    responses: {
      200: {
        description:
          'Records one provider lists for an album, film or artist, marking the stored one',
        content: {
          'application/json': {
            schema: createResponseSchema(MatchSearchResultSchema),
          },
        },
      },
      401: jsonErrorResponse('Unauthorized'),
      404: jsonErrorResponse('Item not found'),
      422: validationErrorResponse,
    },
  }),
  async (c) =>
    generateJsonResponse(
      c,
      await searchMatchCandidates(c.req.valid('json')),
      200,
    ),
)

app.openapi(
  createRoute({
    method: 'get',
    path: '/unresolved',
    middleware: [authMiddleware()],
    request: { query: UnresolvedMatchQuerySchema },
    responses: {
      200: {
        description:
          'Providers whose latest lookup for the item found no match or several; no provider requests',
        content: {
          'application/json': {
            schema: createResponseSchema(UnresolvedMatchListSchema),
          },
        },
      },
      401: jsonErrorResponse('Unauthorized'),
      404: jsonErrorResponse('Item not found'),
      422: validationErrorResponse,
    },
  }),
  async (c) =>
    generateJsonResponse(
      c,
      await listUnresolvedMatches(c.req.valid('query')),
      200,
    ),
)

app.onError((error, c) =>
  error instanceof ServerError
    ? c.json(error.response, error.response.statusCode)
    : generateJsonResponse(c, null, 500, 'Unable to find matches'),
)

export default app
