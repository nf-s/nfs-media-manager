import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi'
import { CatalogObservationPageSchema, CatalogObservationQuerySchema } from '@repo/schemas/catalog'
import { ManualMediaAddResultSchema } from '@repo/schemas/manual-add'
import { createOpenAPIApp, createResponseSchema, jsonErrorResponse, validationErrorResponse, type AppEnv } from '@/lib/openapi'
import { generateJsonResponse } from '@/lib/response'
import { authMiddleware, requireOwnerUser } from '@/middlewares/auth'
import { listCatalogObservations, promoteCatalogMedia } from '@/services/catalog-discoveries'

const params = z.object({ id: z.string().min(1).max(500) })
const errors = { 401: jsonErrorResponse('Unauthorized'), 422: validationErrorResponse }
const catalog: OpenAPIHono<AppEnv> = createOpenAPIApp()

catalog.openapi(createRoute({
  method: 'post', path: '/media/{id}/add', middleware: [authMiddleware()],
  request: { params },
  responses: {
    ...errors,
    404: jsonErrorResponse('Media not found'),
    200: { description: 'Library membership', content: { 'application/json': { schema: createResponseSchema(ManualMediaAddResultSchema) } } },
  },
}), async (c) => generateJsonResponse(c, await promoteCatalogMedia(c.req.valid('param').id, requireOwnerUser(c).id), 200))

catalog.openapi(createRoute({
  method: 'get', path: '/media/{id}/discoveries', middleware: [authMiddleware()],
  request: { params, query: CatalogObservationQuerySchema },
  responses: {
    ...errors,
    200: { description: 'Catalog discoveries', content: { 'application/json': { schema: createResponseSchema(CatalogObservationPageSchema) } } },
  },
}), async (c) => generateJsonResponse(c, await listCatalogObservations(c.req.valid('param').id, c.req.valid('query')), 200))

export default catalog
