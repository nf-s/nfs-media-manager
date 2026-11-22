import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import { z } from 'zod'
import {
  BrowseCountSchema,
  BrowseFacetQuerySchema,
  BrowseFieldSchema,
  BrowsePageSliceSchema,
} from '@repo/schemas/browse'
import { PaginatedDataSchema } from '@repo/schemas/common'
import {
  MatchDiagnosticsPageSchema,
  TrackMatchDiagnosticsQuerySchema,
  trackMatchDiagnosticFields,
} from '@repo/schemas/match-diagnostics'
import { ListeningSeriesSchema } from '@repo/schemas/lastfm'
import { ListeningHistogramSchema } from '@repo/schemas/listening'
import {
  TrackDetailSchema,
  TrackFilterOptionSchema,
  TrackListeningHistogramQuerySchema,
  TrackListItemSchema,
  TrackMatchIdSchema,
  TrackMergeInputSchema,
  TrackMergeResultSchema,
  TrackPositionsQuerySchema,
  TrackPositionsSchema,
  TrackQuerySchema,
  TrackScrobbleMatchInputSchema,
  TrackScrobbleNamesPageSchema,
  TrackScrobbleNamesQuerySchema,
  TrackScrobbleRemoveInputSchema,
  TrackTagChangeSchema,
  TrackTagInputSchema,
  TrackTagResetSchema,
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
import {
  authMiddleware,
  mutationOriginMiddleware,
  requireOwnerUser,
} from '@/middlewares/auth'
import {
  listBrowseFields,
  queryBrowseCounts,
  queryListeningHistogram,
} from '@/services/browse'
import {
  getTrackDetail,
  listTrackBrowsePage,
  listTrackFilterOptions,
  listTrackRecordingVersions,
  listTracks,
  listTracksAtPositions,
} from '@/services/tracks'
import {
  matchScrobbleTrack,
  mergeLastfmTrack,
  removeScrobbleTrackMatch,
} from '@/services/track-merges'
import { listLastfmTrackNames } from '@/services/lastfm-track-names'
import {
  addTrackTag,
  removeTrackTag,
  resetTrackTags,
} from '@/services/track-tags'
import {
  listTrackMatchDiagnostics,
  listTrackMatchDiagnosticsFacets,
} from '@/services/track-match-diagnostics'
import { getTrackListeningSeries } from '@/services/listening-series'
import {
  listSpotifyTrackPlaylistAdditions,
  queueSpotifyTrackPlaylistAddition,
} from '@/services/spotify-track-playlist-additions'

const app: OpenAPIHono<AppEnv> = createOpenAPIApp()

app.openapi(
  createRoute({
    method: 'get',
    path: '/match-diagnostics',
    middleware: [authMiddleware()],
    request: { query: TrackMatchDiagnosticsQuerySchema },
    responses: {
      200: {
        description: 'Stored track names and provider identities',
        content: {
          'application/json': {
            schema: createResponseSchema(MatchDiagnosticsPageSchema),
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
      await listTrackMatchDiagnostics(
        c.req.valid('query'),
        requireOwnerUser(c).id,
      ),
      200,
    ),
)

app.openapi(
  createRoute({
    method: 'get',
    path: '/match-diagnostics/fields',
    middleware: [authMiddleware()],
    responses: {
      200: {
        description: 'Track comparison filter and sort fields',
        content: {
          'application/json': {
            schema: createResponseSchema(z.array(BrowseFieldSchema)),
          },
        },
      },
      401: jsonErrorResponse('Unauthorized'),
    },
  }),
  async (c) => generateJsonResponse(c, trackMatchDiagnosticFields, 200),
)

app.openapi(
  createRoute({
    method: 'get',
    path: '/match-diagnostics/facets',
    middleware: [authMiddleware()],
    request: { query: BrowseFacetQuerySchema },
    responses: {
      200: {
        description: 'Stored track and match filter suggestions',
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
      await listTrackMatchDiagnosticsFacets(c.req.valid('query')),
      200,
    ),
)

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
      await queryBrowseCounts('track', c.req.valid('query')),
      200,
    ),
)

app.openapi(
  createRoute({
    method: 'get',
    path: '/listening-histogram',
    middleware: [authMiddleware()],
    request: { query: TrackListeningHistogramQuerySchema },
    responses: {
      200: {
        description:
          'Tracks or recordings per scrobble-count bar in a period, without listening rules',
        content: {
          'application/json': {
            schema: createResponseSchema(ListeningHistogramSchema),
          },
        },
      },
      401: jsonErrorResponse('Unauthorized'),
      422: validationErrorResponse,
    },
  }),
  async (c) => {
    const query = c.req.valid('query')
    return generateJsonResponse(
      c,
      await queryListeningHistogram('track', query, query.period),
      200,
    )
  },
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
      path: '/:id/recordings',
      middleware: [authMiddleware()],
      request: {
        params: z.object({ id: z.string().min(1).max(200) }),
        query: TrackQuerySchema,
      },
      responses: {
        200: {
          description:
            'Release versions of a recording in the current browse results',
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
        await listTrackRecordingVersions(
          c.req.valid('param').id,
          c.req.valid('query'),
        ),
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
      method: 'get',
      path: '/:id/scrobble-names',
      middleware: [authMiddleware()],
      request: {
        params: z.object({ id: TrackMatchIdSchema }),
        query: TrackScrobbleNamesQuerySchema,
      },
      responses: {
        200: {
          description:
            'Page of imported Last.fm names and their current tracks',
          content: {
            'application/json': {
              schema: createResponseSchema(TrackScrobbleNamesPageSchema),
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
        await listLastfmTrackNames(
          c.req.valid('param').id,
          c.req.valid('query'),
        ),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/:id/scrobble-match',
      middleware: [authMiddleware(), mutationOriginMiddleware()],
      request: {
        params: z.object({ id: TrackMatchIdSchema }),
        body: {
          content: {
            'application/json': { schema: TrackScrobbleMatchInputSchema },
          },
          required: true,
        },
      },
      responses: {
        200: {
          description: 'Matched one Last.fm name to the selected library track',
          content: {
            'application/json': {
              schema: createResponseSchema(TrackMergeResultSchema),
            },
          },
        },
        401: jsonErrorResponse('Unauthorized'),
        403: jsonErrorResponse('Forbidden'),
        404: jsonErrorResponse('Track not found'),
        409: jsonErrorResponse('Last.fm name cannot be matched'),
        422: validationErrorResponse,
      },
    }),
    async (c) =>
      generateJsonResponse(
        c,
        await matchScrobbleTrack(c.req.valid('param').id, c.req.valid('json')),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: 'delete',
      path: '/:id/scrobble-match',
      middleware: [authMiddleware(), mutationOriginMiddleware()],
      request: {
        params: z.object({ id: TrackMatchIdSchema }),
        body: {
          content: {
            'application/json': { schema: TrackScrobbleRemoveInputSchema },
          },
          required: true,
        },
      },
      responses: {
        200: {
          description:
            'Kept a Last.fm name separate or restored automatic matching',
          content: {
            'application/json': {
              schema: createResponseSchema(TrackMergeResultSchema),
            },
          },
        },
        401: jsonErrorResponse('Unauthorized'),
        403: jsonErrorResponse('Forbidden'),
        404: jsonErrorResponse('Track not found'),
        409: jsonErrorResponse('Last.fm match has changed'),
        422: validationErrorResponse,
      },
    }),
    async (c) =>
      generateJsonResponse(
        c,
        await removeScrobbleTrackMatch(
          c.req.valid('param').id,
          c.req.valid('json'),
        ),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/:id/merge',
      middleware: [authMiddleware(), mutationOriginMiddleware()],
      request: {
        params: z.object({ id: TrackMatchIdSchema }),
        body: {
          content: { 'application/json': { schema: TrackMergeInputSchema } },
          required: true,
        },
      },
      responses: {
        200: {
          description:
            'Merged a Last.fm track or its recorded names into the selected track',
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
      method: 'post',
      path: '/:id/tags',
      middleware: [authMiddleware(), mutationOriginMiddleware()],
      request: {
        params: z.object({ id: TrackMatchIdSchema }),
        body: {
          content: { 'application/json': { schema: TrackTagInputSchema } },
          required: true,
        },
      },
      responses: {
        200: {
          description: 'Added a tag to the track, or restored a removed one',
          content: {
            'application/json': {
              schema: createResponseSchema(TrackTagChangeSchema),
            },
          },
        },
        401: jsonErrorResponse('Unauthorized'),
        403: jsonErrorResponse('Forbidden'),
        404: jsonErrorResponse('Track or tag not found'),
        422: validationErrorResponse,
      },
    }),
    async (c) =>
      generateJsonResponse(
        c,
        await addTrackTag(c.req.valid('param').id, c.req.valid('json').tagId),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: 'delete',
      path: '/:id/tags',
      middleware: [authMiddleware(), mutationOriginMiddleware()],
      request: {
        params: z.object({ id: TrackMatchIdSchema }),
        body: {
          content: { 'application/json': { schema: TrackTagInputSchema } },
          required: true,
        },
      },
      responses: {
        200: {
          description:
            'Removed a tag from the track; a Sonovault refresh does not bring it back',
          content: {
            'application/json': {
              schema: createResponseSchema(TrackTagChangeSchema),
            },
          },
        },
        401: jsonErrorResponse('Unauthorized'),
        403: jsonErrorResponse('Forbidden'),
        404: jsonErrorResponse('Track or tag not found'),
        422: validationErrorResponse,
      },
    }),
    async (c) =>
      generateJsonResponse(
        c,
        await removeTrackTag(
          c.req.valid('param').id,
          c.req.valid('json').tagId,
        ),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/:id/tags/reset',
      middleware: [authMiddleware(), mutationOriginMiddleware()],
      request: {
        params: z.object({ id: TrackMatchIdSchema }),
      },
      responses: {
        200: {
          description:
            "Cleared the owner's tag changes on the track, leaving Sonovault's tags",
          content: {
            'application/json': {
              schema: createResponseSchema(TrackTagResetSchema),
            },
          },
        },
        401: jsonErrorResponse('Unauthorized'),
        403: jsonErrorResponse('Forbidden'),
        404: jsonErrorResponse('Track or tag not found'),
        422: validationErrorResponse,
      },
    }),
    async (c) =>
      generateJsonResponse(
        c,
        await resetTrackTags(c.req.valid('param').id),
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
