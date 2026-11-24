import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import {
  SpotifyAlbumReferenceInputSchema,
  SpotifyAlbumReferenceResultSchema,
} from '@repo/schemas/spotify-album-reference'
import {
  createOpenAPIApp,
  createResponseSchema,
  jsonErrorResponse,
  validationErrorResponse,
  type AppEnv,
} from '@/lib/openapi'
import { generateJsonResponse } from '@/lib/response'
import { authMiddleware, requireOwnerUser } from '@/middlewares/auth'
import { openSpotifyAlbumReference } from '@/services/spotify-album-reference'

const spotifyAlbumReference: OpenAPIHono<AppEnv> = createOpenAPIApp()

spotifyAlbumReference.openapi(
  createRoute({
    method: 'post',
    path: '/',
    middleware: [authMiddleware()],
    request: {
      body: {
        required: true,
        content: {
          'application/json': { schema: SpotifyAlbumReferenceInputSchema },
        },
      },
    },
    responses: {
      200: {
        description: 'The resolved parent album',
        content: {
          'application/json': {
            schema: createResponseSchema(SpotifyAlbumReferenceResultSchema),
          },
        },
      },
      401: jsonErrorResponse('Unauthorized'),
      404: jsonErrorResponse('The track reference was not found'),
      409: jsonErrorResponse('The track does not identify one Spotify release'),
      422: validationErrorResponse,
      429: jsonErrorResponse('Spotify is busy'),
      502: jsonErrorResponse('Spotify could not confirm the release'),
    },
  }),
  async (c) =>
    generateJsonResponse(
      c,
      await openSpotifyAlbumReference(
        c.req.valid('json'),
        requireOwnerUser(c).id,
      ),
      200,
    ),
)

export default spotifyAlbumReference
