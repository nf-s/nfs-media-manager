import { createRoute } from '@hono/zod-openapi'
import { bodyLimit } from 'hono/body-limit'
import {
  RatingsRankingPageSchema,
  RatingsRankingRequestSchema,
  RatingsSourcesPageSchema,
  RatingsSourcesRequestSchema,
} from '@repo/schemas/ratings-explorer'
import {
  createOpenAPIApp,
  createResponseSchema,
  jsonErrorResponse,
  validationErrorResponse,
} from '@/lib/openapi'
import { generateJsonResponse } from '@/lib/response'
import { authMiddleware } from '@/middlewares/auth'
import {
  rankRatings,
  summarizeRatingsSources,
} from '@/services/ratings-explorer'

const middleware = [
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
]
const errors = {
  401: jsonErrorResponse('Unauthorized'),
  403: jsonErrorResponse('Forbidden'),
  413: jsonErrorResponse('Ratings settings exceed the size limit'),
  422: validationErrorResponse,
}

const app = createOpenAPIApp()
  .openapi(
    createRoute({
      method: 'post',
      path: '/ranking',
      summary: 'Rank stored ratings for the selected film or album library',
      middleware,
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
        ...errors,
      },
    }),
    async (c) =>
      generateJsonResponse(c, await rankRatings(c.req.valid('json')), 200),
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/sources',
      summary: 'Summarize stored rating coverage and distributions',
      middleware,
      request: {
        body: {
          required: true,
          content: {
            'application/json': { schema: RatingsSourcesRequestSchema },
          },
        },
      },
      responses: {
        200: {
          description:
            'Source coverage and histogram counts for the filtered library',
          content: {
            'application/json': {
              schema: createResponseSchema(RatingsSourcesPageSchema),
            },
          },
        },
        ...errors,
      },
    }),
    async (c) =>
      generateJsonResponse(
        c,
        await summarizeRatingsSources(c.req.valid('json')),
        200,
      ),
  )

export default app
