import { createRoute } from '@hono/zod-openapi'
import { bodyLimit } from 'hono/body-limit'
import {
  RatingsRankingPageSchema,
  RatingsRankingRequestSchema,
} from '@repo/schemas/ratings-explorer'
import {
  createOpenAPIApp,
  createResponseSchema,
  jsonErrorResponse,
  validationErrorResponse,
} from '@/lib/openapi'
import { generateJsonResponse } from '@/lib/response'
import { authMiddleware } from '@/middlewares/auth'
import { rankRatings } from '@/services/ratings-explorer'

const app = createOpenAPIApp().openapi(
  createRoute({
    method: 'post',
    path: '/ranking',
    summary: 'Rank stored ratings for the selected film or album library',
    middleware: [
      authMiddleware(),
      bodyLimit({
        maxSize: 32 * 1024,
        onError: (c) =>
          generateJsonResponse(
            c,
            null,
            413,
            'Ratings settings exceed the size limit',
          ),
      }),
    ],
    request: {
      body: {
        required: true,
        content: {
          'application/json': { schema: RatingsRankingRequestSchema },
        },
      },
    },
    responses: {
      200: {
        description:
          'Ranked page with source definitions and calculation inputs',
        content: {
          'application/json': {
            schema: createResponseSchema(RatingsRankingPageSchema),
          },
        },
      },
      401: jsonErrorResponse('Unauthorized'),
      403: jsonErrorResponse('Forbidden'),
      413: jsonErrorResponse('Ratings settings exceed the size limit'),
      422: validationErrorResponse,
    },
  }),
  async (c) =>
    generateJsonResponse(c, await rankRatings(c.req.valid('json')), 200),
)

export default app
