import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import { createMiddleware } from 'hono/factory'
import {
  LastfmAuthorizeInputSchema,
  LastfmAuthorizeResultSchema,
  LastfmCallbackQuerySchema,
  LastfmCallbackStateSchema,
  LastfmDisconnectResultSchema,
  LastfmGroupTracksSchema,
  LastfmLinkQuerySchema,
  LastfmLinkReportSchema,
  LastfmLinkUpdateSchema,
  LastfmSyncInputSchema,
  LastfmSyncSettingsSchema,
  LastfmSyncStatusSchema,
  LastfmSpotifySearchInputSchema,
  LastfmSpotifySearchGroupSchema,
  LastfmSpotifySearchSchema,
  LastfmScrobbleInputSchema,
  LastfmScrobbleResultSchema,
  LastfmScrobblingStatusSchema,
} from '@repo/schemas/lastfm'
import { z } from 'zod'
import { EnrichmentResultSchema } from '@repo/schemas/job'
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
  getLastfmLinkReport,
  getLastfmGroupTracks,
  getLastfmSyncStatus,
  relinkLastfmScrobbles,
  setLastfmAlbumLink,
  setLastfmSyncSchedule,
} from '@/services/lastfm-scrobbles'
import {
  authorizeLastfmScrobbling,
  disconnectLastfmScrobbling,
  finishLastfmScrobbling,
  getLastfmScrobblingStatus,
  scrobbleLastfmPlays,
} from '@/services/lastfm-scrobbling'
import { queueLastfmSync } from '@/services/lastfm-sync-jobs'
import {
  getLastfmSpotifySearch,
  queueLastfmSpotifySearches,
} from '@/services/lastfm-spotify-search'

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

const browserSession = authMiddleware({ sessionOnly: true })

// Scrobbling's sign-in and reports carry account credentials.
const noStore = createMiddleware<AppEnv>(async (c, next) => {
  c.header('Cache-Control', 'no-store')
  c.header('Referrer-Policy', 'no-referrer')
  await next()
})

const statusResponse = (description: string) => ({
  description,
  content: {
    'application/json': {
      schema: createResponseSchema(LastfmSyncStatusSchema),
    },
  },
})
const emptyBody = {
  required: true,
  content: { 'application/json': { schema: LastfmSyncInputSchema } },
}

const app: OpenAPIHono<AppEnv> = createOpenAPIApp()
  .openapi(
    createRoute({
      method: 'get',
      path: '/sync',
      middleware: [authMiddleware()],
      responses: {
        200: statusResponse('Stored scrobble sync status; no Last.fm requests'),
        401: jsonErrorResponse('Unauthorized'),
      },
    }),
    async (c) => generateJsonResponse(c, await getLastfmSyncStatus(), 200),
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/sync',
      middleware: [authMiddleware(), sameOrigin],
      request: { body: emptyBody },
      responses: {
        200: statusResponse(
          'Queue a scrobble sync job, or resume an unfinished run',
        ),
        401: jsonErrorResponse('Unauthorized'),
        422: validationErrorResponse,
        429: jsonErrorResponse('Last.fm is cooling down or halted'),
      },
    }),
    async (c) =>
      generateJsonResponse(
        c,
        await queueLastfmSync(c.get('user')?.id ?? null),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: 'put',
      path: '/sync/settings',
      middleware: [authMiddleware(), sameOrigin],
      request: {
        body: {
          required: true,
          content: { 'application/json': { schema: LastfmSyncSettingsSchema } },
        },
      },
      responses: {
        200: statusResponse('Set how often a sync is queued automatically'),
        401: jsonErrorResponse('Unauthorized'),
        422: validationErrorResponse,
      },
    }),
    async (c) =>
      generateJsonResponse(
        c,
        await setLastfmSyncSchedule(c.req.valid('json').schedule),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/links',
      middleware: [authMiddleware()],
      request: { query: LastfmLinkQuerySchema },
      responses: {
        200: {
          description:
            'Scrobbled artist and album names with the library album each links to, or why it is unlinked',
          content: {
            'application/json': {
              schema: createResponseSchema(LastfmLinkReportSchema),
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
        await getLastfmLinkReport(c.req.valid('query')),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/links/tracks',
      middleware: [authMiddleware()],
      request: { query: LastfmSpotifySearchGroupSchema },
      responses: {
        200: {
          description:
            'Distinct stored track names, identifiers and play counts for one scrobbled album group',
          content: {
            'application/json': {
              schema: createResponseSchema(LastfmGroupTracksSchema),
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
        await getLastfmGroupTracks(c.req.valid('query')),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/links/spotify-search',
      middleware: [authMiddleware()],
      request: { query: LastfmSpotifySearchGroupSchema },
      responses: {
        200: {
          description: 'Stored Spotify album search; no provider requests',
          content: {
            'application/json': {
              schema: createResponseSchema(LastfmSpotifySearchSchema),
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
        await getLastfmSpotifySearch(c.req.valid('query')),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/links/spotify-search',
      middleware: [authMiddleware(), sameOrigin],
      request: {
        body: {
          required: true,
          content: {
            'application/json': { schema: LastfmSpotifySearchInputSchema },
          },
        },
      },
      responses: {
        200: {
          description:
            'Queue one Spotify search job per selected unlinked album',
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
        await queueLastfmSpotifySearches(
          c.req.valid('json'),
          c.get('user')?.id ?? null,
        ),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: 'put',
      path: '/links',
      middleware: [authMiddleware(), sameOrigin],
      request: {
        body: {
          required: true,
          content: { 'application/json': { schema: LastfmLinkUpdateSchema } },
        },
      },
      responses: {
        200: statusResponse(
          'Link one scrobbled artist and album name to an album, keep it unlinked, or return it to automatic matching',
        ),
        401: jsonErrorResponse('Unauthorized'),
        404: jsonErrorResponse('Scrobbled name or album not found'),
        409: jsonErrorResponse('Listening group changed since review'),
        422: validationErrorResponse,
      },
    }),
    async (c) =>
      generateJsonResponse(
        c,
        await setLastfmAlbumLink(
          c.req.valid('json'),
          c.get('user')?.id ?? null,
        ),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/links/refresh',
      middleware: [authMiddleware(), sameOrigin],
      request: { body: emptyBody },
      responses: {
        200: statusResponse(
          'Recompute album links from stored scrobbles; no Last.fm requests',
        ),
        401: jsonErrorResponse('Unauthorized'),
        422: validationErrorResponse,
      },
    }),
    async (c) => generateJsonResponse(c, await relinkLastfmScrobbles(), 200),
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/scrobbling',
      middleware: [noStore, authMiddleware()],
      responses: {
        200: {
          description:
            'Local Last.fm scrobbling sign-in status; no Last.fm requests',
          content: {
            'application/json': {
              schema: createResponseSchema(LastfmScrobblingStatusSchema),
            },
          },
        },
        401: jsonErrorResponse('Unauthorized'),
      },
    }),
    async (c) =>
      generateJsonResponse(
        c,
        await getLastfmScrobblingStatus(requireOwnerUser(c).id),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/scrobbling/authorize',
      security: ownerSessionSecurity,
      middleware: [noStore, browserSession, sameOrigin],
      request: {
        body: {
          required: true,
          content: {
            'application/json': { schema: LastfmAuthorizeInputSchema },
          },
        },
      },
      responses: {
        200: {
          description: 'Last.fm sign-in URL for scrobbling',
          content: {
            'application/json': {
              schema: createResponseSchema(LastfmAuthorizeResultSchema),
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
        await authorizeLastfmScrobbling(
          user.id,
          session.id,
          c.req.header('origin'),
        ),
        200,
      )
    },
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/scrobbling/callback/{state}',
      security: ownerSessionSecurity,
      middleware: [noStore, browserSession],
      request: {
        params: z.object({ state: LastfmCallbackStateSchema }),
        query: LastfmCallbackQuerySchema,
      },
      responses: {
        302: {
          description:
            'Return to the app, where the player reports the result, without exposing tokens or session keys',
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
      try {
        const result = await finishLastfmScrobbling(
          c.req.valid('param').state,
          c.req.valid('query'),
          user.id,
          session.id,
        )
        connected = result.connected
        returnOrigin = result.returnOrigin
      } catch {
        /* Never expose tokens, session keys or Last.fm errors in the redirect. */
      }
      const destination = new URL('/albums', returnOrigin)
      destination.search = new URLSearchParams({
        player: connected ? 'lastfm-connected' : 'lastfm-error',
      }).toString()
      return c.redirect(destination.toString(), 302)
    },
  )
  .openapi(
    createRoute({
      method: 'delete',
      path: '/scrobbling/account',
      security: ownerSessionSecurity,
      middleware: [noStore, browserSession, sameOrigin],
      responses: {
        200: {
          description:
            'Delete this user account Last.fm session, pending sign-in and plays waiting to be scrobbled',
          content: {
            'application/json': {
              schema: createResponseSchema(LastfmDisconnectResultSchema),
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
        await disconnectLastfmScrobbling(requireBrowserSession(c).user.id),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/scrobbles',
      security: ownerSessionSecurity,
      middleware: [noStore, browserSession, sameOrigin],
      request: {
        body: {
          required: true,
          content: {
            'application/json': { schema: LastfmScrobbleInputSchema },
          },
        },
      },
      responses: {
        200: {
          description:
            'Queue qualifying Sonos room plays and submit due plays missing from the connected Last.fm account',
          content: {
            'application/json': {
              schema: createResponseSchema(LastfmScrobbleResultSchema),
            },
          },
        },
        401: jsonErrorResponse('Owner browser session required'),
        403: jsonErrorResponse('Forbidden'),
        422: validationErrorResponse,
      },
    }),
    async (c) =>
      generateJsonResponse(
        c,
        await scrobbleLastfmPlays(
          requireBrowserSession(c).user.id,
          c.req.valid('json'),
        ),
        200,
      ),
  )

app.onError((error, c) =>
  error instanceof ServerError
    ? c.json(error.response, error.response.statusCode)
    : generateJsonResponse(c, null, 500, 'Last.fm sync failed'),
)

export default app
