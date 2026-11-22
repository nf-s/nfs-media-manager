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
/** Days in `ProviderRequestSeries.days`: today and the 89 UTC days before it. */
export const PROVIDER_REQUEST_SERIES_DAYS = 90

/** Request attempts per UTC day for the provider page's trend chart. */
export const ProviderRequestSeriesSchema = z.object({
  provider: z.string(),
  /** When complete recording began; earlier days are partial. */
  recordedSince: z.string().datetime().nullable(),
  /** First day `days` covers. */
  daysFrom: z.string().date(),
  /** Last day `days` covers: the UTC date when the series was read. */
  daysTo: z.string().date(),
  total: z.number().int().nonnegative(),
  /** Days from `daysFrom` to `daysTo` with at least one request, oldest first. */
  days: z
    .array(
      z.object({
        date: z.string().date(),
        count: z.number().int().positive(),
      }),
    )
    .max(PROVIDER_REQUEST_SERIES_DAYS),
})

/**
 * Library items of one media type the provider applies to, and how many of
 * them it has fetched data for: a current state with a successful scrape.
 */
export const ProviderLibraryCoverageSchema = z.object({
  provider: z.string(),
  /** One entry per media type in the provider's manifest; empty for account-level providers. */
  mediaTypes: z.array(
    z.object({
      mediaType: z.enum(['album', 'film', 'track']),
      covered: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
      /**
       * Where the rest is looked up: Metadata selection, or each item's own
       * page when Metadata cannot queue this provider for that library.
       */
      queueFrom: z.enum(['metadata', 'item']).default('metadata'),
    }),
  ),
})

export const ClearProviderCooldownSchema = z.object({
  confirm: z.literal(true),
  expectedCooldownUntil: z.string().datetime(),
})

export const ProviderLocalWorkerModeSchema = z.enum(['local', 'cloud'])
export type ProviderLocalWorkerMode = z.infer<
  typeof ProviderLocalWorkerModeSchema
>

export const ProviderLocalWorkerStatusSchema = z.object({
  mode: ProviderLocalWorkerModeSchema,
  supportsModeSwitch: z.boolean(),
  configured: z.boolean(),
  paired: z.boolean(),
  online: z.boolean(),
  lastSeenAt: z.number().int().positive().nullable(),
  blocked: z.boolean(),
  active: z.boolean(),
})
export type ProviderLocalWorkerStatus = z.infer<
  typeof ProviderLocalWorkerStatusSchema
>

export const ProviderLocalWorkerControlSchema = z
  .object({ mode: z.enum(['pair', 'revoke', 'local', 'cloud', 'review']) })
  .strict()

export const ProviderLocalWorkerControlResultSchema = z.object({
  token: z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/)
    .nullable(),
  status: ProviderLocalWorkerStatusSchema,
})

/** A provider's own website: an absolute http or https URL. */
export const ProviderSiteUrlSchema = z
  .string()
  .url()
  .refine((value) => /^https?:\/\//i.test(value), {
    message: 'Use an http or https URL',
  })

/** How many items one of a provider's task jobs covers. */
export const ProviderTaskLimitSchema = z.object({
  /** The jobs it applies to, such as `Track lookups`. */
  label: z.string(),
  maxItems: z.number().int().positive(),
  noun: z.object({ one: z.string(), other: z.string() }),
})
export type ProviderTaskLimit = z.infer<typeof ProviderTaskLimitSchema>

export const ProviderSummarySchema = z.object({
  id: z.string(),
  displayName: z.string(),
  description: z.string(),
  /** The provider's own website, from its manifest. */
  siteUrl: ProviderSiteUrlSchema.optional(),
  surface: z.enum(['provider', 'import']),
  mediaTypes: z.array(z.enum(['album', 'film'])),
  /** The provider fills the Subscriptions library and is listed in its Providers. */
  subscriptions: z.boolean().default(false),
  /** The provider fills the Mixes library and is listed in its Providers. */
  mixes: z.boolean().default(false),
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
  supportsArtistEnrichment: z.boolean().optional(),
  supportsJobDispatchControl: z.boolean().default(false),
  supportsLocalWorker: z.boolean().optional(),
  maxItemsPerJob: z.number().int().positive().optional(),
  taskLimits: z.array(ProviderTaskLimitSchema).default([]),
  requireExplicitSelection: z.boolean().optional(),
  identifierTypes: z.array(z.string()).default([]),
  supportsNameLookup: z.boolean().default(false),
  /** Find match can search the provider for an item's candidates. */
  supportsMatchSearch: z.boolean().default(false),
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

/**
 * Why a provider's queued work is not starting, in precedence order:
 * - `access-denied`: requests are halted after the provider denied access.
 * - `stopped`: the dispatcher stopped after repeated failures.
 * - `paused`: the dispatcher is paused, scraping is disabled, or the job is
 *   outside the jobs selected to run.
 * - `not-configured`: no executable plugin is loaded for the provider.
 * - `worker-offline`: the provider's local worker is unpaired, offline or
 *   waiting for review.
 * - `cooldown`: a cooldown after an error or rate limit is active.
 * - `budget`: the provider's hourly or daily request budget is used up.
 * - `rate-limit`: the hourly request cap or a fixed request window is full.
 * - `concurrency`: every request slot is held by a running job.
 * - `queued`: nothing blocks the provider; the job waits its turn.
 */
export const ProviderWaitReasonSchema = z.enum([
  'access-denied',
  'stopped',
  'paused',
  'not-configured',
  'worker-offline',
  'cooldown',
  'budget',
  'rate-limit',
  'concurrency',
  'queued',
])
export type ProviderWaitReason = z.infer<typeof ProviderWaitReasonSchema>

export const ProviderWaitingSchema = z.object({
  reason: ProviderWaitReasonSchema,
  /** When the block lifts on its own; null when it needs action or is unknown. */
  until: z.string().datetime().nullable(),
  detail: z.string(),
})
export type ProviderWaiting = z.infer<typeof ProviderWaitingSchema>

export const ProviderLibrarySchema = z.enum([
  'album',
  'film',
  'artist',
  'subscription',
  'mix',
])

export const ProviderOverviewQuerySchema = z.object({
  /** Limits the list to the providers shown in that library's Providers. */
  mediaType: ProviderLibrarySchema.optional(),
})

export const ProviderConnectionStateSchema = z.enum([
  'connected',
  'needs-sign-in',
  'needs-key',
  'not-required',
  'unavailable',
])
export const ProviderQueueStateSchema = z.enum([
  'running',
  'idle',
  'waiting',
  'paused',
  'stopped',
])

export const ProviderOverviewItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  /** Account providers sign in or sync an account; metadata providers fill items. */
  group: z.enum(['account', 'metadata']),
  /** Libraries the provider supplies, plus `account` for account-level syncs. */
  roles: z.array(
    z.enum(['album', 'film', 'artist', 'subscription', 'mix', 'account']),
  ),
  connection: z.object({
    state: ProviderConnectionStateSchema,
    /** `account` signs in with OAuth; `key` uses stored credentials. */
    method: z.enum(['account', 'key', 'none']),
    detail: z.string().nullable(),
  }),
  queue: z.object({
    state: ProviderQueueStateSchema,
    reason: ProviderWaitReasonSchema.nullable(),
    until: z.string().datetime().nullable(),
    detail: z.string().nullable(),
  }),
  /** Counts across every library. `attention` matches the Needs attention filter. */
  jobs: z.object({
    queued: z.number().int().nonnegative(),
    running: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    attention: z.number().int().nonnegative(),
  }),
  lastSuccessAt: z.string().datetime().nullable(),
  /** 24 hourly request counts, oldest first, starting at `requestsFrom`. */
  requests24h: z.array(z.number().int().nonnegative()).length(24),
  budget: z
    .object({
      used: z.number().int().nonnegative(),
      limit: z.number().int().positive(),
      period: z.enum(['hour', 'day']),
      resetsAt: z.string().datetime(),
    })
    .nullable(),
  runsOn: z.enum(['server', 'local-worker']),
  worker: z
    .object({ paired: z.boolean(), online: z.boolean(), blocked: z.boolean() })
    .nullable(),
  /** Jobs the provider runs at once; null without a loaded plugin. */
  concurrency: z.number().int().positive().nullable(),
})
export const ProviderOverviewSchema = z.object({
  generatedAt: z.string().datetime(),
  requestsFrom: z.string().datetime(),
  providers: z.array(ProviderOverviewItemSchema),
})
export type ProviderOverviewItem = z.infer<typeof ProviderOverviewItemSchema>
export type ProviderOverview = z.infer<typeof ProviderOverviewSchema>

export type ProviderSummary = z.infer<typeof ProviderSummarySchema>
export type ProviderSecrets = z.infer<typeof ProviderSecretsSchema>
export type ProviderActivity = z.infer<typeof ProviderActivitySchema>
export type ProviderJobSummary = z.infer<typeof ProviderJobSummarySchema>
export type ProviderRequestSeries = z.infer<typeof ProviderRequestSeriesSchema>
export type ProviderLibraryCoverage = z.infer<
  typeof ProviderLibraryCoverageSchema
>
export type ProviderActivityRange = z.infer<
  typeof ProviderActivityQuerySchema
>['range']
