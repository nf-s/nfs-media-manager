import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import { z } from 'zod'
import { PaginationQuerySchema } from '@repo/schemas/common'
import {
  MediaHistorySchema,
  MediaRescrapeSchema,
  MediaSourcesSchema,
  SourceSnapshotPageSchema,
  SourceSnapshotSchema,
} from '@repo/schemas/media'
import { JobSchema } from '@repo/schemas/job'
import { authMiddleware } from '@/middlewares/auth'
import {
  createOpenAPIApp,
  createResponseSchema,
  jsonErrorResponse,
  type AppEnv,
  validationErrorResponse,
} from '@/lib/openapi'
import { generateJsonResponse } from '@/lib/response'
import {
  getMediaHistory,
  getMediaSources,
  getMediaSourceSnapshot,
  listMediaSourceSnapshots,
} from '@/services/history'
import { createRescrapeJob } from '@/services/jobs'

const MediaParams = z.object({ id: z.string().min(1).max(500) })
const SourceParams = MediaParams.extend({
  provider: z.string().min(1).max(200),
})
const json = <T extends z.ZodTypeAny>(description: string, schema: T) => ({
  description,
  content: { 'application/json': { schema: createResponseSchema(schema) } },
})
const protectedResponses = {
  401: jsonErrorResponse('Unauthorized'),
  422: validationErrorResponse,
}

const app: OpenAPIHono<AppEnv> = createOpenAPIApp()

app.openapi(
  createRoute({
    method: 'get',
    path: '/:id/sources',
    middleware: [authMiddleware()],
    request: { params: MediaParams },
    responses: {
      ...protectedResponses,
      200: json('Media source summaries and overrides', MediaSourcesSchema),
    },
  }),
  async (c) =>
    generateJsonResponse(
      c,
      await getMediaSources(c.req.valid('param').id),
      200,
    ),
)

app.openapi(
  createRoute({
    method: 'get',
    path: '/:id/sources/:provider/history',
    middleware: [authMiddleware()],
    request: { params: SourceParams, query: PaginationQuerySchema },
    responses: {
      ...protectedResponses,
      200: json(
        'Stored snapshot summaries for one media source',
        SourceSnapshotPageSchema,
      ),
    },
  }),
  async (c) => {
    const { id, provider } = c.req.valid('param')
    return generateJsonResponse(
      c,
      await listMediaSourceSnapshots(id, provider, c.req.valid('query')),
      200,
    )
  },
)

app.openapi(
  createRoute({
    method: 'get',
    path: '/:id/sources/:provider/snapshots/:snapshotId',
    middleware: [authMiddleware()],
    request: {
      params: SourceParams.extend({ snapshotId: z.string().min(1).max(500) }),
    },
    responses: {
      ...protectedResponses,
      200: json('Stored payload for a snapshot', SourceSnapshotSchema),
      404: jsonErrorResponse('Snapshot not found'),
    },
  }),
  async (c) => {
    const { id, provider, snapshotId } = c.req.valid('param')
    return generateJsonResponse(
      c,
      await getMediaSourceSnapshot(id, provider, snapshotId),
      200,
    )
  },
)

app.openapi(
  createRoute({
    method: 'get',
    path: '/:id/history',
    middleware: [authMiddleware()],
    request: {
      params: z.object({
        id: z.string().min(1),
      }),
    },
    responses: {
      200: {
        description: 'Media history',
        content: {
          'application/json': {
            schema: createResponseSchema(MediaHistorySchema),
          },
        },
      },
      401: jsonErrorResponse('Unauthorized'),
    },
  }),
  async (c) => {
    const history = await getMediaHistory(c.req.valid('param').id)
    return generateJsonResponse(c, history, 200)
  },
)

app.openapi(
  createRoute({
    method: 'post',
    path: '/:id/rescrape',
    middleware: [authMiddleware()],
    request: {
      params: z.object({
        id: z.string().min(1),
      }),
      body: {
        required: true,
        content: {
          'application/json': {
            schema: MediaRescrapeSchema,
          },
        },
      },
    },
    responses: {
      200: {
        description: 'Rescrape job queued',
        content: {
          'application/json': {
            schema: createResponseSchema(JobSchema),
          },
        },
      },
      401: jsonErrorResponse('Unauthorized'),
      422: validationErrorResponse,
    },
  }),
  async (c) => {
    const job = await createRescrapeJob(
      c.req.valid('param').id,
      c.req.valid('json').provider,
      c.get('user')?.id ?? null,
    )

    return generateJsonResponse(c, job, 200, 'Rescrape job queued')
  },
)

export default app
