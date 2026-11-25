import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import {
  CatalogMembershipInputSchema,
  CatalogMembershipResultSchema,
  ManualMediaAddInputSchema,
  ManualMediaAddResultSchema,
  ManualMediaSearchInputSchema,
  ManualMediaSearchResultSchema,
} from '@repo/schemas/manual-add'
import {
  createOpenAPIApp,
  createResponseSchema,
  jsonErrorResponse,
  validationErrorResponse,
  type AppEnv,
} from '@/lib/openapi'
import { ServerError } from '@/lib/error'
import { generateJsonResponse } from '@/lib/response'
import {
  authMiddleware,
  mutationOriginMiddleware,
  requireOwnerUser,
} from '@/middlewares/auth'
import {
  addManualMedia,
  readCatalogMembership,
  searchManualMedia,
} from '@/services/manual-add'

const app: OpenAPIHono<AppEnv> = createOpenAPIApp()
app.use('*', mutationOriginMiddleware())
app.openapi(
  createRoute({
    method: 'post',
    path: '/membership',
    middleware: [authMiddleware()],
    request: {
      body: {
        required: true,
        content: {
          'application/json': { schema: CatalogMembershipInputSchema },
        },
      },
    },
    responses: {
      200: {
        description: 'Library matches for the supplied Spotify catalog IDs',
        content: {
          'application/json': {
            schema: createResponseSchema(CatalogMembershipResultSchema),
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
      await readCatalogMembership(c.req.valid('json')),
      200,
    )
  },
)
app.openapi(
  createRoute({
    method: 'post',
    path: '/search',
    middleware: [authMiddleware()],
    request: {
      body: {
        required: true,
        content: {
          'application/json': { schema: ManualMediaSearchInputSchema },
        },
      },
    },
    responses: {
      200: {
        description: 'One page of Spotify albums, Spotify tracks or TMDb films',
        content: {
          'application/json': {
            schema: createResponseSchema(ManualMediaSearchResultSchema),
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
      await searchManualMedia(c.req.valid('json'), {
        userId: requireOwnerUser(c).id,
      }),
      200,
    ),
)

app.openapi(
  createRoute({
    method: 'post',
    path: '/add',
    middleware: [authMiddleware()],
    request: {
      body: {
        required: true,
        content: { 'application/json': { schema: ManualMediaAddInputSchema } },
      },
    },
    responses: {
      200: {
        description: 'Added item, or the unchanged existing library item',
        content: {
          'application/json': {
            schema: createResponseSchema(ManualMediaAddResultSchema),
          },
        },
      },
      401: jsonErrorResponse('Unauthorized'),
      409: jsonErrorResponse('Ambiguous existing identity'),
      422: validationErrorResponse,
      429: jsonErrorResponse('Spotify is busy'),
      502: jsonErrorResponse('Spotify could not confirm the release'),
    },
  }),
  async (c) =>
    generateJsonResponse(
      c,
      await addManualMedia(c.req.valid('json'), requireOwnerUser(c).id),
      200,
    ),
)

app.onError((error, c) =>
  error instanceof ServerError
    ? c.json(error.response, error.response.statusCode)
    : generateJsonResponse(
        c,
        null,
        500,
        'Unable to add or search library items',
      ),
)

export default app
