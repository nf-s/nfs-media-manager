import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import {
  MergeTagsResultSchema,
  MergeTagsSchema,
  TagListQuerySchema,
  TagPageSchema,
  TagProvenanceQuerySchema,
  TagProvenancePageSchema,
  TagParamsSchema,
  TagDetailQuerySchema,
  TagDetailSchema,
  SetTagVisibilitySchema,
  SetTagVisibilityResultSchema,
} from '@repo/schemas/tags'
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
  getTagDetail,
  getTagProvenance,
  listTags,
  mergeTags,
  setTagVisibility,
} from '@/services/tags'

const app: OpenAPIHono<AppEnv> = createOpenAPIApp()
  .openapi(
    createRoute({
      method: 'get',
      path: '/provenance',
      middleware: [authMiddleware()],
      request: { query: TagProvenanceQuerySchema },
      responses: {
        200: {
          description:
            'Original and merged tag sources within one media library',
          content: {
            'application/json': {
              schema: createResponseSchema(TagProvenancePageSchema),
            },
          },
        },
        401: jsonErrorResponse('Unauthorized'),
        404: jsonErrorResponse('Tag not found on this item'),
        422: validationErrorResponse,
      },
    }),
    async (c) =>
      generateJsonResponse(
        c,
        await getTagProvenance(c.req.valid('query')),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/',
      middleware: [authMiddleware()],
      request: { query: TagListQuerySchema },
      responses: {
        200: {
          description:
            'Media-scoped canonical tags and provenance (first 20 distinct sources per tag)',
          content: {
            'application/json': { schema: createResponseSchema(TagPageSchema) },
          },
        },
        401: jsonErrorResponse('Unauthorized'),
        422: validationErrorResponse,
      },
    }),
    async (c) =>
      generateJsonResponse(c, await listTags(c.req.valid('query')), 200),
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/merge',
      middleware: [authMiddleware()],
      request: {
        body: {
          required: true,
          content: { 'application/json': { schema: MergeTagsSchema } },
        },
      },
      responses: {
        200: {
          description:
            'Tags merged within one media library; future updates use its target',
          content: {
            'application/json': {
              schema: createResponseSchema(MergeTagsResultSchema),
            },
          },
        },
        401: jsonErrorResponse('Unauthorized'),
        404: jsonErrorResponse('Tag not found'),
        409: jsonErrorResponse('Tag already merged'),
        422: validationErrorResponse,
      },
    }),
    async (c) =>
      generateJsonResponse(
        c,
        await mergeTags(c.req.valid('json'), c.get('user')?.id ?? null),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/visibility',
      middleware: [authMiddleware()],
      request: {
        body: {
          required: true,
          content: { 'application/json': { schema: SetTagVisibilitySchema } },
        },
      },
      responses: {
        200: {
          description:
            'Tag groups hidden or restored without deleting provenance',
          content: {
            'application/json': {
              schema: createResponseSchema(SetTagVisibilityResultSchema),
            },
          },
        },
        401: jsonErrorResponse('Unauthorized'),
        404: jsonErrorResponse('Tag not found'),
        409: jsonErrorResponse('Tag already merged'),
        422: validationErrorResponse,
      },
    }),
    async (c) =>
      generateJsonResponse(c, await setTagVisibility(c.req.valid('json')), 200),
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/{id}',
      middleware: [authMiddleware()],
      request: { params: TagParamsSchema, query: TagDetailQuerySchema },
      responses: {
        200: {
          description:
            'Canonical tag, merge aliases and paginated source detail',
          content: {
            'application/json': {
              schema: createResponseSchema(TagDetailSchema),
            },
          },
        },
        401: jsonErrorResponse('Unauthorized'),
        404: jsonErrorResponse('Tag not found'),
        422: validationErrorResponse,
      },
    }),
    async (c) =>
      generateJsonResponse(
        c,
        await getTagDetail(c.req.valid('param').id, c.req.valid('query')),
        200,
      ),
  )

export default app
