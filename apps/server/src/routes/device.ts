import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import { createMiddleware } from 'hono/factory'
import { CreatedApiKeySchema } from '@repo/schemas/api-key'
import {
  CreatedDevicePairingSchema,
  DevicePairingExchangeSchema,
} from '@repo/schemas/device-auth'
import { ServerError } from '@/lib/error'
import {
  createOpenAPIApp,
  createResponseSchema,
  jsonErrorResponse,
  ownerSessionSecurity,
  type AppEnv,
  validationErrorResponse,
} from '@/lib/openapi'
import { generateJsonResponse } from '@/lib/response'
import { authMiddleware, requireOwnerUser } from '@/middlewares/auth'
import {
  createDevicePairing,
  exchangeDevicePairing,
  takeDevicePairingAttempt,
} from '@/services/device-pairing'

const exchangeRateLimit = createMiddleware(async (c, next) => {
  const attempt = takeDevicePairingAttempt(c.req.raw.headers)
  if (!attempt.allowed) {
    c.header('Retry-After', String(attempt.retryAfter))
    throw new ServerError({
      statusCode: 429,
      message: 'Too many pairing attempts',
    })
  }
  await next()
})

const device: OpenAPIHono<AppEnv> = createOpenAPIApp()

device.openapi(
  createRoute({
    method: 'post',
    path: '/pairings',
    security: ownerSessionSecurity,
    middleware: [authMiddleware({ sessionOnly: true })],
    responses: {
      201: {
        description:
          'One-time device pairing code. It is only returned here and expires after ten minutes.',
        content: {
          'application/json': {
            schema: createResponseSchema(CreatedDevicePairingSchema),
          },
        },
      },
      401: jsonErrorResponse('Owner browser session required'),
      403: jsonErrorResponse('Forbidden'),
    },
  }),
  async (c) =>
    generateJsonResponse(
      c,
      await createDevicePairing(requireOwnerUser(c).id),
      201,
    ),
)

device.openapi(
  createRoute({
    method: 'post',
    path: '/pairings/exchange',
    security: [],
    middleware: [exchangeRateLimit],
    request: {
      body: {
        required: true,
        content: {
          'application/json': { schema: DevicePairingExchangeSchema },
        },
      },
    },
    responses: {
      201: {
        description:
          'Device API key. The full key is only returned here; the code cannot be used again.',
        content: {
          'application/json': {
            schema: createResponseSchema(CreatedApiKeySchema),
          },
        },
      },
      401: jsonErrorResponse('Pairing code is invalid, used or expired'),
      403: jsonErrorResponse('Forbidden'),
      422: validationErrorResponse,
      429: jsonErrorResponse('Too many pairing attempts'),
    },
  }),
  async (c) =>
    generateJsonResponse(
      c,
      await exchangeDevicePairing(c.req.valid('json')),
      201,
    ),
)

export default device
