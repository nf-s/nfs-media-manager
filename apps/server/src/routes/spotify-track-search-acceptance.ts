import { createRoute } from '@hono/zod-openapi'
import {
  SpotifyInteractiveTrackSearchInputSchema,
  SpotifyInteractiveTrackSearchResultSchema,
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
import { searchSpotifyTrackInRequest } from '@/services/spotify-track-search'

const app = createOpenAPIApp()
app.openapi(
  createRoute({
    method: 'post',
    path: '/{trackId}',
    middleware: [authMiddleware(), mutationOriginMiddleware()],
    request: {
      params: SpotifyTrackSearchParamsSchema,
      body: {
        required: true,
        content: {
          'application/json': {
            schema: SpotifyInteractiveTrackSearchInputSchema,
          },
        },
      },
    },
    responses: {
      200: {
        description: 'Saved Spotify candidates for the requested recording',
        content: {
          'application/json': {
            schema: createResponseSchema(
              SpotifyInteractiveTrackSearchResultSchema,
            ),
          },
        },
      },
      401: jsonErrorResponse('Unauthorized'),
      404: jsonErrorResponse('Library track not found'),
      409: jsonErrorResponse(
        'The recording has changed or already has a match',
      ),
      422: validationErrorResponse,
      429: jsonErrorResponse('Spotify is cooling down, busy or halted'),
    },
  }),
  async (c) =>
    generateJsonResponse(
      c,
      await searchSpotifyTrackInRequest(
        c.req.valid('param').trackId,
        c.req.valid('json'),
        requireOwnerUser(c).id,
      ),
      200,
    ),
)

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
