import { createRoute } from '@hono/zod-openapi'
import { bodyLimit } from 'hono/body-limit'
import { BrowserBrowseTimingSchema } from '@repo/schemas/performance'
import {
  createOpenAPIApp,
  jsonErrorResponse,
  ownerSessionSecurity,
  validationErrorResponse,
} from '@/lib/openapi'
import { writeRequestLog } from '@/lib/request-log'
import { generateJsonResponse } from '@/lib/response'
import { authMiddleware } from '@/middlewares/auth'

const app = createOpenAPIApp().openapi(
  createRoute({
    method: 'post',
    path: '/browse',
    security: ownerSessionSecurity,
    middleware: [
      authMiddleware({ sessionOnly: true }),
      bodyLimit({
        maxSize: 1024,
        onError: (c) =>
          generateJsonResponse(
            c,
            null,
            413,
            'Timing report exceeds the size limit',
          ),
      }),
    ],
    request: {
      body: {
        required: true,
        content: { 'application/json': { schema: BrowserBrowseTimingSchema } },
      },
    },
    responses: {
      204: { description: 'Browser timing recorded' },
      401: jsonErrorResponse('Owner browser session required'),
      403: jsonErrorResponse('Forbidden'),
      413: jsonErrorResponse('Timing report exceeds the size limit'),
      422: validationErrorResponse,
    },
  }),
  (c) => {
    writeRequestLog({ event: 'browser.browse', ...c.req.valid('json') })
    return c.body(null, 204)
  },
)

export default app
