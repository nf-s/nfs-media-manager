import { z } from 'zod'

const QuotaHeaderValueSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER)
export const ProviderQuotaHeadersSchema = z
  .object({
    'x-ratelimit-limit': QuotaHeaderValueSchema.optional(),
    'x-ratelimit-remaining': QuotaHeaderValueSchema.optional(),
    'x-ratelimit-reset': QuotaHeaderValueSchema.optional(),
    'x-discogs-ratelimit': QuotaHeaderValueSchema.optional(),
    'x-discogs-ratelimit-used': QuotaHeaderValueSchema.optional(),
    'x-discogs-ratelimit-remaining': QuotaHeaderValueSchema.optional(),
  })
  .strict()

export const ProviderRequestDiagnosticsSchema = z
  .object({
    source: z.enum([
      'provider-response',
      'local-cooldown',
      'local-budget',
      'local-access-halt',
    ]),
    httpStatus: z.number().int().min(100).max(599).optional(),
    responseReceivedAt: z.string().datetime().optional(),
    quotaError: z.boolean().optional(),
    retryAfter: z
      .union([
        z.object({ seconds: QuotaHeaderValueSchema }).strict(),
        z.object({ at: z.string().datetime() }).strict(),
      ])
      .optional(),
    quotaHeaders: ProviderQuotaHeadersSchema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.source === 'provider-response'
        ? value.httpStatus !== undefined &&
          value.responseReceivedAt !== undefined
        : value.httpStatus === undefined &&
          value.responseReceivedAt === undefined &&
          value.quotaError === undefined &&
          value.retryAfter === undefined &&
          value.quotaHeaders === undefined,
    { message: 'Response evidence requires a provider response source' },
  )
export type ProviderRequestDiagnostics = z.infer<
  typeof ProviderRequestDiagnosticsSchema
>

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
export const ProviderJobSummarySchema = z.object({
  provider: z.string(),
  total: z.number().int().nonnegative(),
  queued: z.number().int().nonnegative(),
  running: z.number().int().nonnegative(),
  succeeded: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  cancelled: z.number().int().nonnegative(),
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
  /** The provider fills the Subscriptions library and is listed in its Providers. */
  subscriptions: z.boolean().default(false),
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
  supportsJobDispatchControl: z.boolean().default(false),
  maxItemsPerJob: z.number().int().positive().optional(),
  requireExplicitSelection: z.boolean().optional(),
  identifierTypes: z.array(z.string()).default([]),
  supportsNameLookup: z.boolean().default(false),
  supportsLegacyImport: z.boolean(),
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

export type ProviderSummary = z.infer<typeof ProviderSummarySchema>
export type ProviderSecrets = z.infer<typeof ProviderSecretsSchema>
export type ProviderActivity = z.infer<typeof ProviderActivitySchema>
export type ProviderJobSummary = z.infer<typeof ProviderJobSummarySchema>
export type ProviderActivityRange = z.infer<
  typeof ProviderActivityQuerySchema
>['range']
