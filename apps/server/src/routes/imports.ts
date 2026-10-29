import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import { z } from 'zod'
import { bodyLimit } from 'hono/body-limit'
import {
  ImportRunSchema,
  ImportStatusSchema,
  ImportStatusQuerySchema,
  SavedViewSchema,
  StartImportSchema,
  FileImportSchema,
  FileImportFormatSchema,
  FileImportPreviewSchema,
  FilmPreviewInputSchema,
  FilmImportPreviewSchema,
  ConfirmFilmImportSchema,
  NfoSourceSchema,
} from '@repo/schemas/imports'
import {
  createOpenAPIApp,
  createResponseSchema,
  jsonErrorResponse,
  validationErrorResponse,
  type AppEnv,
} from '@/lib/openapi'
import { generateJsonResponse } from '@/lib/response'
import { authMiddleware } from '@/middlewares/auth'
import {
  getImportStatus,
  listSavedViews,
  startLibraryImport,
} from '@/services/imports'
import {
  listFileImportFormats,
  previewFileImport,
  startFileImport,
} from '@/services/file-imports'
import {
  confirmFilmImport,
  getNfoSource,
  prepareFilmImport,
} from '@/services/film-imports'

const app: OpenAPIHono<AppEnv> = createOpenAPIApp()
  .openapi(
    createRoute({
      method: 'get',
      path: '/nfo-source',
      middleware: [authMiddleware()],
      responses: {
        200: {
          description: 'Server NFO location',
          content: {
            'application/json': {
              schema: createResponseSchema(NfoSourceSchema),
            },
          },
        },
        401: jsonErrorResponse('Unauthorized'),
      },
    }),
    async (c) => generateJsonResponse(c, await getNfoSource(), 200),
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/film-preview',
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
          content: { 'application/json': { schema: FilmPreviewInputSchema } },
        },
      },
      responses: {
        200: {
          description: 'Reviewed film selection; no media writes or scraping',
          content: {
            'application/json': {
              schema: createResponseSchema(FilmImportPreviewSchema),
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
        await prepareFilmImport(c.req.valid('json'), c.get('user')?.id ?? null),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/film-import',
      middleware: [authMiddleware()],
      request: {
        body: {
          required: true,
          content: { 'application/json': { schema: ConfirmFilmImportSchema } },
        },
      },
      responses: {
        202: {
          description: 'Import reviewed films and queue enrichment',
          content: {
            'application/json': {
              schema: createResponseSchema(ImportRunSchema),
            },
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
        await confirmFilmImport(c.req.valid('json'), c.get('user')?.id ?? null),
        202,
      ),
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/formats',
      middleware: [authMiddleware()],
      responses: {
        200: {
          description: 'Local file formats',
          content: {
            'application/json': {
              schema: createResponseSchema(z.array(FileImportFormatSchema)),
            },
          },
        },
        401: jsonErrorResponse('Unauthorized'),
      },
    }),
    async (c) => generateJsonResponse(c, await listFileImportFormats(), 200),
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/preview',
      middleware: [authMiddleware()],
      request: {
        body: {
          required: true,
          content: { 'application/json': { schema: FileImportSchema } },
        },
      },
      responses: {
        200: {
          description: 'Tiny local preview; no network or writes',
          content: {
            'application/json': {
              schema: createResponseSchema(FileImportPreviewSchema),
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
        await previewFileImport(c.req.valid('json')),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/files',
      middleware: [authMiddleware()],
      request: {
        body: {
          required: true,
          content: { 'application/json': { schema: FileImportSchema } },
        },
      },
      responses: {
        202: {
          description: 'File import started',
          content: {
            'application/json': {
              schema: createResponseSchema(ImportRunSchema),
            },
          },
        },
        401: jsonErrorResponse('Unauthorized'),
        409: jsonErrorResponse('Import already running'),
        422: validationErrorResponse,
      },
    }),
    async (c) =>
      generateJsonResponse(
        c,
        await startFileImport(c.req.valid('json'), c.get('user')?.id ?? null),
        202,
      ),
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/',
      middleware: [authMiddleware()],
      request: { query: ImportStatusQuerySchema },
      responses: {
        200: {
          description: 'Local import sources and runs',
          content: {
            'application/json': {
              schema: createResponseSchema(ImportStatusSchema),
            },
          },
        },
        401: jsonErrorResponse('Unauthorized'),
      },
    }),
    async (c) =>
      generateJsonResponse(c, await getImportStatus(c.req.valid('query')), 200),
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/',
      middleware: [authMiddleware()],
      request: {
        body: {
          required: true,
          content: { 'application/json': { schema: StartImportSchema } },
        },
      },
      responses: {
        202: {
          description: 'Local import started',
          content: {
            'application/json': {
              schema: createResponseSchema(ImportRunSchema),
            },
          },
        },
        401: jsonErrorResponse('Unauthorized'),
        409: jsonErrorResponse('Import already running'),
        422: validationErrorResponse,
      },
    }),
    async (c) =>
      generateJsonResponse(
        c,
        await startLibraryImport(
          c.req.valid('json'),
          c.get('user')?.id ?? null,
        ),
        202,
      ),
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/saved-views',
      middleware: [authMiddleware()],
      responses: {
        200: {
          description: 'Imported smart playlists',
          content: {
            'application/json': {
              schema: createResponseSchema(z.array(SavedViewSchema)),
            },
          },
        },
        401: jsonErrorResponse('Unauthorized'),
      },
    }),
    async (c) => generateJsonResponse(c, await listSavedViews(), 200),
  )

export default app
