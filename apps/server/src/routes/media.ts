import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import { z } from 'zod'
import { MediaHistorySchema, MediaRescrapeSchema } from '@repo/schemas/media'
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
import { getMediaHistory } from '@/services/history'
import { createRescrapeJob } from '@/services/jobs'

const app: OpenAPIHono<AppEnv> = createOpenAPIApp()
  .openapi(
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
  .openapi(
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
