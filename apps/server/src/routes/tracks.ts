import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import { z } from 'zod'
import {
  BrowseCountSchema,
  BrowseFacetQuerySchema,
  BrowseFieldSchema,
  BrowsePageSliceSchema,
} from '@repo/schemas/browse'
import { PaginatedDataSchema } from '@repo/schemas/common'
import { ListeningSeriesSchema } from '@repo/schemas/lastfm'
import {
  TrackDetailSchema,
  TrackFilterOptionSchema,
  TrackListItemSchema,
  TrackMergeInputSchema,
  TrackMergeResultSchema,
  TrackPositionsQuerySchema,
  TrackPositionsSchema,
  TrackQuerySchema,
} from '@repo/schemas/tracks'
import {
  TrackPlaylistAdditionInputSchema,
  TrackPlaylistAdditionSchema,
  TrackPlaylistAdditionsSchema,
} from '@repo/schemas/track-playlist-additions'
import { ServerError } from '@/lib/error'
import {
  createOpenAPIApp,
  createResponseSchema,
  jsonErrorResponse,
  type AppEnv,
  validationErrorResponse,
} from '@/lib/openapi'
import { generateJsonResponse } from '@/lib/response'
import { authMiddleware, mutationOriginMiddleware } from '@/middlewares/auth'
import { listBrowseFields, queryBrowseCount } from '@/services/browse'
import {
  getTrackDetail,
  listTrackBrowsePage,
  listTrackFilterOptions,
  listTracks,
  listTracksAtPositions,
} from '@/services/tracks'
import { mergeLastfmTrack } from '@/services/track-merges'
import { getTrackListeningSeries } from '@/services/listening-series'
import {
  listSpotifyTrackPlaylistAdditions,
  queueSpotifyTrackPlaylistAddition,
} from '@/services/spotify-track-playlist-additions'

const app: OpenAPIHono<AppEnv> = createOpenAPIApp()

app.openapi(
  createRoute({
    method: 'get',
    path: '/browse-page',
    middleware: [authMiddleware()],
    request: { query: TrackQuerySchema },
    responses: {
      200: {
        description: 'Browse rows with a continuation indicator',
        content: {
          'application/json': {
            schema: createResponseSchema(
              BrowsePageSliceSchema(TrackListItemSchema),
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
      await listTrackBrowsePage(c.req.valid('query')),
      200,
    ),
)

app.openapi(
  createRoute({
    method: 'get',
    path: '/positions',
    middleware: [authMiddleware()],
    request: { query: TrackPositionsQuerySchema },
    responses: {
      200: {
        description: 'Tracks at positions of the query order',
        content: {
          'application/json': {
            schema: createResponseSchema(TrackPositionsSchema),
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
      await listTracksAtPositions(c.req.valid('query')),
      200,
    ),
)

app.openapi(
  createRoute({
    method: 'get',
    path: '/browse-count',
    middleware: [authMiddleware()],
    request: { query: TrackQuerySchema },
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
      await queryBrowseCount('track', c.req.valid('query')),
      200,
    ),
)

app
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
    async (c) => generateJsonResponse(c, await listBrowseFields('track'), 200),
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/',
      middleware: [authMiddleware()],
      request: { query: TrackQuerySchema },
      responses: {
        200: {
          description: 'Track list',
          content: {
            'application/json': {
              schema: createResponseSchema(
                PaginatedDataSchema(TrackListItemSchema),
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
      const data = await listTracks(query)
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
        200: {
          description: 'Track filter options',
          content: {
            'application/json': {
              schema: createResponseSchema(z.array(TrackFilterOptionSchema)),
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
        await listTrackFilterOptions(c.req.valid('query')),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/:id/playlist-additions',
      middleware: [authMiddleware()],
      request: { params: z.object({ id: z.string().min(1).max(200) }) },
      responses: {
        200: {
          description: 'Latest jobs adding this track to Spotify playlists',
          content: {
            'application/json': {
              schema: createResponseSchema(TrackPlaylistAdditionsSchema),
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
        await listSpotifyTrackPlaylistAdditions(c.req.valid('param').id),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/:id/playlist-additions',
      middleware: [authMiddleware(), mutationOriginMiddleware()],
      request: {
        params: z.object({ id: z.string().min(1).max(200) }),
        body: {
          required: true,
          content: {
            'application/json': { schema: TrackPlaylistAdditionInputSchema },
          },
        },
      },
      responses: {
        200: {
          description: 'Queue the track addition, or return its active job',
          content: {
            'application/json': {
              schema: createResponseSchema(TrackPlaylistAdditionSchema),
            },
          },
        },
        401: jsonErrorResponse('Unauthorized'),
        403: jsonErrorResponse('Forbidden'),
        404: jsonErrorResponse('Track or playlist not found'),
        422: validationErrorResponse,
        429: jsonErrorResponse('Spotify is cooling down or halted'),
      },
    }),
    async (c) => {
      const user = c.get('user')
      if (!user)
        throw new ServerError({ statusCode: 401, message: 'Unauthorized' })
      return generateJsonResponse(
        c,
        await queueSpotifyTrackPlaylistAddition(
          c.req.valid('param').id,
          c.req.valid('json'),
          user.id,
        ),
        200,
      )
    },
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/:id/merge',
      middleware: [authMiddleware(), mutationOriginMiddleware()],
      request: {
        params: z.object({ id: z.string().min(1) }),
        body: {
          content: { 'application/json': { schema: TrackMergeInputSchema } },
          required: true,
        },
      },
      responses: {
        200: {
          description: 'Last.fm track merged into the selected Spotify track',
          content: {
            'application/json': {
              schema: createResponseSchema(TrackMergeResultSchema),
            },
          },
        },
        401: jsonErrorResponse('Unauthorized'),
        403: jsonErrorResponse('Forbidden'),
        404: jsonErrorResponse('Track not found'),
        409: jsonErrorResponse('Tracks cannot be merged'),
        422: validationErrorResponse,
      },
    }),
    async (c) =>
      generateJsonResponse(
        c,
        await mergeLastfmTrack(c.req.valid('param').id, c.req.valid('json')),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/:id/listening/series',
      middleware: [authMiddleware()],
      request: { params: z.object({ id: z.string().min(1) }) },
      responses: {
        200: {
          description:
            'Stored scrobbles counted towards the track, by day for five years and by month',
          content: {
            'application/json': {
              schema: createResponseSchema(ListeningSeriesSchema),
            },
          },
        },
        401: jsonErrorResponse('Unauthorized'),
        404: jsonErrorResponse('Track not found'),
        422: validationErrorResponse,
      },
    }),
    async (c) =>
      generateJsonResponse(
        c,
        await getTrackListeningSeries(c.req.valid('param').id),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/:id',
      middleware: [authMiddleware()],
      request: { params: z.object({ id: z.string().min(1) }) },
      responses: {
        200: {
          description:
            'Track detail with its library album, playlists and stored scrobbles',
          content: {
            'application/json': {
              schema: createResponseSchema(TrackDetailSchema),
            },
          },
        },
        401: jsonErrorResponse('Unauthorized'),
        404: jsonErrorResponse('Track not found'),
      },
    }),
    async (c) => {
      const record = await getTrackDetail(c.req.valid('param').id)
      if (!record)
        throw new ServerError({ statusCode: 404, message: 'Track not found' })
      return generateJsonResponse(c, record, 200)
    },
  )

export default app
