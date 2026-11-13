import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import type { Context } from 'hono'
import { createMiddleware } from 'hono/factory'
import { z } from 'zod'
import {
  PlaylistAlbumAdditionInputSchema,
  PlaylistAlbumAdditionSchema,
  PlaylistAlbumAdditionsQuerySchema,
  PlaylistAlbumAdditionsSchema,
  PlaylistDetailQuerySchema,
  PlaylistDetailSchema,
  PlaylistRemovalSchema,
  PlaylistSummarySchema,
  PlaylistSyncSettingsSchema,
} from '@repo/schemas/tracks'
import { env } from '@/env'
import { ServerError } from '@/lib/error'
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
  getPlaylistDetail,
  listPlaylists,
  removeImportedPlaylist,
  updatePlaylistSyncSchedule,
} from '@/services/tracks'
import {
  listSpotifyPlaylistAdditions,
  queueSpotifyPlaylistAddition,
} from '@/services/spotify-playlist-additions'

function userId(c: Context<AppEnv>) {
  const user = c.get('user')
  if (!user) throw new ServerError({ statusCode: 401, message: 'Unauthorized' })
  return user.id
}

const sameOrigin = createMiddleware<AppEnv>(async (c, next) => {
  const origin = c.req.header('origin')
  if (
    (origin && !env.TRUSTED_ORIGINS.includes(origin)) ||
    c.req.header('sec-fetch-site') === 'cross-site'
  ) {
    throw new ServerError({
      statusCode: 403,
      message: 'Request origin is not allowed',
    })
  }
  await next()
})

const PlaylistParamsSchema = z.object({ id: z.string().min(1) })

const app: OpenAPIHono<AppEnv> = createOpenAPIApp()
  .openapi(
    createRoute({
      method: 'get',
      path: '/',
      middleware: [authMiddleware()],
      responses: {
        200: {
          description:
            'Playlists with their track and library album counts, sync state and whether they accept albums',
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
      method: 'get',
      path: '/additions',
      middleware: [authMiddleware()],
      request: { query: PlaylistAlbumAdditionsQuerySchema },
      responses: {
        200: {
          description:
            'The latest job adding the album to each playlist; no Spotify requests',
          content: {
            'application/json': {
              schema: createResponseSchema(PlaylistAlbumAdditionsSchema),
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
        await listSpotifyPlaylistAdditions(c.req.valid('query').albumId),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/:id',
      middleware: [authMiddleware()],
      request: {
        params: PlaylistParamsSchema,
        query: PlaylistDetailQuerySchema,
      },
      responses: {
        200: {
          description:
            'One playlist with its sync state and a page of its entries in playlist order',
          content: {
            'application/json': {
              schema: createResponseSchema(PlaylistDetailSchema),
            },
          },
        },
        401: jsonErrorResponse('Unauthorized'),
        404: jsonErrorResponse('Playlist not found'),
        422: validationErrorResponse,
      },
    }),
    async (c) =>
      generateJsonResponse(
        c,
        await getPlaylistDetail(c.req.valid('param').id, c.req.valid('query')),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: 'put',
      path: '/:id/sync-schedule',
      middleware: [authMiddleware(), sameOrigin],
      request: {
        params: PlaylistParamsSchema,
        body: {
          required: true,
          content: {
            'application/json': { schema: PlaylistSyncSettingsSchema },
          },
        },
      },
      responses: {
        200: {
          description:
            'Set how often an imported playlist is imported again; returns the playlist',
          content: {
            'application/json': {
              schema: createResponseSchema(PlaylistSummarySchema),
            },
          },
        },
        401: jsonErrorResponse('Unauthorized'),
        403: jsonErrorResponse('Request origin is not allowed'),
        404: jsonErrorResponse('Playlist not found'),
        422: validationErrorResponse,
      },
    }),
    async (c) =>
      generateJsonResponse(
        c,
        await updatePlaylistSyncSchedule(
          c.req.valid('param').id,
          c.req.valid('json').schedule,
          userId(c),
        ),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/:id/additions',
      middleware: [authMiddleware(), sameOrigin],
      request: {
        params: PlaylistParamsSchema,
        body: {
          required: true,
          content: {
            'application/json': { schema: PlaylistAlbumAdditionInputSchema },
          },
        },
      },
      responses: {
        200: {
          description:
            'Queue a job adding the album to the Spotify playlist, or return the one queued or running',
          content: {
            'application/json': {
              schema: createResponseSchema(PlaylistAlbumAdditionSchema),
            },
          },
        },
        401: jsonErrorResponse('Unauthorized'),
        403: jsonErrorResponse('Request origin is not allowed'),
        404: jsonErrorResponse('Playlist or album not found'),
        422: validationErrorResponse,
        429: jsonErrorResponse('Spotify is cooling down or halted'),
      },
    }),
    async (c) =>
      generateJsonResponse(
        c,
        await queueSpotifyPlaylistAddition(
          c.req.valid('param').id,
          c.req.valid('json'),
          userId(c),
        ),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: 'delete',
      path: '/:id',
      middleware: [authMiddleware()],
      request: { params: PlaylistParamsSchema },
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
