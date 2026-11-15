import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import { createMiddleware } from 'hono/factory'
import {
  SpotifyAccountStatusSchema,
  SpotifyAuthorizeInputSchema,
  SpotifyAuthorizeResultSchema,
  SpotifyCallbackSchema,
  SpotifyDisconnectResultSchema,
  SpotifyPlaybackTokenSchema,
  SpotifySavedAlbumsInputSchema,
} from '@repo/schemas/spotify'
import { AlbumImportPreviewSchema } from '@repo/schemas/album-imports'
import { EnrichmentResultSchema } from '@repo/schemas/job'
import {
  SpotifyPlaylistImportInputSchema,
  SpotifyPlaylistImportsSchema,
  SpotifyPlaylistListSchema,
} from '@repo/schemas/tracks'
import { env } from '@/env'
import { ServerError } from '@/lib/error'
import {
  createOpenAPIApp,
  createResponseSchema,
  jsonErrorResponse,
  ownerSessionSecurity,
  validationErrorResponse,
  type AppEnv,
} from '@/lib/openapi'
import { generateJsonResponse } from '@/lib/response'
import {
  authMiddleware,
  requireBrowserSession,
  requireOwnerUser,
} from '@/middlewares/auth'
import {
  authorizeSpotify,
  disconnectSpotify,
  finishSpotifyAuthorization,
  getSpotifyAccountStatus,
  spotifyCallbackDestination,
  spotifyPlaybackToken,
  type SpotifyReturnTo,
} from '@/services/spotify-oauth'
import { previewSpotifyAlbums } from '@/services/spotify-imports'
import {
  getSpotifyPlaylistImports,
  queueSpotifyPlaylistImports,
} from '@/services/spotify-playlists'
import {
  getSpotifyPlaylists,
  queueSpotifyPlaylistListing,
} from '@/services/spotify-playlist-listing'

const browserSession = authMiddleware({ sessionOnly: true })

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

const app: OpenAPIHono<AppEnv> = createOpenAPIApp()
app.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store')
  c.header('Referrer-Policy', 'no-referrer')
  await next()
})
app.openapi(
  createRoute({
    method: 'get',
    path: '/status',
    middleware: [authMiddleware()],
    responses: {
      200: {
        description: 'Local account connection status; no Spotify requests',
        content: {
          'application/json': {
            schema: createResponseSchema(SpotifyAccountStatusSchema),
          },
        },
      },
      401: jsonErrorResponse('Unauthorized'),
    },
  }),
  async (c) =>
    generateJsonResponse(
      c,
      await getSpotifyAccountStatus(requireOwnerUser(c).id),
      200,
    ),
)

app.openapi(
  createRoute({
    method: 'post',
    path: '/authorize',
    security: ownerSessionSecurity,
    middleware: [browserSession, sameOrigin],
    request: {
      body: {
        required: true,
        content: {
          'application/json': { schema: SpotifyAuthorizeInputSchema },
        },
      },
    },
    responses: {
      200: {
        description:
          'Explicit OAuth authorization URL for saved album and playlist access, with optional playback and playlist change access',
        content: {
          'application/json': {
            schema: createResponseSchema(SpotifyAuthorizeResultSchema),
          },
        },
      },
      401: jsonErrorResponse('Owner browser session required'),
      403: jsonErrorResponse('Forbidden'),
      422: validationErrorResponse,
    },
  }),
  async (c) => {
    const { user, session } = requireBrowserSession(c)
    return generateJsonResponse(
      c,
      await authorizeSpotify(
        user.id,
        session.id,
        c.req.header('origin'),
        c.req.valid('json'),
      ),
      200,
    )
  },
)

app.openapi(
  createRoute({
    method: 'post',
    path: '/playback/token',
    security: ownerSessionSecurity,
    middleware: [browserSession, sameOrigin],
    responses: {
      200: {
        description:
          'Short-lived access token for in-app playback; refreshes through the provider request gate',
        content: {
          'application/json': {
            schema: createResponseSchema(SpotifyPlaybackTokenSchema),
          },
        },
      },
      401: jsonErrorResponse('Owner browser session required'),
      403: jsonErrorResponse('Forbidden'),
      422: jsonErrorResponse('Spotify playback is not connected'),
    },
  }),
  async (c) =>
    generateJsonResponse(
      c,
      await spotifyPlaybackToken(requireOwnerUser(c).id),
      200,
    ),
)

app.openapi(
  createRoute({
    method: 'get',
    path: '/callback',
    security: [],
    request: { query: SpotifyCallbackSchema },
    responses: {
      302: { description: 'Relay to the configured authenticated API origin' },
      422: validationErrorResponse,
    },
  }),
  (c) => c.redirect(spotifyCallbackDestination(c.req.valid('query')), 302),
)

app.openapi(
  createRoute({
    method: 'get',
    path: '/complete',
    security: ownerSessionSecurity,
    middleware: [browserSession],
    request: { query: SpotifyCallbackSchema },
    responses: {
      302: {
        description:
          'Return to album, playlist or podcast imports or Providers, without exposing tokens or authorization codes',
      },
      401: jsonErrorResponse('Owner browser session required'),
      403: jsonErrorResponse('Forbidden'),
      422: validationErrorResponse,
    },
  }),
  async (c) => {
    const { user, session } = requireBrowserSession(c)
    let connected = false
    let returnOrigin = env.APP_URL
    let returnTo: SpotifyReturnTo = 'imports'
    try {
      const result = await finishSpotifyAuthorization(
        c.req.valid('query'),
        user.id,
        session.id,
      )
      connected = result.connected
      returnOrigin = result.returnOrigin
      returnTo = result.returnTo
    } catch {
      /* Never expose token responses, codes or state in the redirect. */
    }
    const outcome = connected ? 'connected' : 'error'
    const destination =
      returnTo === 'providers'
        ? new URL('/providers', returnOrigin)
        : new URL(
            returnTo === 'playlists' || returnTo === 'track-playlists'
              ? '/imports/spotify-playlists'
              : returnTo === 'podcasts'
                ? '/imports/spotify-podcasts'
                : '/imports/spotify',
            returnOrigin,
          )
    destination.search = new URLSearchParams(
      returnTo === 'providers'
        ? {
            provider: 'spotify',
            mediaType: 'album',
            section: 'settings',
            spotify: outcome,
          }
        : {
            mediaType:
              returnTo === 'podcasts'
                ? 'subscription'
                : returnTo === 'track-playlists'
                  ? 'track'
                  : 'album',
            spotify: outcome,
          },
    ).toString()
    return c.redirect(destination.toString(), 302)
  },
)

app.openapi(
  createRoute({
    method: 'delete',
    path: '/account',
    security: ownerSessionSecurity,
    middleware: [browserSession, sameOrigin],
    responses: {
      200: {
        description:
          'Delete this user account tokens and pending authorization locally',
        content: {
          'application/json': {
            schema: createResponseSchema(SpotifyDisconnectResultSchema),
          },
        },
      },
      401: jsonErrorResponse('Owner browser session required'),
      403: jsonErrorResponse('Forbidden'),
    },
  }),
  async (c) =>
    generateJsonResponse(
      c,
      await disconnectSpotify(requireOwnerUser(c).id),
      200,
    ),
)

app.openapi(
  createRoute({
    method: 'post',
    path: '/preview',
    middleware: [authMiddleware(), sameOrigin],
    request: {
      body: {
        required: true,
        content: {
          'application/json': { schema: SpotifySavedAlbumsInputSchema },
        },
      },
    },
    responses: {
      200: {
        description:
          'Explicit bounded saved album discovery; no canonical writes or jobs',
        content: {
          'application/json': {
            schema: createResponseSchema(AlbumImportPreviewSchema),
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
      await previewSpotifyAlbums(c.req.valid('json'), requireOwnerUser(c).id),
      200,
    ),
)

app.openapi(
  createRoute({
    method: 'get',
    path: '/playlists',
    middleware: [authMiddleware()],
    responses: {
      200: {
        description:
          'The stored playlist list, when it was listed and the latest listing job; no Spotify requests',
        content: {
          'application/json': {
            schema: createResponseSchema(SpotifyPlaylistListSchema),
          },
        },
      },
      401: jsonErrorResponse('Unauthorized'),
    },
  }),
  async (c) =>
    generateJsonResponse(
      c,
      await getSpotifyPlaylists(requireOwnerUser(c).id),
      200,
    ),
)

app.openapi(
  createRoute({
    method: 'post',
    path: '/playlists',
    middleware: [authMiddleware(), sameOrigin],
    responses: {
      200: {
        description:
          "Queue a job that reads the account's playlists, or keep the one queued or running; returns the stored list with that job",
        content: {
          'application/json': {
            schema: createResponseSchema(SpotifyPlaylistListSchema),
          },
        },
      },
      401: jsonErrorResponse('Unauthorized'),
      422: jsonErrorResponse('Spotify playlist access is not connected'),
      429: jsonErrorResponse('Spotify is cooling down or halted'),
    },
  }),
  async (c) =>
    generateJsonResponse(
      c,
      await queueSpotifyPlaylistListing(requireOwnerUser(c).id),
      200,
    ),
)

app.openapi(
  createRoute({
    method: 'get',
    path: '/playlists/imports',
    middleware: [authMiddleware()],
    responses: {
      200: {
        description:
          'Stored playlist imports and their latest jobs; no Spotify requests',
        content: {
          'application/json': {
            schema: createResponseSchema(SpotifyPlaylistImportsSchema),
          },
        },
      },
      401: jsonErrorResponse('Unauthorized'),
    },
  }),
  async (c) => generateJsonResponse(c, await getSpotifyPlaylistImports(), 200),
)

app.openapi(
  createRoute({
    method: 'post',
    path: '/playlists/import',
    middleware: [authMiddleware(), sameOrigin],
    request: {
      body: {
        required: true,
        content: {
          'application/json': { schema: SpotifyPlaylistImportInputSchema },
        },
      },
    },
    responses: {
      200: {
        description:
          'Queue one import job per chosen playlist, and for Liked Songs',
        content: {
          'application/json': {
            schema: createResponseSchema(EnrichmentResultSchema),
          },
        },
      },
      401: jsonErrorResponse('Unauthorized'),
      422: validationErrorResponse,
      429: jsonErrorResponse('Spotify is cooling down or halted'),
    },
  }),
  async (c) =>
    generateJsonResponse(
      c,
      await queueSpotifyPlaylistImports(
        c.req.valid('json'),
        requireOwnerUser(c).id,
      ),
      200,
    ),
)

app.onError((error, c) =>
  error instanceof ServerError
    ? c.json(error.response, error.response.statusCode)
    : generateJsonResponse(c, null, 500, 'Spotify operation failed'),
)

export default app
