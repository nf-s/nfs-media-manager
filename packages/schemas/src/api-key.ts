import { z } from 'zod'

export const ApiKeySchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  start: z.string(),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime().nullable(),
  lastRequest: z.string().datetime().nullable(),
  enabled: z.boolean(),
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
  })
  .strict()
export type CreateApiKey = z.infer<typeof CreateApiKeySchema>

export const CreatedApiKeySchema = z.object({
  apiKey: ApiKeySchema,
  key: z.string().min(1),
})
export type CreatedApiKey = z.infer<typeof CreatedApiKeySchema>

export const RevokedApiKeySchema = z.object({ id: z.string().min(1) })
