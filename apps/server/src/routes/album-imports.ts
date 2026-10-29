import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import { bodyLimit } from 'hono/body-limit'
import type { Context } from 'hono'
import { z } from 'zod'
import {
  AlbumCsvPreviewInputSchema,
  AlbumImportPreviewSchema,
  ConfirmAlbumImportSchema,
} from '@repo/schemas/album-imports'
import { FileImportFormatSchema, ImportRunSchema } from '@repo/schemas/imports'
import {
  createOpenAPIApp,
  createResponseSchema,
  jsonErrorResponse,
  validationErrorResponse,
  type AppEnv,
} from '@/lib/openapi'
import { ServerError } from '@/lib/error'
import { generateJsonResponse } from '@/lib/response'
import { authMiddleware } from '@/middlewares/auth'
import {
  albumImportFormats,
  confirmAlbumImport,
  prepareAlbumCsv,
} from '@/services/album-imports'

function userId(c: Context<AppEnv>) {
  const user = c.get('user')
  if (!user) throw new ServerError({ statusCode: 401, message: 'Unauthorized' })
  return user.id
}

const app: OpenAPIHono<AppEnv> = createOpenAPIApp()
app.openapi(
  createRoute({
    method: 'get',
    path: '/formats',
    middleware: [authMiddleware()],
    responses: {
      200: {
        description: 'Supported offline album CSV formats',
        content: {
          'application/json': {
            schema: createResponseSchema(z.array(FileImportFormatSchema)),
          },
        },
      },
      401: jsonErrorResponse('Unauthorized'),
    },
  }),
  (c) => generateJsonResponse(c, albumImportFormats, 200),
)

app.openapi(
  createRoute({
    method: 'post',
    path: '/preview',
    middleware: [
      authMiddleware(),
      bodyLimit({
        maxSize: 42 * 1024 * 1024,
        onError: (c) =>
          c.json(
            { statusCode: 413, message: 'Upload exceeds the size limit' },
            413,
          ),
      }),
    ],
    request: {
      body: {
        required: true,
        content: { 'application/json': { schema: AlbumCsvPreviewInputSchema } },
      },
    },
    responses: {
      200: {
        description: 'Offline album preview; no canonical writes or jobs',
        content: {
          'application/json': {
            schema: createResponseSchema(AlbumImportPreviewSchema),
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
      await prepareAlbumCsv(c.req.valid('json'), userId(c)),
      200,
    ),
)

app.openapi(
  createRoute({
    method: 'post',
    path: '/commit',
    middleware: [authMiddleware()],
    request: {
      body: {
        required: true,
        content: { 'application/json': { schema: ConfirmAlbumImportSchema } },
      },
    },
    responses: {
      202: {
        description:
          'Import reviewed new albums; selected providers enrich new albums only',
        content: {
          'application/json': { schema: createResponseSchema(ImportRunSchema) },
        },
      },
      401: jsonErrorResponse('Unauthorized'),
      409: jsonErrorResponse('Import already started'),
      422: validationErrorResponse,
    },
  }),
  async (c) =>
    generateJsonResponse(
      c,
      await confirmAlbumImport(c.req.valid('json'), userId(c)),
      202,
    ),
)

app.onError((error, c) =>
  error instanceof ServerError
    ? c.json(error.response, error.response.statusCode)
    : generateJsonResponse(c, null, 500, 'Album import operation failed'),
)

export default app
