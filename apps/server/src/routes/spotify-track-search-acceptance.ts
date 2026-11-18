import { createRoute } from '@hono/zod-openapi'
import {
  SpotifyTrackSearchAcceptInputSchema,
  SpotifyTrackSearchAcceptResultSchema,
  SpotifyTrackSearchParamsSchema,
  SpotifyTrackSearchTargetConflictSchema,
} from '@repo/schemas/spotify-track-search'
import {
  createOpenAPIApp,
  createResponseSchema,
  jsonErrorResponse,
  validationErrorResponse,
} from '@/lib/openapi'
import { generateJsonResponse } from '@/lib/response'
import {
  authMiddleware,
  mutationOriginMiddleware,
  requireOwnerUser,
} from '@/middlewares/auth'
import { acceptSpotifyTrackSearch } from '@/services/spotify-track-search-acceptance'

const app = createOpenAPIApp()
app.openapi(
  createRoute({
    method: 'post',
    path: '/{trackId}/accept',
    middleware: [authMiddleware(), mutationOriginMiddleware()],
    request: {
      params: SpotifyTrackSearchParamsSchema,
      body: {
        required: true,
        content: {
          'application/json': { schema: SpotifyTrackSearchAcceptInputSchema },
        },
      },
    },
    responses: {
      200: {
        description:
          'The library recording linked to the confirmed Spotify track',
        content: {
          'application/json': {
            schema: createResponseSchema(SpotifyTrackSearchAcceptResultSchema),
          },
        },
      },
      401: jsonErrorResponse('Unauthorized'),
      404: jsonErrorResponse('Track or stored candidate was not found'),
      409: jsonErrorResponse(
        'Track or search changed, or the catalog candidate conflicts with an existing library recording',
        createResponseSchema(SpotifyTrackSearchTargetConflictSchema.nullable()),
      ),
      422: validationErrorResponse,
    },
  }),
  async (c) =>
    generateJsonResponse(
      c,
      await acceptSpotifyTrackSearch({
        ...c.req.valid('param'),
        ...c.req.valid('json'),
        userId: requireOwnerUser(c).id,
      }),
      200,
    ),
)

export default app
