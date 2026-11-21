import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import {
  ArtistMergePlanRequestSchema,
  ArtistMergePlanSchema,
  ArtistMergeRequestSchema,
} from '@repo/schemas/artist-merges'
import { LibraryChangeSchema } from '@repo/schemas/library-changes'
import {
  createOpenAPIApp,
  createResponseSchema,
  jsonErrorResponse,
  type AppEnv,
  validationErrorResponse,
} from '@/lib/openapi'
import { generateJsonResponse } from '@/lib/response'
import { authMiddleware, mutationOriginMiddleware } from '@/middlewares/auth'
import { planArtistMerge } from '@/services/artist-merge-plan'
import { mergeArtists } from '@/services/artist-merges'

/** Mounted at `/library-changes/artist-merges`. */
export const artistMerges: OpenAPIHono<AppEnv> = createOpenAPIApp()
  .openapi(
    createRoute({
      method: 'post',
      path: '/plan',
      middleware: [authMiddleware()],
      request: {
        body: {
          required: true,
          content: {
            'application/json': { schema: ArtistMergePlanRequestSchema },
          },
        },
      },
      responses: {
        200: {
          description:
            'What merging the selected artists would move, and any reason to review it first',
          content: {
            'application/json': {
              schema: createResponseSchema(ArtistMergePlanSchema),
            },
          },
        },
        401: jsonErrorResponse('Unauthorized'),
        404: jsonErrorResponse('Artist not found'),
        409: jsonErrorResponse('The artists are already merged'),
        422: validationErrorResponse,
      },
    }),
    async (c) =>
      generateJsonResponse(c, await planArtistMerge(c.req.valid('json')), 200),
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/',
      middleware: [authMiddleware(), mutationOriginMiddleware()],
      request: {
        body: {
          required: true,
          content: { 'application/json': { schema: ArtistMergeRequestSchema } },
        },
      },
      responses: {
        200: {
          description:
            'Merged the selected artists into one and recorded the change',
          content: {
            'application/json': {
              schema: createResponseSchema(LibraryChangeSchema),
            },
          },
        },
        401: jsonErrorResponse('Unauthorized'),
        403: jsonErrorResponse('Forbidden'),
        404: jsonErrorResponse('Artist not found'),
        409: jsonErrorResponse('Artists cannot be merged'),
        422: validationErrorResponse,
      },
    }),
    async (c) =>
      generateJsonResponse(c, await mergeArtists(c.req.valid('json')), 200),
  )
