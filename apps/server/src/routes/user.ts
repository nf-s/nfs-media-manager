import { createRoute, z } from '@hono/zod-openapi'
import {
  ApiKeySchema,
  ApiKeysSchema,
  CreateApiKeySchema,
  CreatedApiKeySchema,
  RevokedApiKeySchema,
  UpdateApiKeyRateLimitSchema,
} from '@repo/schemas/api-key'
import {
  createOpenAPIApp,
  createResponseSchema,
  jsonErrorResponse,
  ownerSessionSecurity,
  validationErrorResponse,
} from '@/lib/openapi'
import { generateJsonResponse } from '@/lib/response'
import { authMiddleware, requireOwnerUser } from '@/middlewares/auth'
import {
  createAgentAccess,
  createApiKey,
  listApiKeys,
  revokeApiKey,
  updateApiKeyRateLimit,
} from '@/services/api-keys'

const browserSession = authMiddleware({ sessionOnly: true })
const authErrors = {
  401: jsonErrorResponse('Owner browser session required'),
  403: jsonErrorResponse('Forbidden'),
}
const createdResponse = {
  description: 'Created API key. The full key is only returned on creation.',
  content: {
    'application/json': { schema: createResponseSchema(CreatedApiKeySchema) },
  },
}

const app = createOpenAPIApp()
  .openapi(
    createRoute({
      method: 'get',
      path: '/api-keys',
      security: ownerSessionSecurity,
      middleware: [browserSession],
      responses: {
        200: {
          description: 'API key metadata',
          content: {
            'application/json': { schema: createResponseSchema(ApiKeysSchema) },
          },
        },
        ...authErrors,
      },
    }),
    async (c) =>
      generateJsonResponse(c, await listApiKeys(requireOwnerUser(c).id), 200),
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/api-keys',
      security: ownerSessionSecurity,
      middleware: [browserSession],
      request: {
        body: {
          required: true,
          content: { 'application/json': { schema: CreateApiKeySchema } },
        },
      },
      responses: {
        201: createdResponse,
        ...authErrors,
        422: validationErrorResponse,
      },
    }),
    async (c) =>
      generateJsonResponse(
        c,
        await createApiKey(requireOwnerUser(c).id, c.req.valid('json')),
        201,
      ),
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/agent-access',
      security: ownerSessionSecurity,
      middleware: [browserSession],
      responses: {
        201: {
          ...createdResponse,
          description: 'Created API key that expires after one hour.',
        },
        ...authErrors,
      },
    }),
    async (c) =>
      generateJsonResponse(
        c,
        await createAgentAccess(requireOwnerUser(c).id),
        201,
      ),
  )
  .openapi(
    createRoute({
      method: 'patch',
      path: '/api-keys/{id}',
      security: ownerSessionSecurity,
      middleware: [browserSession],
      request: {
        params: z.object({ id: z.string().min(1) }),
        body: {
          required: true,
          content: {
            'application/json': { schema: UpdateApiKeyRateLimitSchema },
          },
        },
      },
      responses: {
        200: {
          description: 'API key rate limit updated',
          content: {
            'application/json': { schema: createResponseSchema(ApiKeySchema) },
          },
        },
        ...authErrors,
        404: jsonErrorResponse('API key not found'),
        422: validationErrorResponse,
      },
    }),
    async (c) =>
      generateJsonResponse(
        c,
        await updateApiKeyRateLimit(
          requireOwnerUser(c).id,
          c.req.valid('param').id,
          c.req.valid('json'),
        ),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: 'delete',
      path: '/api-keys/{id}',
      security: ownerSessionSecurity,
      middleware: [browserSession],
      request: { params: z.object({ id: z.string().min(1) }) },
      responses: {
        200: {
          description: 'Revoked API key',
          content: {
            'application/json': {
              schema: createResponseSchema(RevokedApiKeySchema),
            },
          },
        },
        ...authErrors,
        404: jsonErrorResponse('API key not found'),
      },
    }),
    async (c) =>
      generateJsonResponse(
        c,
        await revokeApiKey(requireOwnerUser(c).id, c.req.valid('param').id),
        200,
      ),
  )

export default app
