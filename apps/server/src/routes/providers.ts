import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import { z } from 'zod'
import {
  ProviderSecretUpdateSchema,
  ProviderSecretsSchema,
  ProviderSummarySchema,
  ProviderActivityQuerySchema,
  ProviderActivitySchema,
  ClearProviderCooldownSchema,
  ProviderSafetySchema,
  ProviderRequestBudgetSchema,
  ProviderBudgetStatusSchema,
} from '@repo/schemas/provider'
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
  getProviderSecrets,
  listProviders,
  testProviderSecrets,
  updateProviderSecrets,
  updateProviderBudget,
} from '@/services/providers'
import {
  getProviderActivity,
  clearProviderCooldown,
} from '@/services/provider-activity'

const app: OpenAPIHono<AppEnv> = createOpenAPIApp()
  .openapi(
    createRoute({
      method: 'get',
      path: '/',
      middleware: [authMiddleware()],
      responses: {
        200: {
          description: 'Provider list',
          content: {
            'application/json': {
              schema: createResponseSchema(z.array(ProviderSummarySchema)),
            },
          },
        },
        401: jsonErrorResponse('Unauthorized'),
      },
    }),
    async (c) => {
      return generateJsonResponse(c, await listProviders(), 200)
    },
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/:provider/secrets',
      middleware: [authMiddleware()],
      request: {
        params: z.object({
          provider: z.string().min(1),
        }),
      },
      responses: {
        200: {
          description: 'Provider secrets',
          content: {
            'application/json': {
              schema: createResponseSchema(ProviderSecretsSchema),
            },
          },
        },
        401: jsonErrorResponse('Unauthorized'),
        404: jsonErrorResponse('Provider not found'),
      },
    }),
    async (c) => {
      return generateJsonResponse(
        c,
        await getProviderSecrets(c.req.valid('param').provider),
        200,
      )
    },
  )
  .openapi(
    createRoute({
      method: 'patch',
      path: '/:provider/secrets',
      middleware: [authMiddleware()],
      request: {
        params: z.object({
          provider: z.string().min(1),
        }),
        body: {
          required: true,
          content: {
            'application/json': {
              schema: ProviderSecretUpdateSchema,
            },
          },
        },
      },
      responses: {
        200: {
          description: 'Provider secrets updated',
          content: {
            'application/json': {
              schema: createResponseSchema(ProviderSecretsSchema),
            },
          },
        },
        401: jsonErrorResponse('Unauthorized'),
        404: jsonErrorResponse('Provider not found'),
        422: validationErrorResponse,
      },
    }),
    async (c) => {
      const updated = await updateProviderSecrets(
        c.req.valid('param').provider,
        c.req.valid('json').values,
        c.get('user')?.id ?? null,
      )

      return generateJsonResponse(c, updated, 200, 'Provider secrets updated')
    },
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/:provider/test',
      middleware: [authMiddleware()],
      request: {
        params: z.object({
          provider: z.string().min(1),
        }),
      },
      responses: {
        200: {
          description: 'Provider test result',
          content: {
            'application/json': {
              schema: createResponseSchema(ProviderSecretsSchema),
            },
          },
        },
        401: jsonErrorResponse('Unauthorized'),
        404: jsonErrorResponse('Provider not found'),
      },
    }),
    async (c) => {
      const result = await testProviderSecrets(c.req.valid('param').provider)
      return generateJsonResponse(c, result, 200, 'Provider test completed')
    },
  )

app.openapi(
  createRoute({
    method: 'get',
    path: '/:provider/activity',
    middleware: [authMiddleware()],
    request: {
      params: z.object({ provider: z.string().min(1) }),
      query: ProviderActivityQuerySchema,
    },
    responses: {
      200: {
        description: 'Provider request history and reviews',
        content: {
          'application/json': {
            schema: createResponseSchema(ProviderActivitySchema),
          },
        },
      },
      401: jsonErrorResponse('Unauthorized'),
      404: jsonErrorResponse('Provider not found'),
      422: validationErrorResponse,
    },
  }),
  async (c) =>
    generateJsonResponse(
      c,
      await getProviderActivity(
        c.req.valid('param').provider,
        c.req.valid('query').range,
      ),
      200,
    ),
)

app.openapi(
  createRoute({
    method: 'post',
    path: '/:provider/cooldown/clear',
    middleware: [authMiddleware()],
    request: {
      params: z.object({ provider: z.string().min(1) }),
      body: {
        required: true,
        content: {
          'application/json': { schema: ClearProviderCooldownSchema },
        },
      },
    },
    responses: {
      200: {
        description: 'Cooldown cleared; request limits remain enforced',
        content: {
          'application/json': {
            schema: createResponseSchema(ProviderSafetySchema),
          },
        },
      },
      401: jsonErrorResponse('Unauthorized'),
      404: jsonErrorResponse('Provider not found'),
      409: jsonErrorResponse('Provider state changed'),
      422: validationErrorResponse,
    },
  }),
  async (c) =>
    generateJsonResponse(
      c,
      await clearProviderCooldown(
        c.req.valid('param').provider,
        c.req.valid('json').expectedCooldownUntil,
        c.get('user')?.id ?? null,
      ),
      200,
    ),
)

app.openapi(
  createRoute({
    method: 'patch',
    path: '/:provider/budget',
    middleware: [authMiddleware()],
    request: {
      params: z.object({ provider: z.string().min(1) }),
      body: {
        required: true,
        content: {
          'application/json': { schema: ProviderRequestBudgetSchema },
        },
      },
    },
    responses: {
      200: {
        description: 'Request budget updated',
        content: {
          'application/json': {
            schema: createResponseSchema(ProviderBudgetStatusSchema),
          },
        },
      },
      401: jsonErrorResponse('Unauthorized'),
      404: jsonErrorResponse('Provider not found'),
      422: validationErrorResponse,
    },
  }),
  async (c) =>
    generateJsonResponse(
      c,
      await updateProviderBudget(
        c.req.valid('param').provider,
        c.req.valid('json'),
        c.get('user')?.id ?? null,
      ),
      200,
    ),
)

export default app
