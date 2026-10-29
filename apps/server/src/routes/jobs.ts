import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import { z } from 'zod'
import {
  CreateJobSchema,
  BulkRetryJobsSchema,
  BulkRetryJobsResultSchema,
  BulkDismissJobsSchema,
  BulkDismissJobsResultSchema,
  BulkCancelJobsSchema,
  BulkCancelJobsResultSchema,
  JobSchema,
  JobDataSchema,
  JobPageSchema,
  JobListQuerySchema,
  JobActivitySchema,
  EnrichmentResultSchema,
  RefreshFilmsSchema,
  RefreshPreviewSchema,
  StartRefreshSchema,
  RetryJobsSchema,
  ReviewJobErrorSchema,
  DismissJobSchema,
} from '@repo/schemas/job'
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
  createJob,
  getJob,
  listJobs,
  getJobActivity,
  retryJob,
  bulkRetryJobs,
  bulkDismissJobs,
  bulkCancelJobs,
  markJobErrorBenign,
  dismissJob,
} from '@/services/jobs'
import {
  previewFilmRefresh,
  startFilmRefresh,
  retryEnrichmentBatch,
} from '@/services/film-enrichment'
import { ServerError } from '@/lib/error'
import { getJobData } from '@/services/job-data'
import { QueueFilmSelectionSchema } from '@repo/schemas/film-selection'
import { queueFilmSelection } from '@/services/film-selection'
import { QueueAlbumSelectionSchema } from '@repo/schemas/album-selection'
import { queueAlbumSelection } from '@/services/album-selection'

const app: OpenAPIHono<AppEnv> = createOpenAPIApp()

app.openapi(
  createRoute({
    method: 'get',
    path: '/:id/data',
    middleware: [authMiddleware()],
    request: { params: z.object({ id: z.string().min(1) }) },
    responses: {
      200: {
        description:
          'Saved snapshots and failure diagnostics for this exact job',
        content: {
          'application/json': { schema: createResponseSchema(JobDataSchema) },
        },
      },
      401: jsonErrorResponse('Unauthorized'),
      404: jsonErrorResponse('Job not found'),
      422: validationErrorResponse,
    },
  }),
  async (c) =>
    generateJsonResponse(c, await getJobData(c.req.valid('param').id), 200),
)

app.openapi(
  createRoute({
    method: 'post',
    path: '/cancel',
    middleware: [authMiddleware()],
    request: {
      body: {
        required: true,
        content: { 'application/json': { schema: BulkCancelJobsSchema } },
      },
    },
    responses: {
      200: {
        description:
          'Cancel selected queued jobs, or explicitly confirmed running jobs',
        content: {
          'application/json': {
            schema: createResponseSchema(BulkCancelJobsResultSchema),
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
      await bulkCancelJobs(c.req.valid('json'), c.get('user')?.id ?? null),
      200,
    ),
)

app.openapi(
  createRoute({
    method: 'post',
    path: '/albums',
    middleware: [authMiddleware()],
    request: {
      body: {
        required: true,
        content: { 'application/json': { schema: QueueAlbumSelectionSchema } },
      },
    },
    responses: {
      200: {
        description: 'Queue explicitly selected album/provider pairs',
        content: {
          'application/json': {
            schema: createResponseSchema(EnrichmentResultSchema),
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
      await queueAlbumSelection(c.req.valid('json'), c.get('user')?.id ?? null),
      200,
    ),
)

app.openapi(
  createRoute({
    method: 'post',
    path: '/films',
    middleware: [authMiddleware()],
    request: {
      body: {
        required: true,
        content: { 'application/json': { schema: QueueFilmSelectionSchema } },
      },
    },
    responses: {
      200: {
        description: 'Queue explicitly selected film/provider pairs',
        content: {
          'application/json': {
            schema: createResponseSchema(EnrichmentResultSchema),
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
      await queueFilmSelection(c.req.valid('json'), c.get('user')?.id ?? null),
      200,
    ),
)

app.openapi(
  createRoute({
    method: 'post',
    path: '/dismiss',
    middleware: [authMiddleware()],
    request: {
      body: {
        required: true,
        content: { 'application/json': { schema: BulkDismissJobsSchema } },
      },
    },
    responses: {
      200: {
        description:
          'Dismiss selected jobs without changing history or provider safety',
        content: {
          'application/json': {
            schema: createResponseSchema(BulkDismissJobsResultSchema),
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
      await bulkDismissJobs(c.req.valid('json'), c.get('user')?.id ?? null),
      200,
    ),
)

app.openapi(
  createRoute({
    method: 'post',
    path: '/retry',
    middleware: [authMiddleware()],
    request: {
      body: {
        required: true,
        content: { 'application/json': { schema: BulkRetryJobsSchema } },
      },
    },
    responses: {
      200: {
        description: 'Retry selected unfinished jobs with per-job outcomes',
        content: {
          'application/json': {
            schema: createResponseSchema(BulkRetryJobsResultSchema),
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
      await bulkRetryJobs(c.req.valid('json'), c.get('user')?.id ?? null),
      200,
    ),
)

app.openapi(
  createRoute({
    method: 'post',
    path: '/:id/dismiss',
    middleware: [authMiddleware()],
    request: {
      params: z.object({ id: z.string().min(1) }),
      body: {
        required: true,
        content: { 'application/json': { schema: DismissJobSchema } },
      },
    },
    responses: {
      200: {
        description:
          'Dismissed from attention without changing errors or provider safety',
        content: {
          'application/json': { schema: createResponseSchema(JobSchema) },
        },
      },
      401: jsonErrorResponse('Unauthorized'),
      404: jsonErrorResponse('Job not found'),
      409: jsonErrorResponse('Job is not failed or cancelled'),
      422: validationErrorResponse,
    },
  }),
  async (c) =>
    generateJsonResponse(
      c,
      await dismissJob(c.req.valid('param').id, c.get('user')?.id ?? null),
      200,
    ),
)

app.openapi(
  createRoute({
    method: 'post',
    path: '/:id/logs/:logId/benign',
    middleware: [authMiddleware()],
    request: {
      params: z.object({ id: z.string().min(1), logId: z.string().min(1) }),
      body: {
        required: true,
        content: { 'application/json': { schema: ReviewJobErrorSchema } },
      },
    },
    responses: {
      200: {
        description:
          'Error reviewed without retrying or changing provider limits',
        content: {
          'application/json': { schema: createResponseSchema(JobSchema) },
        },
      },
      401: jsonErrorResponse('Unauthorized'),
      404: jsonErrorResponse('Job or log not found'),
      409: jsonErrorResponse('Job is not finished'),
      422: validationErrorResponse,
    },
  }),
  async (c) =>
    generateJsonResponse(
      c,
      await markJobErrorBenign(
        c.req.valid('param').id,
        c.req.valid('param').logId,
        c.get('user')?.id ?? null,
      ),
      200,
    ),
)

app.openapi(
  createRoute({
    method: 'get',
    path: '/activity',
    middleware: [authMiddleware()],
    responses: {
      200: {
        description: 'Compact queue activity',
        content: {
          'application/json': {
            schema: createResponseSchema(JobActivitySchema),
          },
        },
      },
      401: jsonErrorResponse('Unauthorized'),
    },
  }),
  async (c) => generateJsonResponse(c, await getJobActivity(), 200),
)
app.openapi(
  createRoute({
    method: 'post',
    path: '/refresh/preview',
    middleware: [authMiddleware()],
    request: {
      body: {
        required: true,
        content: { 'application/json': { schema: RefreshFilmsSchema } },
      },
    },
    responses: {
      200: {
        description: 'Oldest provider metadata first',
        content: {
          'application/json': {
            schema: createResponseSchema(RefreshPreviewSchema),
          },
        },
      },
      401: jsonErrorResponse('Unauthorized'),
      422: validationErrorResponse,
    },
  }),
  async (c) =>
    generateJsonResponse(c, await previewFilmRefresh(c.req.valid('json')), 200),
)
app.openapi(
  createRoute({
    method: 'post',
    path: '/refresh',
    middleware: [authMiddleware()],
    request: {
      body: {
        required: true,
        content: { 'application/json': { schema: StartRefreshSchema } },
      },
    },
    responses: {
      200: {
        description: 'Refresh selected stale films',
        content: {
          'application/json': {
            schema: createResponseSchema(EnrichmentResultSchema),
          },
        },
      },
      401: jsonErrorResponse('Unauthorized'),
      409: jsonErrorResponse('Selection already refreshed'),
      422: validationErrorResponse,
    },
  }),
  async (c) =>
    generateJsonResponse(
      c,
      await startFilmRefresh(c.req.valid('json'), c.get('user')?.id ?? null),
      200,
    ),
)
app.openapi(
  createRoute({
    method: 'post',
    path: '/batches/:id/retry',
    middleware: [authMiddleware()],
    request: {
      params: z.object({ id: z.string().min(1) }),
      body: {
        required: true,
        content: { 'application/json': { schema: RetryJobsSchema } },
      },
    },
    responses: {
      200: {
        description: 'Retry only unfinished batch items',
        content: {
          'application/json': {
            schema: createResponseSchema(EnrichmentResultSchema),
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
      await retryEnrichmentBatch(
        c.req.valid('param').id,
        c.get('user')?.id ?? null,
        c.req.valid('json').confirmBroadRun,
      ),
      200,
    ),
)
app.openapi(
  createRoute({
    method: 'post',
    path: '/:id/retry',
    middleware: [authMiddleware()],
    request: {
      params: z.object({ id: z.string().min(1) }),
      body: {
        required: true,
        content: { 'application/json': { schema: RetryJobsSchema } },
      },
    },
    responses: {
      200: {
        description: 'Retry only unfinished job items',
        content: {
          'application/json': { schema: createResponseSchema(JobSchema) },
        },
      },
      401: jsonErrorResponse('Unauthorized'),
      409: jsonErrorResponse('No unfinished work'),
      422: validationErrorResponse,
    },
  }),
  async (c) =>
    generateJsonResponse(
      c,
      await retryJob(
        c.req.valid('param').id,
        c.get('user')?.id ?? null,
        c.req.valid('json').confirmBroadRun,
      ),
      200,
    ),
)
app.openapi(
  createRoute({
    method: 'get',
    path: '/',
    middleware: [authMiddleware()],
    request: { query: JobListQuerySchema },
    responses: {
      200: {
        description: 'Scrape jobs',
        content: {
          'application/json': {
            schema: createResponseSchema(JobPageSchema),
          },
        },
      },
      401: jsonErrorResponse('Unauthorized'),
    },
  }),
  async (c) => {
    return generateJsonResponse(c, await listJobs(c.req.valid('query')), 200)
  },
)
app.openapi(
  createRoute({
    method: 'post',
    path: '/',
    middleware: [authMiddleware()],
    request: {
      body: {
        required: true,
        content: {
          'application/json': {
            schema: CreateJobSchema,
          },
        },
      },
    },
    responses: {
      200: {
        description: 'Scrape job created',
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
    const job = await createJob(c.req.valid('json'), c.get('user')?.id ?? null)
    return generateJsonResponse(c, job, 200, 'Scrape job queued')
  },
)
app.openapi(
  createRoute({
    method: 'get',
    path: '/:id',
    middleware: [authMiddleware()],
    request: {
      params: z.object({
        id: z.string().min(1),
      }),
    },
    responses: {
      200: {
        description: 'Scrape job detail',
        content: {
          'application/json': {
            schema: createResponseSchema(JobSchema),
          },
        },
      },
      401: jsonErrorResponse('Unauthorized'),
      404: jsonErrorResponse('Job not found'),
    },
  }),
  async (c) => {
    const job = await getJob(c.req.valid('param').id)

    if (!job) {
      throw new ServerError({
        statusCode: 404,
        message: 'Job not found',
      })
    }

    return generateJsonResponse(c, job, 200)
  },
)

export default app
