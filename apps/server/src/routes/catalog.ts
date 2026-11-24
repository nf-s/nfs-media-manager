import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi'
import {
  CatalogNativeKindSchema,
  CatalogObservationPageSchema,
  CatalogObservationQuerySchema,
  TrackAppearancesSchema,
} from '@repo/schemas/catalog'
import { ManualMediaAddResultSchema } from '@repo/schemas/manual-add'
import {
  createOpenAPIApp,
  createResponseSchema,
  jsonErrorResponse,
  validationErrorResponse,
  type AppEnv,
} from '@/lib/openapi'
import { generateJsonResponse } from '@/lib/response'
import { authMiddleware, requireOwnerUser } from '@/middlewares/auth'
import {
  listCatalogObservations,
  promoteCatalogMedia,
  promoteNativeResource,
} from '@/services/catalog-discoveries'
import { listTrackAppearances } from '@/services/track-appearances'

const idParams = z.object({
  id: z.string().min(1).max(500),
})
const params = idParams.extend({
  kind: z.union([z.literal('media'), CatalogNativeKindSchema]),
})
const errors = {
  401: jsonErrorResponse('Unauthorized'),
  422: validationErrorResponse,
}
const catalog: OpenAPIHono<AppEnv> = createOpenAPIApp()

catalog.openapi(
  createRoute({
    method: 'get',
    path: '/{id}/appearances',
    middleware: [authMiddleware()],
    request: { params: idParams },
    responses: {
      ...errors,
      404: jsonErrorResponse('Track not found'),
      200: {
        description: 'Albums, playlists and tracks where this track appeared',
        content: {
          'application/json': {
            schema: createResponseSchema(TrackAppearancesSchema),
          },
        },
      },
    },
  }),
  async (c) =>
    generateJsonResponse(
      c,
      await listTrackAppearances(c.req.valid('param').id),
      200,
    ),
)

catalog.openapi(
  createRoute({
    method: 'post',
    path: '/{kind}/{id}/add',
    middleware: [authMiddleware()],
    request: { params },
    responses: {
      ...errors,
      404: jsonErrorResponse('Media not found'),
      200: {
        description: 'Library membership',
        content: {
          'application/json': {
            schema: createResponseSchema(ManualMediaAddResultSchema),
          },
        },
      },
    },
  }),
  async (c) => {
    const owner = requireOwnerUser(c)
    const { kind, id } = c.req.valid('param')
    return generateJsonResponse(
      c,
      kind === 'media'
        ? await promoteCatalogMedia(id, owner.id)
        : await promoteNativeResource(kind, id, owner.id),
      200,
    )
  },
)

catalog.openapi(
  createRoute({
    method: 'get',
    path: '/{kind}/{id}/discoveries',
    middleware: [authMiddleware()],
    request: { params, query: CatalogObservationQuerySchema },
    responses: {
      ...errors,
      200: {
        description: 'Catalog discoveries',
        content: {
          'application/json': {
            schema: createResponseSchema(CatalogObservationPageSchema),
          },
        },
      },
    },
  }),
  async (c) => {
    const { kind, id } = c.req.valid('param')
    return generateJsonResponse(
      c,
      await listCatalogObservations(
        id,
        c.req.valid('query'),
        kind === 'media' ? undefined : kind,
      ),
      200,
    )
  },
)

export default catalog
