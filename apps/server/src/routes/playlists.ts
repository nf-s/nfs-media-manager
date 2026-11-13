import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import { z } from 'zod'
import {
  PlaylistRemovalSchema,
  PlaylistSummarySchema,
} from '@repo/schemas/tracks'
import {
  createOpenAPIApp,
  createResponseSchema,
  jsonErrorResponse,
  type AppEnv,
} from '@/lib/openapi'
import { generateJsonResponse } from '@/lib/response'
import { authMiddleware } from '@/middlewares/auth'
import { listPlaylists, removeImportedPlaylist } from '@/services/tracks'

const app: OpenAPIHono<AppEnv> = createOpenAPIApp()
  .openapi(
    createRoute({
      method: 'get',
      path: '/',
      middleware: [authMiddleware()],
      responses: {
        200: {
          description: 'Playlists with their track and library album counts',
          content: {
            'application/json': {
              schema: createResponseSchema(z.array(PlaylistSummarySchema)),
            },
          },
        },
        401: jsonErrorResponse('Unauthorized'),
      },
    }),
    async (c) => generateJsonResponse(c, await listPlaylists(), 200),
  )
  .openapi(
    createRoute({
      method: 'delete',
      path: '/:id',
      middleware: [authMiddleware()],
      request: { params: z.object({ id: z.string().min(1) }) },
      responses: {
        200: {
          description:
            'Remove an imported playlist and the tracks in no other playlist',
          content: {
            'application/json': {
              schema: createResponseSchema(PlaylistRemovalSchema),
            },
          },
        },
        401: jsonErrorResponse('Unauthorized'),
        404: jsonErrorResponse('Imported playlist not found'),
      },
    }),
    async (c) =>
      generateJsonResponse(
        c,
        await removeImportedPlaylist(c.req.valid('param').id),
        200,
      ),
  )

export default app
