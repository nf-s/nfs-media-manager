import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi'
import {
  ArtistEnrichmentInputSchema,
  ArtistProfileProviderSchema,
  ArtistIdentifierSourcePageSchema,
  ArtistEnrichmentResultSchema,
  QueueArtistSelectionSchema,
} from '@repo/schemas/artist-profiles'
import { PaginationQuerySchema } from '@repo/schemas/common'
import {
  ArtistSelectionSnapshotPageQuerySchema,
  ArtistSelectionSnapshotPageSchema,
  ArtistSelectionSnapshotParamsSchema,
  ArtistSelectionSnapshotSchema,
  CreateArtistSelectionSnapshotSchema,
} from '@repo/schemas/artist-selection'
import {
  SourceSnapshotPageSchema,
  SourceSnapshotSchema,
} from '@repo/schemas/media'
import {
  ArtistAlbumPageSchema,
  ArtistAlbumQuerySchema,
  ArtistDetailSchema,
  ArtistDetailQuerySchema,
  ArtistHistoryPageSchema,
  ArtistHistoryQuerySchema,
  ArtistListeningHistogramQuerySchema,
  ArtistMetadataPageSchema,
  ArtistMetadataItemSchema,
  ArtistSummarySchema,
  ArtistMetadataQuerySchema,
  ArtistPageSchema,
  ArtistPlaylistPageSchema,
  ArtistPlaylistQuerySchema,
  ArtistQuerySchema,
  ArtistTrackPageSchema,
  ArtistTrackQuerySchema,
  CreatorParamsSchema,
  PersonDetailSchema,
  PersonFilmPageSchema,
  PersonFilmQuerySchema,
  PersonPageSchema,
  PersonQuerySchema,
} from '@repo/schemas/creators'
import { artistBrowseFields } from '@repo/schemas/artist-browse'
import {
  BrowseCountSchema,
  BrowseFacetQuerySchema,
  BrowseFieldSchema,
  BrowsePageSliceSchema,
} from '@repo/schemas/browse'
import { FilmFilterOptionSchema } from '@repo/schemas/media'
import { CoverageQuerySchema, CoverageSchema } from '@repo/schemas/coverage'
import { ListeningSeriesSchema } from '@repo/schemas/lastfm'
import { ListeningHistogramSchema } from '@repo/schemas/listening'
import {
  MatchDiagnosticsPageSchema,
  MatchDiagnosticsQuerySchema,
} from '@repo/schemas/match-diagnostics'
import {
  artistBrowseCounts,
  artistListeningHistogram,
  countArtistBrowse,
  listArtistBrowsePage,
  listArtistBrowseFacets,
  listArtistMetadataBrowsePage,
} from '@/services/artist-browse'
import { JobSchema } from '@repo/schemas/job'
import {
  createOpenAPIApp,
  createResponseSchema,
  jsonErrorResponse,
  validationErrorResponse,
  type AppEnv,
} from '@/lib/openapi'
import { generateJsonResponse } from '@/lib/response'
import { authMiddleware, requireOwnerUser } from '@/middlewares/auth'
import { enqueueArtistEnrichment } from '@/services/artist-enrichment'
import { queueArtistSelection } from '@/services/artist-selection'
import {
  createArtistSelectionSnapshot,
  listArtistSelectionSnapshotPage,
} from '@/services/artist-bulk-selection'
import { listArtistIdentifierSources } from '@/services/artist-provider-evidence'
import {
  getArtistSourceSnapshot,
  listArtistSourceSnapshots,
} from '@/services/artist-profiles'
import {
  getArtist,
  getArtistHistory,
  getPerson,
  listArtistAlbums,
  listArtistMetadata,
  listArtistPlaylists,
  listArtists,
  listArtistTracks,
  listPeople,
  listPersonFilms,
} from '@/services/creators'
import { getArtistListeningSeries } from '@/services/listening-series'
import { getArtistCoverage } from '@/services/metadata-coverage'
import { listArtistMatchDiagnostics } from '@/services/artist-match-diagnostics'

const json = <T extends z.ZodTypeAny>(description: string, schema: T) => ({
  description,
  content: { 'application/json': { schema: createResponseSchema(schema) } },
})

const protectedResponses = {
  401: jsonErrorResponse('Unauthorized'),
  422: validationErrorResponse,
}
const artistResponses = {
  ...protectedResponses,
  404: jsonErrorResponse('Artist not found'),
}
const personResponses = {
  ...protectedResponses,
  404: jsonErrorResponse('Person not found'),
}
const ArtistSourceParams = CreatorParamsSchema.extend({
  provider: ArtistProfileProviderSchema,
})

export const artists: OpenAPIHono<AppEnv> = createOpenAPIApp()
  .openapi(
    createRoute({
      method: 'get',
      path: '/match-diagnostics',
      middleware: [authMiddleware()],
      request: { query: MatchDiagnosticsQuerySchema },
      responses: {
        ...protectedResponses,
        200: json(
          'Stored artist identities by provider',
          MatchDiagnosticsPageSchema,
        ),
      },
    }),
    async (c) =>
      generateJsonResponse(
        c,
        await listArtistMatchDiagnostics(c.req.valid('query')),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/fields',
      middleware: [authMiddleware()],
      responses: {
        ...protectedResponses,
        200: json('Artist browse fields', z.array(BrowseFieldSchema)),
      },
    }),
    async (c) => generateJsonResponse(c, artistBrowseFields, 200),
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/facets',
      middleware: [authMiddleware()],
      request: { query: BrowseFacetQuerySchema },
      responses: {
        ...protectedResponses,
        200: json('Artist filter suggestions', z.array(FilmFilterOptionSchema)),
      },
    }),
    async (c) =>
      generateJsonResponse(
        c,
        await listArtistBrowseFacets(c.req.valid('query')),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/browse-page',
      middleware: [authMiddleware()],
      request: { query: ArtistQuerySchema },
      responses: {
        ...protectedResponses,
        200: json(
          'Artist browse page',
          BrowsePageSliceSchema(ArtistSummarySchema),
        ),
      },
    }),
    async (c) =>
      generateJsonResponse(
        c,
        await listArtistBrowsePage(c.req.valid('query')),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/browse-count',
      middleware: [authMiddleware()],
      request: { query: ArtistQuerySchema },
      responses: {
        ...protectedResponses,
        200: json('Filtered artist count', BrowseCountSchema),
      },
    }),
    async (c) =>
      generateJsonResponse(
        c,
        await artistBrowseCounts(c.req.valid('query')),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/listening-histogram',
      middleware: [authMiddleware()],
      request: { query: ArtistListeningHistogramQuerySchema },
      responses: {
        ...protectedResponses,
        200: json(
          'Matching artists by scrobbles in a period, without the listening rules',
          ListeningHistogramSchema,
        ),
      },
    }),
    async (c) =>
      generateJsonResponse(
        c,
        await artistListeningHistogram(c.req.valid('query')),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/metadata/browse-page',
      middleware: [authMiddleware()],
      request: { query: ArtistMetadataQuerySchema },
      responses: {
        ...protectedResponses,
        200: json(
          'Artist metadata browse page',
          BrowsePageSliceSchema(ArtistMetadataItemSchema),
        ),
      },
    }),
    async (c) =>
      generateJsonResponse(
        c,
        await listArtistMetadataBrowsePage(c.req.valid('query')),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/metadata/browse-count',
      middleware: [authMiddleware()],
      request: { query: ArtistMetadataQuerySchema },
      responses: {
        ...protectedResponses,
        200: json('Filtered artist metadata count', BrowseCountSchema),
      },
    }),
    async (c) =>
      generateJsonResponse(
        c,
        await countArtistBrowse(c.req.valid('query')),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/metadata',
      middleware: [authMiddleware()],
      request: { query: ArtistMetadataQuerySchema },
      responses: {
        ...protectedResponses,
        200: json(
          'Artist enrichment status and scrape dates',
          ArtistMetadataPageSchema,
        ),
      },
    }),
    async (c) =>
      generateJsonResponse(
        c,
        await listArtistMetadata(c.req.valid('query')),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/metadata/selections',
      middleware: [authMiddleware()],
      request: {
        body: {
          required: true,
          content: {
            'application/json': { schema: CreateArtistSelectionSnapshotSchema },
          },
        },
      },
      responses: {
        ...protectedResponses,
        200: json('Saved artist selection', ArtistSelectionSnapshotSchema),
      },
    }),
    async (c) =>
      generateJsonResponse(
        c,
        await createArtistSelectionSnapshot(
          c.req.valid('json').query,
          requireOwnerUser(c).id,
        ),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/metadata/selections/:selectionId',
      middleware: [authMiddleware()],
      request: {
        params: ArtistSelectionSnapshotParamsSchema,
        query: ArtistSelectionSnapshotPageQuerySchema,
      },
      responses: {
        ...protectedResponses,
        404: jsonErrorResponse('Artist selection expired or unavailable'),
        200: json('Selected artist IDs', ArtistSelectionSnapshotPageSchema),
      },
    }),
    async (c) =>
      generateJsonResponse(
        c,
        await listArtistSelectionSnapshotPage(
          c.req.valid('param').selectionId,
          c.req.valid('query'),
          requireOwnerUser(c).id,
        ),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/enrichment',
      middleware: [authMiddleware()],
      request: {
        body: {
          required: true,
          content: {
            'application/json': { schema: QueueArtistSelectionSchema },
          },
        },
      },
      responses: {
        ...protectedResponses,
        200: json(
          'Queue selected artist enrichment jobs',
          ArtistEnrichmentResultSchema,
        ),
      },
    }),
    async (c) =>
      generateJsonResponse(
        c,
        await queueArtistSelection(c.req.valid('json'), requireOwnerUser(c).id),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/',
      middleware: [authMiddleware()],
      request: { query: ArtistQuerySchema },
      responses: {
        ...protectedResponses,
        200: json('Library music artists', ArtistPageSchema),
      },
    }),
    async (c) =>
      generateJsonResponse(c, await listArtists(c.req.valid('query')), 200),
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/:id',
      middleware: [authMiddleware()],
      request: { params: CreatorParamsSchema, query: ArtistDetailQuerySchema },
      responses: {
        ...artistResponses,
        200: json('Artist profile and library counts', ArtistDetailSchema),
      },
    }),
    async (c) =>
      generateJsonResponse(
        c,
        await getArtist(c.req.valid('param').id, c.req.valid('query')),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/:id/albums',
      middleware: [authMiddleware()],
      request: { params: CreatorParamsSchema, query: ArtistAlbumQuerySchema },
      responses: {
        ...artistResponses,
        200: json('Albums credited to this artist', ArtistAlbumPageSchema),
      },
    }),
    async (c) =>
      generateJsonResponse(
        c,
        await listArtistAlbums(c.req.valid('param').id, c.req.valid('query')),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/:id/tracks',
      middleware: [authMiddleware()],
      request: { params: CreatorParamsSchema, query: ArtistTrackQuerySchema },
      responses: {
        ...artistResponses,
        200: json('Tracks credited to this artist', ArtistTrackPageSchema),
      },
    }),
    async (c) =>
      generateJsonResponse(
        c,
        await listArtistTracks(c.req.valid('param').id, c.req.valid('query')),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/:id/playlists',
      middleware: [authMiddleware()],
      request: {
        params: CreatorParamsSchema,
        query: ArtistPlaylistQuerySchema,
      },
      responses: {
        ...artistResponses,
        200: json(
          'Playlists containing music credited to this artist',
          ArtistPlaylistPageSchema,
        ),
      },
    }),
    async (c) =>
      generateJsonResponse(
        c,
        await listArtistPlaylists(
          c.req.valid('param').id,
          c.req.valid('query'),
        ),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/:id/listening/series',
      middleware: [authMiddleware()],
      request: { params: CreatorParamsSchema },
      responses: {
        ...artistResponses,
        200: json(
          'Stored scrobbles linked to albums and tracks credited to this artist, by day for five years and by month',
          ListeningSeriesSchema,
        ),
      },
    }),
    async (c) =>
      generateJsonResponse(
        c,
        await getArtistListeningSeries(c.req.valid('param').id),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/:id/coverage',
      middleware: [authMiddleware()],
      request: { params: CreatorParamsSchema, query: CoverageQuerySchema },
      responses: {
        ...artistResponses,
        200: json(
          'Per metadata provider, how many albums credited to this artist are scraped, stale or missing',
          CoverageSchema,
        ),
      },
    }),
    async (c) =>
      generateJsonResponse(
        c,
        await getArtistCoverage(c.req.valid('param').id, c.req.valid('query')),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/:id/history',
      middleware: [authMiddleware()],
      request: { params: CreatorParamsSchema, query: ArtistHistoryQuerySchema },
      responses: {
        ...artistResponses,
        200: json('Saved artist provider results', ArtistHistoryPageSchema),
      },
    }),
    async (c) =>
      generateJsonResponse(
        c,
        await getArtistHistory(c.req.valid('param').id, c.req.valid('query')),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/:id/enrichment',
      middleware: [authMiddleware()],
      request: {
        params: CreatorParamsSchema,
        body: {
          required: true,
          content: {
            'application/json': { schema: ArtistEnrichmentInputSchema },
          },
        },
      },
      responses: {
        ...artistResponses,
        200: json('Queue an artist lookup for one provider', JobSchema),
        409: jsonErrorResponse('Provider configuration or queue conflict'),
        429: jsonErrorResponse('Provider is cooling down or halted'),
      },
    }),
    async (c) =>
      generateJsonResponse(
        c,
        await enqueueArtistEnrichment(
          { artistId: c.req.valid('param').id, ...c.req.valid('json') },
          requireOwnerUser(c).id,
        ),
        200,
      ),
  )

artists.openapi(
  createRoute({
    method: 'get',
    path: '/:id/sources/:provider/identifiers',
    middleware: [authMiddleware()],
    request: { params: ArtistSourceParams, query: PaginationQuerySchema },
    responses: {
      ...artistResponses,
      200: json(
        'Stored evidence for an artist identifier',
        ArtistIdentifierSourcePageSchema,
      ),
    },
  }),
  async (c) => {
    const { id, provider } = c.req.valid('param')
    return generateJsonResponse(
      c,
      await listArtistIdentifierSources(id, provider, c.req.valid('query')),
      200,
    )
  },
)

artists.openapi(
  createRoute({
    method: 'get',
    path: '/:id/sources/:provider/history',
    middleware: [authMiddleware()],
    request: { params: ArtistSourceParams, query: PaginationQuerySchema },
    responses: {
      ...protectedResponses,
      200: json(
        'Stored snapshot summaries for one artist source',
        SourceSnapshotPageSchema,
      ),
    },
  }),
  async (c) => {
    const { id, provider } = c.req.valid('param')
    return generateJsonResponse(
      c,
      await listArtistSourceSnapshots(id, provider, c.req.valid('query')),
      200,
    )
  },
)
artists.openapi(
  createRoute({
    method: 'get',
    path: '/:id/sources/:provider/snapshots/:snapshotId',
    middleware: [authMiddleware()],
    request: {
      params: ArtistSourceParams.extend({
        snapshotId: z.string().min(1).max(500),
      }),
    },
    responses: {
      ...protectedResponses,
      200: json('Stored payload for an artist snapshot', SourceSnapshotSchema),
      404: jsonErrorResponse('Snapshot not found'),
    },
  }),
  async (c) => {
    const { id, provider, snapshotId } = c.req.valid('param')
    return generateJsonResponse(
      c,
      await getArtistSourceSnapshot(id, provider, snapshotId),
      200,
    )
  },
)

export const people: OpenAPIHono<AppEnv> = createOpenAPIApp()
  .openapi(
    createRoute({
      method: 'get',
      path: '/',
      middleware: [authMiddleware()],
      request: { query: PersonQuerySchema },
      responses: {
        ...protectedResponses,
        200: json('Library film directors and actors', PersonPageSchema),
      },
    }),
    async (c) =>
      generateJsonResponse(c, await listPeople(c.req.valid('query')), 200),
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/:id',
      middleware: [authMiddleware()],
      request: { params: CreatorParamsSchema },
      responses: {
        ...personResponses,
        200: json('Person and library film credit counts', PersonDetailSchema),
      },
    }),
    async (c) =>
      generateJsonResponse(c, await getPerson(c.req.valid('param').id), 200),
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/:id/films',
      middleware: [authMiddleware()],
      request: { params: CreatorParamsSchema, query: PersonFilmQuerySchema },
      responses: {
        ...personResponses,
        200: json(
          'Films credited to this person as director or actor',
          PersonFilmPageSchema,
        ),
      },
    }),
    async (c) =>
      generateJsonResponse(
        c,
        await listPersonFilms(c.req.valid('param').id, c.req.valid('query')),
        200,
      ),
  )
