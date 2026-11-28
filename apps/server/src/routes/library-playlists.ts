import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import type { z } from 'zod'
import {
  CreateLibraryPlaylistSchema,
  LibraryPlaylistAdditionUndoneSchema,
  LibraryPlaylistBatchParamsSchema,
  LibraryPlaylistCreatedSchema,
  LibraryPlaylistDetailSchema,
  LibraryPlaylistEntriesPageSchema,
  LibraryPlaylistEntriesQuerySchema,
  LibraryPlaylistEntryAdditionInputSchema,
  LibraryPlaylistEntryAdditionSchema,
  LibraryPlaylistEntryCheckInputSchema,
  LibraryPlaylistEntryCheckSchema,
  LibraryPlaylistEntryRemovalInputSchema,
  LibraryPlaylistEntryRemovalSchema,
  LibraryPlaylistEntryRestoreInputSchema,
  LibraryPlaylistEntryRestoreSchema,
  LibraryPlaylistListQuerySchema,
  LibraryPlaylistMembershipsQuerySchema,
  LibraryPlaylistMembershipsSchema,
  LibraryPlaylistPageSchema,
  LibraryPlaylistParamsSchema,
  UpdateLibraryPlaylistSchema,
} from '@repo/schemas/library-playlists'
import {
  createOpenAPIApp,
  createResponseSchema,
  jsonErrorResponse,
  type AppEnv,
  validationErrorResponse,
} from '@/lib/openapi'
import { generateJsonResponse } from '@/lib/response'
import {
  authMiddleware,
  mutationOriginMiddleware,
  requireOwnerUser,
} from '@/middlewares/auth'
import {
  addLibraryPlaylistEntries,
  checkLibraryPlaylistEntries,
  createLibraryPlaylist,
  deleteLibraryPlaylist,
  getLibraryPlaylist,
  listLibraryPlaylistEntries,
  listLibraryPlaylistMemberships,
  listLibraryPlaylists,
  removeLibraryPlaylistEntries,
  restoreLibraryPlaylist,
  restoreLibraryPlaylistEntries,
  undoLibraryPlaylistAddition,
  updateLibraryPlaylist,
} from '@/services/library-playlists'

const ok = <T extends z.ZodTypeAny>(description: string, schema: T) => ({
  description,
  content: { 'application/json': { schema: createResponseSchema(schema) } },
})
const jsonBody = <T extends z.ZodTypeAny>(schema: T) => ({
  required: true,
  content: { 'application/json': { schema } },
})
const readErrors = {
  401: jsonErrorResponse('Unauthorized'),
  404: jsonErrorResponse('Playlist not found'),
  422: validationErrorResponse,
}
const writeErrors = {
  ...readErrors,
  403: jsonErrorResponse('Forbidden'),
}
const writeMiddleware = [authMiddleware(), mutationOriginMiddleware()]

/** Mounted at `/library-playlists`. */
const app: OpenAPIHono<AppEnv> = createOpenAPIApp()
  .openapi(
    createRoute({
      method: 'get',
      path: '/',
      middleware: [authMiddleware()],
      request: { query: LibraryPlaylistListQuerySchema },
      responses: {
        200: ok(
          "A page of one library's playlists and smart playlists by name",
          LibraryPlaylistPageSchema,
        ),
        401: jsonErrorResponse('Unauthorized'),
        422: validationErrorResponse,
      },
    }),
    async (c) =>
      generateJsonResponse(
        c,
        await listLibraryPlaylists(c.req.valid('query')),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/',
      middleware: writeMiddleware,
      request: { body: jsonBody(CreateLibraryPlaylistSchema) },
      responses: {
        200: ok(
          'The new playlist and what its selection added',
          LibraryPlaylistCreatedSchema,
        ),
        ...writeErrors,
        409: jsonErrorResponse('A playlist with this name exists.'),
      },
    }),
    async (c) =>
      generateJsonResponse(
        c,
        await createLibraryPlaylist(
          c.req.valid('json'),
          requireOwnerUser(c).id,
        ),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/memberships',
      middleware: [authMiddleware()],
      request: { query: LibraryPlaylistMembershipsQuerySchema },
      responses: {
        200: ok(
          'The playlists that hold the item, with their entry counts',
          LibraryPlaylistMembershipsSchema,
        ),
        401: jsonErrorResponse('Unauthorized'),
        422: validationErrorResponse,
      },
    }),
    async (c) =>
      generateJsonResponse(
        c,
        await listLibraryPlaylistMemberships(c.req.valid('query')),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/:id',
      middleware: [authMiddleware()],
      request: { params: LibraryPlaylistParamsSchema },
      responses: {
        200: ok(
          'The playlist with its entry and repeat counts',
          LibraryPlaylistDetailSchema,
        ),
        ...readErrors,
      },
    }),
    async (c) =>
      generateJsonResponse(
        c,
        await getLibraryPlaylist(c.req.valid('param').id),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: 'patch',
      path: '/:id',
      middleware: writeMiddleware,
      request: {
        params: LibraryPlaylistParamsSchema,
        body: jsonBody(UpdateLibraryPlaylistSchema),
      },
      responses: {
        200: ok(
          'The renamed playlist or its new view',
          LibraryPlaylistDetailSchema,
        ),
        ...writeErrors,
        409: jsonErrorResponse('A playlist with this name exists.'),
      },
    }),
    async (c) =>
      generateJsonResponse(
        c,
        await updateLibraryPlaylist(
          c.req.valid('param').id,
          c.req.valid('json'),
        ),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: 'delete',
      path: '/:id',
      middleware: writeMiddleware,
      request: { params: LibraryPlaylistParamsSchema },
      responses: {
        200: ok(
          'The deleted playlist, restorable for 24 hours',
          LibraryPlaylistDetailSchema,
        ),
        ...writeErrors,
      },
    }),
    async (c) =>
      generateJsonResponse(
        c,
        await deleteLibraryPlaylist(c.req.valid('param').id),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/:id/restore',
      middleware: writeMiddleware,
      request: { params: LibraryPlaylistParamsSchema },
      responses: {
        200: ok('The restored playlist', LibraryPlaylistDetailSchema),
        ...writeErrors,
        409: jsonErrorResponse('A playlist with this name exists.'),
      },
    }),
    async (c) =>
      generateJsonResponse(
        c,
        await restoreLibraryPlaylist(c.req.valid('param').id),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/:id/entries',
      middleware: [authMiddleware()],
      request: {
        params: LibraryPlaylistParamsSchema,
        query: LibraryPlaylistEntriesQuerySchema,
      },
      responses: {
        200: ok(
          "A page of entries in position order with each item's Browse row",
          LibraryPlaylistEntriesPageSchema,
        ),
        ...readErrors,
      },
    }),
    async (c) =>
      generateJsonResponse(
        c,
        await listLibraryPlaylistEntries(
          c.req.valid('param').id,
          c.req.valid('query'),
        ),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/:id/entries/check',
      middleware: writeMiddleware,
      request: {
        params: LibraryPlaylistParamsSchema,
        body: jsonBody(LibraryPlaylistEntryCheckInputSchema),
      },
      responses: {
        200: ok(
          'How many selected items the playlist already holds',
          LibraryPlaylistEntryCheckSchema,
        ),
        ...writeErrors,
      },
    }),
    async (c) =>
      generateJsonResponse(
        c,
        await checkLibraryPlaylistEntries(
          c.req.valid('param').id,
          c.req.valid('json').selection,
        ),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/:id/entries',
      middleware: writeMiddleware,
      request: {
        params: LibraryPlaylistParamsSchema,
        body: jsonBody(LibraryPlaylistEntryAdditionInputSchema),
      },
      responses: {
        200: ok(
          'What the addition added, skipped and repeated',
          LibraryPlaylistEntryAdditionSchema,
        ),
        ...writeErrors,
      },
    }),
    async (c) => {
      const { selection, duplicates } = c.req.valid('json')
      return generateJsonResponse(
        c,
        await addLibraryPlaylistEntries(
          c.req.valid('param').id,
          selection,
          duplicates,
        ),
        200,
      )
    },
  )
  .openapi(
    createRoute({
      method: 'delete',
      path: '/:id/entries/batches/:batchId',
      middleware: writeMiddleware,
      request: { params: LibraryPlaylistBatchParamsSchema },
      responses: {
        200: ok(
          'How many entries the undone addition had added',
          LibraryPlaylistAdditionUndoneSchema,
        ),
        ...writeErrors,
      },
    }),
    async (c) => {
      const { id, batchId } = c.req.valid('param')
      return generateJsonResponse(
        c,
        await undoLibraryPlaylistAddition(id, batchId),
        200,
      )
    },
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/:id/entries/remove',
      middleware: writeMiddleware,
      request: {
        params: LibraryPlaylistParamsSchema,
        body: jsonBody(LibraryPlaylistEntryRemovalInputSchema),
      },
      responses: {
        200: ok(
          'How many entries were removed and the removal to restore',
          LibraryPlaylistEntryRemovalSchema,
        ),
        ...writeErrors,
      },
    }),
    async (c) =>
      generateJsonResponse(
        c,
        await removeLibraryPlaylistEntries(
          c.req.valid('param').id,
          c.req.valid('json'),
        ),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/:id/entries/restore',
      middleware: writeMiddleware,
      request: {
        params: LibraryPlaylistParamsSchema,
        body: jsonBody(LibraryPlaylistEntryRestoreInputSchema),
      },
      responses: {
        200: ok(
          'How many removed entries were put back',
          LibraryPlaylistEntryRestoreSchema,
        ),
        ...writeErrors,
      },
    }),
    async (c) =>
      generateJsonResponse(
        c,
        await restoreLibraryPlaylistEntries(
          c.req.valid('param').id,
          c.req.valid('json').batchId,
        ),
        200,
      ),
  )

export default app
