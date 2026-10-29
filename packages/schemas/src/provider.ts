import { z } from 'zod'

export const ProviderConnectionStatusSchema = z.enum(['connected', 'error'])

export const ProviderRequestBudgetSchema = z.object({
  period: z.enum(['hour', 'day']),
  limit: z.number().int().positive().max(100000),
})
export type ProviderRequestBudget = z.infer<typeof ProviderRequestBudgetSchema>

export const ProviderBudgetStatusSchema = z.object({
  budget: ProviderRequestBudgetSchema,
  used: z.number().int().nonnegative(),
  resetsAt: z.string().datetime(),
})

export const ProviderConnectionSchema = z.object({
  provider: z.string(),
  status: ProviderConnectionStatusSchema,
  accountId: z.string().nullable(),
  accountLabel: z.string().nullable(),
  connectedAt: z.string().nullable(),
  lastSyncedAt: z.string().nullable(),
  tokenExpiresAt: z.string().nullable(),
})

export const ProviderSecretFieldSchema = z.object({
  key: z.string(),
  label: z.string(),
  required: z.boolean(),
  configured: z.boolean(),
  helpText: z.string().nullable(),
  placeholder: z.string().nullable(),
})

export const ProviderSafetySchema = z.object({
  halted: z.boolean(),
  cooldownUntil: z.string().nullable(),
  consecutiveFailures: z.number(),
  requestsLastHour: z.number(),
  lastError: z.string().nullable(),
})

export const ProviderActivityQuerySchema = z.object({
  range: z.enum(['1h', '24h', '7d']).default('24h'),
})
export const ProviderActivitySchema = z.object({
  provider: z.string(),
  from: z.string(),
  to: z.string(),
  bucketMs: z.number(),
  recordedSince: z.string().nullable(),
  total: z.number().int().nonnegative(),
  buckets: z.array(
    z.object({ start: z.string(), count: z.number().int().nonnegative() }),
  ),
  benignReviews: z.array(
    z.object({
      jobId: z.string(),
      message: z.string(),
      reviewedAt: z.string(),
    }),
  ),
  cooldownResets: z.array(
    z.object({ clearedAt: z.string(), previousCooldownUntil: z.string() }),
  ),
})
export const ClearProviderCooldownSchema = z.object({
  confirm: z.literal(true),
  expectedCooldownUntil: z.string().datetime(),
})

export const ProviderSummarySchema = z.object({
  id: z.string(),
  displayName: z.string(),
  description: z.string(),
  surface: z.enum(['provider', 'import']),
  mediaTypes: z.array(z.enum(['album', 'film'])),
  rateLimit: z.object({
    maxConcurrent: z.number().int().positive(),
    concurrentRequests: z.boolean().optional(),
    fixedWindow: z
      .object({
        durationMs: z.number().int().positive(),
        reads: z.number().int().positive(),
        writes: z.number().int().positive(),
      })
      .optional(),
    minTimeMs: z.number().int().nonnegative(),
    maxRequestsPerHour: z.number().int().positive().optional(),
    requestBudget: ProviderRequestBudgetSchema.optional(),
    configurableRequestBudget: z.boolean().optional(),
    respectRateLimitHeaders: z.boolean().optional(),
    retryAfterIsAuthoritative: z.boolean().optional(),
    rateLimitCooldownMs: z.number().int().positive().optional(),
    errorBackoffMs: z.number().int().nonnegative().optional(),
    failureCooldownMs: z.number().int().nonnegative().optional(),
  }),
  supportsScrape: z.boolean(),
  maxItemsPerJob: z.number().int().positive().optional(),
  requireExplicitSelection: z.boolean().optional(),
  identifierTypes: z.array(z.string()).default([]),
  supportsNameLookup: z.boolean().default(false),
  supportsSync: z.boolean(),
  supportsLegacyImport: z.boolean(),
  connection: ProviderConnectionSchema.nullable(),
  secrets: z.array(ProviderSecretFieldSchema),
  pluginPath: z.string().nullable(),
  reviewableErrors: z
    .array(z.object({ name: z.string(), message: z.string() }))
    .default([]),
  fileImports: z
    .array(
      z.object({
        id: z.string(),
        label: z.string(),
        requiredColumns: z.array(z.string()),
      }),
    )
    .default([]),
  browseFields: z
    .array(
      z.object({
        key: z.string(),
        label: z.string(),
        type: z.string(),
        format: z.string().optional(),
        filterable: z.boolean(),
      }),
    )
    .default([]),
  supportsTestConnection: z.boolean().default(false),
  credentialEnvironment: z
    .array(z.object({ key: z.string(), envVars: z.array(z.string()) }))
    .default([]),
  safety: ProviderSafetySchema.optional(),
  budgetStatus: ProviderBudgetStatusSchema.optional(),
})

export const ProviderSecretUpdateSchema = z.object({
  values: z.record(z.string(), z.string()),
})

export const ProviderSecretsSchema = z.object({
  provider: z.string(),
  fields: z.array(ProviderSecretFieldSchema),
  lastVerifiedAt: z.string().nullable(),
  lastVerifiedStatus: z.string().nullable(),
})

export const ProviderConnectStartSchema = z.object({
  authorizationUrl: z.string().url(),
})

export const SpotifySavedAlbumsSyncSchema = z.object({
  limit: z.number().int().positive().max(50).default(5),
  stopOnExisting: z.boolean().default(true),
  confirmBroadRun: z.boolean().default(false),
})

export type ProviderSummary = z.infer<typeof ProviderSummarySchema>
export type ProviderSecrets = z.infer<typeof ProviderSecretsSchema>
export type ProviderConnection = z.infer<typeof ProviderConnectionSchema>
export type ProviderActivity = z.infer<typeof ProviderActivitySchema>
export type ProviderActivityRange = z.infer<
  typeof ProviderActivityQuerySchema
>['range']
