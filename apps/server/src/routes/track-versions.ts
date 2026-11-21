import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import { LibraryChangeSchema } from '@repo/schemas/library-changes'
import {
  AlbumUnlistedNamesParamsSchema,
  AlbumUnlistedNamesSchema,
  TrackPartsParamsSchema,
  TrackPartsSchema,
  TrackVersionRequestSchema,
} from '@repo/schemas/track-versions'
import {
  createOpenAPIApp,
  createResponseSchema,
  jsonErrorResponse,
  type AppEnv,
  validationErrorResponse,
} from '@/lib/openapi'
import { generateJsonResponse } from '@/lib/response'
import { authMiddleware, mutationOriginMiddleware } from '@/middlewares/auth'
import {
  readAlbumUnlistedNames,
  readTrackParts,
  separateTrackVersion,
  showTrackVersion,
} from '@/services/track-versions'

const versionRoute = (path: string, description: string) =>
  createRoute({
    method: 'post',
    path,
    middleware: [authMiddleware(), mutationOriginMiddleware()],
    request: {
      body: {
        required: true,
        content: { 'application/json': { schema: TrackVersionRequestSchema } },
      },
    },
    responses: {
      200: {
        description,
        content: {
          'application/json': {
            schema: createResponseSchema(LibraryChangeSchema),
          },
        },
      },
      401: jsonErrorResponse('Unauthorized'),
      403: jsonErrorResponse('Forbidden'),
      404: jsonErrorResponse('Track not found'),
      409: jsonErrorResponse('The track has no other versions'),
      422: validationErrorResponse,
    },
  })

/** Mounted at `/library-changes/track-versions`. */
export const trackVersionChanges: OpenAPIHono<AppEnv> = createOpenAPIApp()
  .openapi(
    versionRoute(
      '/separate',
      'Gave a version its own row again and recorded the change',
    ),
    async (c) =>
      generateJsonResponse(
        c,
        await separateTrackVersion(c.req.valid('json').trackId),
        200,
      ),
  )
  .openapi(
    versionRoute(
      '/shown',
      "Showed the record's row as the version and recorded the change",
    ),
    async (c) =>
      generateJsonResponse(
        c,
        await showTrackVersion(c.req.valid('json').trackId),
        200,
      ),
  )

/** Mounted at `/tracks`, before the tracks routes. */
export const trackParts: OpenAPIHono<AppEnv> = createOpenAPIApp().openapi(
  createRoute({
    method: 'get',
    path: '/:id/parts',
    middleware: [authMiddleware()],
    request: { params: TrackPartsParamsSchema },
    responses: {
      200: {
        description: "The versions of the track's record and their names",
        content: {
          'application/json': {
            schema: createResponseSchema(TrackPartsSchema),
          },
        },
      },
      401: jsonErrorResponse('Unauthorized'),
      404: jsonErrorResponse('Track not found'),
      422: validationErrorResponse,
    },
  }),
  async (c) =>
    generateJsonResponse(c, await readTrackParts(c.req.valid('param').id), 200),
)

/** Mounted at `/albums`, before the albums routes. */
export const albumUnlistedNames: OpenAPIHono<AppEnv> =
  createOpenAPIApp().openapi(
    createRoute({
      method: 'get',
      path: '/:id/unlisted-names',
      middleware: [authMiddleware()],
      request: { params: AlbumUnlistedNamesParamsSchema },
      responses: {
        200: {
          description:
            'Names scrobbled under the album whose track is not on its track list',
          content: {
            'application/json': {
              schema: createResponseSchema(AlbumUnlistedNamesSchema),
            },
          },
        },
        401: jsonErrorResponse('Unauthorized'),
        404: jsonErrorResponse('Album not found'),
        422: validationErrorResponse,
      },
    }),
    async (c) =>
      generateJsonResponse(
        c,
        await readAlbumUnlistedNames(c.req.valid('param').id),
        200,
      ),
  )
