import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import {
  AlbumMergePlanRequestSchema,
  AlbumMergePlanSchema,
  AlbumMergeRequestSchema,
  AlbumNameMovePlanRequestSchema,
  AlbumNameMoveRequestSchema,
  AlbumSeparateRequestSchema,
} from '@repo/schemas/album-merges'
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
import {
  mergeAlbums,
  moveAlbumName,
  planAlbumMerge,
  planAlbumNameMove,
  separateAlbumEdition,
} from '@/services/album-merges'

const changeResponse = (description: string) => ({
  description,
  content: {
    'application/json': { schema: createResponseSchema(LibraryChangeSchema) },
  },
})
const planResponse = (description: string) => ({
  description,
  content: {
    'application/json': { schema: createResponseSchema(AlbumMergePlanSchema) },
  },
})

/** Mounted at `/library-changes/album-merges`. */
export const albumMerges: OpenAPIHono<AppEnv> = createOpenAPIApp()
  .openapi(
    createRoute({
      method: 'post',
      path: '/plan',
      middleware: [authMiddleware()],
      request: {
        body: {
          required: true,
          content: {
            'application/json': { schema: AlbumMergePlanRequestSchema },
          },
        },
      },
      responses: {
        200: planResponse(
          'What merging the selected albums would change, and any reason to review it first',
        ),
        401: jsonErrorResponse('Unauthorized'),
        404: jsonErrorResponse('Album or album name not found'),
        422: validationErrorResponse,
      },
    }),
    async (c) =>
      generateJsonResponse(c, await planAlbumMerge(c.req.valid('json')), 200),
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/',
      middleware: [authMiddleware(), mutationOriginMiddleware()],
      request: {
        body: {
          required: true,
          content: { 'application/json': { schema: AlbumMergeRequestSchema } },
        },
      },
      responses: {
        200: changeResponse(
          'Merged the selected albums into one record and recorded the change',
        ),
        401: jsonErrorResponse('Unauthorized'),
        403: jsonErrorResponse('Forbidden'),
        404: jsonErrorResponse('Album or album name not found'),
        409: jsonErrorResponse('Albums cannot be merged'),
        422: validationErrorResponse,
      },
    }),
    async (c) =>
      generateJsonResponse(c, await mergeAlbums(c.req.valid('json')), 200),
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/separate',
      middleware: [authMiddleware(), mutationOriginMiddleware()],
      request: {
        body: {
          required: true,
          content: {
            'application/json': { schema: AlbumSeparateRequestSchema },
          },
        },
      },
      responses: {
        200: changeResponse(
          'Gave an edition its own record again and recorded the change',
        ),
        401: jsonErrorResponse('Unauthorized'),
        403: jsonErrorResponse('Forbidden'),
        404: jsonErrorResponse('Album not found'),
        409: jsonErrorResponse('Album is not an edition'),
        422: validationErrorResponse,
      },
    }),
    async (c) =>
      generateJsonResponse(
        c,
        await separateAlbumEdition(c.req.valid('json')),
        200,
      ),
  )

/** Mounted at `/library-changes/album-names`. */
export const albumNames: OpenAPIHono<AppEnv> = createOpenAPIApp()
  .openapi(
    createRoute({
      method: 'post',
      path: '/plan',
      middleware: [authMiddleware()],
      request: {
        body: {
          required: true,
          content: {
            'application/json': { schema: AlbumNameMovePlanRequestSchema },
          },
        },
      },
      responses: {
        200: planResponse(
          'What moving the album name would change, and any reason to review it first',
        ),
        401: jsonErrorResponse('Unauthorized'),
        404: jsonErrorResponse('Album or album name not found'),
        422: validationErrorResponse,
      },
    }),
    async (c) =>
      generateJsonResponse(
        c,
        await planAlbumNameMove(c.req.valid('json')),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/',
      middleware: [authMiddleware(), mutationOriginMiddleware()],
      request: {
        body: {
          required: true,
          content: {
            'application/json': { schema: AlbumNameMoveRequestSchema },
          },
        },
      },
      responses: {
        200: changeResponse(
          'Moved the album name and the track names that follow it, and recorded the change',
        ),
        401: jsonErrorResponse('Unauthorized'),
        403: jsonErrorResponse('Forbidden'),
        404: jsonErrorResponse('Album or album name not found'),
        409: jsonErrorResponse('Album name cannot be moved'),
        422: validationErrorResponse,
      },
    }),
    async (c) =>
      generateJsonResponse(c, await moveAlbumName(c.req.valid('json')), 200),
  )
