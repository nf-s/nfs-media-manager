import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import {
  AI_AUDIO_MAX_BYTES,
  AiSearchInputSchema,
  AiSearchResponseSchema,
  AiStatusSchema,
  AiSubscriptionSearchResponseSchema,
  AiTranscriptionInputSchema,
  AiTranscriptionSchema,
} from '@repo/schemas/ai-search'
import { authMiddleware } from '@/middlewares/auth'
import {
  createOpenAPIApp,
  createResponseSchema,
  jsonErrorResponse,
  validationErrorResponse,
  type AppEnv,
} from '@/lib/openapi'
import { generateJsonResponse } from '@/lib/response'
import {
  aiSearchStatus,
  interpretAiSearch,
  transcribeAiAudio,
} from '@/services/ai-search'

const app: OpenAPIHono<AppEnv> = createOpenAPIApp()

app.openapi(
  createRoute({
    method: 'get',
    path: '/status',
    middleware: [authMiddleware()],
    responses: {
      200: {
        description: 'AI availability',
        content: {
          'application/json': { schema: createResponseSchema(AiStatusSchema) },
        },
      },
      401: jsonErrorResponse('Unauthorized'),
    },
  }),
  (c) => generateJsonResponse(c, aiSearchStatus(), 200),
)

app.openapi(
  createRoute({
    method: 'post',
    path: '/search',
    middleware: [
      authMiddleware(),
      bodyLimit({
        maxSize: 16 * 1024,
        onError: (c) =>
          generateJsonResponse(c, null, 413, 'Search exceeds the size limit'),
      }),
    ],
    request: {
      body: {
        required: true,
        content: { 'application/json': { schema: AiSearchInputSchema } },
      },
    },
    responses: {
      200: {
        description:
          'Validated search interpretation: a browse plan for album, film and track and a Subscriptions plan for subscription',
        content: {
          'application/json': {
            schema: createResponseSchema(
              z.union([
                AiSearchResponseSchema,
                AiSubscriptionSearchResponseSchema,
              ]),
            ),
          },
        },
      },
      401: jsonErrorResponse('Unauthorized'),
      413: jsonErrorResponse('Search exceeds the size limit'),
      422: validationErrorResponse,
      502: jsonErrorResponse('AI request failed'),
      503: jsonErrorResponse('AI is not configured'),
      504: jsonErrorResponse('AI timed out'),
    },
  }),
  async (c) =>
    generateJsonResponse(c, await interpretAiSearch(c.req.valid('json')), 200),
)

app.openapi(
  createRoute({
    method: 'post',
    path: '/transcribe',
    middleware: [
      authMiddleware(),
      bodyLimit({
        maxSize: 4 * Math.ceil(AI_AUDIO_MAX_BYTES / 3) + 1024,
        onError: (c) =>
          generateJsonResponse(
            c,
            null,
            413,
            'Recording exceeds the size limit',
          ),
      }),
    ],
    request: {
      body: {
        required: true,
        content: { 'application/json': { schema: AiTranscriptionInputSchema } },
      },
    },
    responses: {
      200: {
        description: 'Editable speech transcription',
        content: {
          'application/json': {
            schema: createResponseSchema(AiTranscriptionSchema),
          },
        },
      },
      401: jsonErrorResponse('Unauthorized'),
      413: jsonErrorResponse('Recording exceeds the size limit'),
      422: validationErrorResponse,
      502: jsonErrorResponse('Transcription failed'),
      503: jsonErrorResponse('AI is not configured'),
      504: jsonErrorResponse('AI timed out'),
    },
  }),
  async (c) =>
    generateJsonResponse(c, await transcribeAiAudio(c.req.valid('json')), 200),
)

export default app
