import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import { createMiddleware } from 'hono/factory'
import type { Context } from 'hono'
import { z } from 'zod'
import { BrowseFacetQuerySchema, BrowseFieldSchema } from '@repo/schemas/browse'
import {
  SubscriptionFilterOptionSchema,
  SubscriptionItemPageSchema,
  SubscriptionItemParamsSchema,
  SubscriptionItemQuerySchema,
  SubscriptionItemSchema,
  SubscriptionSourceListSchema,
  SubscriptionSourceQuerySchema,
  SubscriptionSyncInputSchema,
  SubscriptionSyncParamsSchema,
  SubscriptionSyncSettingsSchema,
  SubscriptionSyncStatusSchema,
  subscriptionBrowseFields,
} from '@repo/schemas/subscriptions'
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
  getSubscriptionItem,
  listSubscriptionFacets,
  listSubscriptionItems,
  listSubscriptionSources,
} from '@/services/subscription-library'
import {
  getSubscriptionSyncStatus,
  queueSubscriptionSync,
  setSubscriptionSyncSchedule,
} from '@/services/subscription-sync'

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

const json = <T extends z.ZodTypeAny>(description: string, schema: T) => ({
  description,
  content: { 'application/json': { schema: createResponseSchema(schema) } },
})

const statusResponse = (description: string) =>
  json(description, SubscriptionSyncStatusSchema)

const app: OpenAPIHono<AppEnv> = createOpenAPIApp()

app.openapi(
  createRoute({
    method: 'get',
    path: '/fields',
    middleware: [authMiddleware()],
    responses: {
      200: json('Browse fields', z.array(BrowseFieldSchema)),
      401: jsonErrorResponse('Unauthorized'),
    },
  }),
  (c) => generateJsonResponse(c, subscriptionBrowseFields, 200),
)

app.openapi(
  createRoute({
    method: 'get',
    path: '/',
    middleware: [authMiddleware()],
    request: { query: SubscriptionItemQuerySchema },
    responses: {
      200: json(
        'Stored videos and podcast episodes from subscribed sources; no provider requests',
        SubscriptionItemPageSchema,
      ),
      401: jsonErrorResponse('Unauthorized'),
      422: validationErrorResponse,
    },
  }),
  async (c) =>
    generateJsonResponse(
      c,
      await listSubscriptionItems(c.req.valid('query')),
      200,
    ),
)

app.openapi(
  createRoute({
    method: 'get',
    path: '/facets',
    middleware: [authMiddleware()],
    request: { query: BrowseFacetQuerySchema },
    responses: {
      200: json(
        'Title, channel, type and tag filters with whole-library counts',
        z.array(SubscriptionFilterOptionSchema),
      ),
      401: jsonErrorResponse('Unauthorized'),
      422: validationErrorResponse,
    },
  }),
  async (c) =>
    generateJsonResponse(
      c,
      await listSubscriptionFacets(c.req.valid('query')),
      200,
    ),
)

app.openapi(
  createRoute({
    method: 'get',
    path: '/sources',
    middleware: [authMiddleware()],
    request: { query: SubscriptionSourceQuerySchema },
    responses: {
      200: json(
        'Subscribed channels and podcasts with their stored item counts',
        SubscriptionSourceListSchema,
      ),
      401: jsonErrorResponse('Unauthorized'),
      422: validationErrorResponse,
    },
  }),
  async (c) =>
    generateJsonResponse(
      c,
      await listSubscriptionSources(c.req.valid('query')),
      200,
    ),
)

app.openapi(
  createRoute({
    method: 'get',
    path: '/sync/:provider',
    middleware: [authMiddleware()],
    request: { params: SubscriptionSyncParamsSchema },
    responses: {
      200: statusResponse(
        'Account connection and stored sync status; no provider requests',
      ),
      401: jsonErrorResponse('Unauthorized'),
      422: validationErrorResponse,
    },
  }),
  async (c) =>
    generateJsonResponse(
      c,
      await getSubscriptionSyncStatus(c.req.valid('param').provider, userId(c)),
      200,
    ),
)

app.openapi(
  createRoute({
    method: 'post',
    path: '/sync/:provider',
    middleware: [authMiddleware(), sameOrigin],
    request: {
      params: SubscriptionSyncParamsSchema,
      body: {
        required: true,
        content: {
          'application/json': { schema: SubscriptionSyncInputSchema },
        },
      },
    },
    responses: {
      200: statusResponse('Queue a sync job, or resume an unfinished run'),
      401: jsonErrorResponse('Unauthorized'),
      422: validationErrorResponse,
      429: jsonErrorResponse('The provider is cooling down or halted'),
    },
  }),
  async (c) =>
    generateJsonResponse(
      c,
      await queueSubscriptionSync(c.req.valid('param').provider, userId(c)),
      200,
    ),
)

app.openapi(
  createRoute({
    method: 'put',
    path: '/sync/:provider/settings',
    middleware: [authMiddleware(), sameOrigin],
    request: {
      params: SubscriptionSyncParamsSchema,
      body: {
        required: true,
        content: {
          'application/json': { schema: SubscriptionSyncSettingsSchema },
        },
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
      await setSubscriptionSyncSchedule(
        c.req.valid('param').provider,
        userId(c),
        c.req.valid('json').schedule,
      ),
      200,
    ),
)

app.openapi(
  createRoute({
    method: 'get',
    path: '/:id',
    middleware: [authMiddleware()],
    request: { params: SubscriptionItemParamsSchema },
    responses: {
      200: json(
        'One stored video or episode of a subscribed source',
        SubscriptionItemSchema,
      ),
      401: jsonErrorResponse('Unauthorized'),
      404: jsonErrorResponse('Item not found'),
      422: validationErrorResponse,
    },
  }),
  async (c) => {
    const item = await getSubscriptionItem(c.req.valid('param').id)
    if (!item)
      throw new ServerError({ statusCode: 404, message: 'Item not found' })
    return generateJsonResponse(c, item, 200)
  },
)

app.onError((error, c) =>
  error instanceof ServerError
    ? c.json(error.response, error.response.statusCode)
    : generateJsonResponse(c, null, 500, 'Subscriptions operation failed'),
)

export default app
