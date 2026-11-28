import { z } from 'zod'

export const API_KEY_MAX_REQUESTS = 1_000_000
export const API_KEY_MAX_WINDOW_SECONDS = 86_400

const UnlimitedApiKeyRateLimitSchema = z.strictObject({
  enabled: z.literal(false),
})
const EnabledApiKeyRateLimitSchema = z.strictObject({
  enabled: z.literal(true),
  maxRequests: z.number().int().positive(),
  windowSeconds: z.number().positive(),
})

export const ApiKeyRateLimitSchema = z.discriminatedUnion('enabled', [
  EnabledApiKeyRateLimitSchema.extend({
    maxRequests:
      EnabledApiKeyRateLimitSchema.shape.maxRequests.max(API_KEY_MAX_REQUESTS),
    windowSeconds: z.number().int().min(1).max(API_KEY_MAX_WINDOW_SECONDS),
  }),
  UnlimitedApiKeyRateLimitSchema,
])
export type ApiKeyRateLimit = z.infer<typeof ApiKeyRateLimitSchema>

export const DEFAULT_API_KEY_RATE_LIMIT = {
  enabled: true,
  maxRequests: 10_000,
  windowSeconds: 3600,
} satisfies ApiKeyRateLimit

/** `device` keys come from device pairing; every other key is `api`. */
export const ApiKeyKindSchema = z.enum(['api', 'device'])
export type ApiKeyKind = z.infer<typeof ApiKeyKindSchema>

export const ApiKeySchema = z.object({
  id: z.string().min(1),
  kind: ApiKeyKindSchema.default('api'),
  name: z.string(),
  start: z.string(),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime().nullable(),
  lastRequest: z.string().datetime().nullable(),
  enabled: z.boolean(),
  rateLimit: z.discriminatedUnion('enabled', [
    EnabledApiKeyRateLimitSchema,
    UnlimitedApiKeyRateLimitSchema,
  ]),
  requestsUsed: z.number().int().nonnegative().nullable(),
})
export type ApiKey = z.infer<typeof ApiKeySchema>

export const ApiKeysSchema = z.array(ApiKeySchema)

export const CreateApiKeySchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    expiresIn: z
      .number()
      .int()
      .min(60)
      .max(365 * 24 * 60 * 60)
      .nullable()
      .default(30 * 24 * 60 * 60),
    rateLimit: ApiKeyRateLimitSchema.optional(),
  })
  .strict()
export type CreateApiKey = z.infer<typeof CreateApiKeySchema>

export const CreatedApiKeySchema = z.object({
  apiKey: ApiKeySchema,
  key: z.string().min(1),
})
export type CreatedApiKey = z.infer<typeof CreatedApiKeySchema>

export const UpdateApiKeyRateLimitSchema = z.strictObject({
  rateLimit: ApiKeyRateLimitSchema,
})
export type UpdateApiKeyRateLimit = z.infer<typeof UpdateApiKeyRateLimitSchema>

export const RevokedApiKeySchema = z.object({ id: z.string().min(1) })
