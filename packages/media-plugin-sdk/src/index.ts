import { z } from 'zod'

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
)

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

export const PluginDiagnosticSchema = z.object({
  stage: z.string().min(1).max(80),
  evidence: JsonValueSchema,
})
export type PluginDiagnostic = z.infer<typeof PluginDiagnosticSchema>

export const PluginMediaTypeSchema = z.enum(['album', 'film'])
export type PluginMediaType = z.infer<typeof PluginMediaTypeSchema>

export const PluginRequestBudgetSchema = z.object({
  period: z.enum(['hour', 'day']),
  limit: z.number().int().positive().max(100000),
})

export const PluginRateLimitSchema = z.object({
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
  requestBudget: PluginRequestBudgetSchema.optional(),
  configurableRequestBudget: z.boolean().optional(),
  respectRateLimitHeaders: z.boolean().optional(),
  retryAfterIsAuthoritative: z.boolean().optional(),
  rateLimitCooldownMs: z.number().int().positive().optional(),
  errorBackoffMs: z.number().int().nonnegative().optional(),
  failureCooldownMs: z.number().int().nonnegative().optional(),
})

export const PluginSecretDescriptorSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  required: z.boolean().default(true),
  helpText: z.string().optional(),
  placeholder: z.string().optional(),
  envVars: z.array(z.string()).optional(),
})

export const PluginReferenceSchema = z.object({
  referenceType: z.string().min(1),
  externalId: z.string().min(1),
  isPrimary: z.boolean().default(false),
  metadata: z.record(z.string(), JsonValueSchema).optional(),
})

export const PluginLinkSchema = z.object({
  provider: z.string().min(1),
  label: z.string().min(1),
  url: z.string().url(),
})

export const PluginTagSchema = z.object({
  name: z.string().min(1),
  kind: z.string().min(1).default('general'),
  source: z.string().optional(),
  sourceId: z.string().optional(),
  rawName: z.string().optional(),
})

export const PluginTrackSchema = z.object({
  externalId: z.string().optional(),
  title: z.string().min(1),
  position: z.number().int().positive(),
  durationSec: z.number().int().nonnegative().optional(),
})

export const PluginNormalizedMediaPatchSchema = z.object({
  title: z.string().optional(),
  originalTitle: z.string().optional(),
  summary: z.string().optional(),
  artworkUrl: z.string().url().optional(),
  releaseDate: z.string().optional(),
  sourceLabel: z.string().optional(),
  metadata: z.record(z.string(), JsonValueSchema).optional(),
})

export const PluginNormalizedAlbumPatchSchema = z.object({
  dateAdded: z.string().optional(),
  durationSec: z.number().int().nonnegative().optional(),
  spotifyUrl: z.string().url().optional(),
  metadata: z.record(z.string(), JsonValueSchema).optional(),
})

export const PluginNormalizedFilmPatchSchema = z.object({
  dateAdded: z.string().datetime().optional(),
  dateAddedSource: z.string().min(1).optional(),
  runtimeMinutes: z.number().int().nonnegative().optional(),
  watched: z.boolean().optional(),
  sourceKind: z.string().optional(),
  budget: z.number().int().nonnegative().optional(),
  boxOffice: z.number().int().nonnegative().optional(),
  metadata: z.record(z.string(), JsonValueSchema).optional(),
})

export const PluginCreditSchema = z.object({
  name: z.string().min(1),
  role: z.string().min(1),
  billingOrder: z.number().int().nonnegative().default(0),
})

export const PluginPlaylistSchema = z.object({
  name: z.string().min(1),
  kind: z.enum(['playlist', 'collection']).default('playlist'),
  position: z.number().int().nonnegative().default(0),
})

export const PluginNormalizedResultSchema = z
  .object({
    mediaPatch: PluginNormalizedMediaPatchSchema.optional(),
    albumPatch: PluginNormalizedAlbumPatchSchema.optional(),
    filmPatch: PluginNormalizedFilmPatchSchema.optional(),
    references: z.array(PluginReferenceSchema).default([]),
    links: z.array(PluginLinkSchema).default([]),
    tags: z.array(PluginTagSchema).default([]),
    credits: z.array(PluginCreditSchema).default([]),
    tracks: z.array(PluginTrackSchema).default([]),
    playlists: z.array(PluginPlaylistSchema).default([]),
  })
  .default(() => ({
    references: [],
    links: [],
    tags: [],
    credits: [],
    tracks: [],
    playlists: [],
  }))

export const PluginResultSchema = z.object({
  payload: JsonValueSchema,
  normalized: PluginNormalizedResultSchema,
})

export type PluginRateLimit = z.infer<typeof PluginRateLimitSchema>
export type PluginSecretDescriptor = z.infer<
  typeof PluginSecretDescriptorSchema
>
export type PluginReference = z.infer<typeof PluginReferenceSchema>
export type PluginLink = z.infer<typeof PluginLinkSchema>
export type PluginTag = z.infer<typeof PluginTagSchema>
export type PluginCredit = z.infer<typeof PluginCreditSchema>
export type PluginTrack = z.infer<typeof PluginTrackSchema>
export type PluginPlaylist = z.infer<typeof PluginPlaylistSchema>
export type PluginNormalizedResult = z.infer<
  typeof PluginNormalizedResultSchema
>
export type PluginResult = z.infer<typeof PluginResultSchema>

export interface MediaPluginTestContext {
  secrets: Record<string, string>
  request: (
    url: string | URL,
    init?: RequestInit,
    options?: { notFoundOn404?: boolean },
  ) => Promise<Response>
}

export interface MediaPluginScrapeContext {
  mediaItemId: string
  mediaType: PluginMediaType
  media?: { title: string; artists: string[]; releaseDate?: string }
  existingReferences: PluginReference[]
  secrets: Record<string, string>
  request: MediaPluginTestContext['request']
  log: (level: 'info' | 'warn' | 'error', message: string) => Promise<void>
  // Optional, best-effort evidence only; the host validates, redacts and bounds it.
  recordDiagnostic?: (diagnostic: PluginDiagnostic) => void
}

export function recordPluginDiagnostic(
  context: Pick<MediaPluginScrapeContext, 'recordDiagnostic'>,
  diagnostic: PluginDiagnostic,
): void {
  try {
    context.recordDiagnostic?.(diagnostic)
  } catch {
    // Diagnostics must not change success, failure classification or retries.
  }
}

export interface MediaPluginLegacyImportContext {
  rawRecord: JsonValue
  mediaType: PluginMediaType
}

export interface MediaPluginManifest {
  id: string
  displayName: string
  description: string
  mediaTypes: PluginMediaType[]
  rateLimit: PluginRateLimit
  secrets: PluginSecretDescriptor[]
  maxItemsPerJob?: number
  requireExplicitSelection?: boolean
  identifierTypes?: string[]
  supportsNameLookup?: boolean
  sourceNavigation?: { collectionUrlTemplate?: string; tagUrlTemplate?: string }
  reviewableErrors?: Array<{ name: string; message: string }>
  fileImports?: Array<{ id: string; label: string; requiredColumns: string[] }>
  browseFields?: Array<{
    key: string
    label: string
    type: 'text' | 'number' | 'date'
    format?:
      | 'number'
      | 'percent'
      | 'rating5'
      | 'rating10'
      | 'seconds'
      | 'minutes'
      | 'money'
      | 'db'
      | 'bpm'
    filterable: boolean
    rating?: {
      provider: string
      compact?: boolean
      shortLabel?: string
      scale: number
      votesKey?: string
      iconUrl?: string
    }
  }>
}

export const StoredPersonalStateSchema = z.object({
  bookmarked: z.boolean().optional(),
  bookmarkDate: z.string().optional(),
  watchlist: z.boolean().optional(),
  watchlistDate: z.string().optional(),
})

export interface MediaProviderPlugin {
  /** Pure interpretation of retained import data; no credentials, network or writes. */
  readStoredPersonalState?: (input: {
    payload: JsonValue
    sourceKind: string | null
    sourceLabel: string | null
  }) => z.infer<typeof StoredPersonalStateSchema> | null
  manifest: MediaPluginManifest
  /** Pure extraction from saved payloads; must not perform network requests. */
  readStoredCollections?: (
    payload: JsonValue,
  ) => Array<{ id: string; name: string }>
  testConnection?: (context: MediaPluginTestContext) => Promise<void>
  scrapeMediaItem?: (context: MediaPluginScrapeContext) => Promise<PluginResult>
  importLegacyRecord?: (
    context: MediaPluginLegacyImportContext,
  ) => Promise<PluginResult | null>
  importFileRecord?: (context: {
    format: string
    row: Record<string, string>
  }) => Promise<PluginResult | null>
}

// Source and built SDK imports have different constructors but share this brand.
const providerItemNotFoundBrand = Symbol.for(
  '@repo/media-plugin-sdk/ProviderItemNotFoundError',
)

export class ProviderItemNotFoundError extends Error {
  readonly [providerItemNotFoundBrand] = true

  constructor(message: string) {
    super(message)
    this.name = 'ProviderItemNotFoundError'
  }
}

export function isProviderItemNotFoundError(
  error: unknown,
): error is ProviderItemNotFoundError {
  return (
    error instanceof Error &&
    error.name === 'ProviderItemNotFoundError' &&
    providerItemNotFoundBrand in error &&
    error[providerItemNotFoundBrand] === true &&
    !('cause' in error) &&
    !('errors' in error)
  )
}

export class ProviderRequestError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'rate-limit'
      | 'cooldown'
      | 'request-failed'
      | 'access-denied',
    public readonly retryAt: number | null = null,
    public readonly recorded = false,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'ProviderRequestError'
  }
}

export const MediaPluginManifestSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/),
    displayName: z.string().min(1),
    description: z.string(),
    mediaTypes: z.array(PluginMediaTypeSchema).min(1),
    rateLimit: PluginRateLimitSchema,
    secrets: z.array(PluginSecretDescriptorSchema),
    maxItemsPerJob: z.number().int().positive().optional(),
    requireExplicitSelection: z.boolean().optional(),
    identifierTypes: z.array(z.string().min(1)).optional(),
    supportsNameLookup: z.boolean().optional(),
    sourceNavigation: z
      .object({
        collectionUrlTemplate: z.string().url().optional(),
        tagUrlTemplate: z.string().url().optional(),
      })
      .optional(),
    reviewableErrors: z
      .array(
        z.object({
          name: z.string().min(1),
          message: z.string().min(1),
        }),
      )
      .optional(),
    fileImports: z
      .array(
        z.object({
          id: z.string().regex(/^[a-z][a-z0-9-]*$/),
          label: z.string().min(1),
          requiredColumns: z.array(z.string().min(1)).min(1),
        }),
      )
      .optional(),
    browseFields: z
      .array(
        z.object({
          key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]*$/),
          label: z.string().min(1),
          type: z.enum(['text', 'number', 'date']),
          format: z
            .enum([
              'number',
              'percent',
              'rating5',
              'rating10',
              'seconds',
              'minutes',
              'money',
              'db',
              'bpm',
            ])
            .optional(),
          filterable: z.boolean(),
          rating: z
            .object({
              provider: z.string().min(1),
              compact: z.boolean().optional(),
              shortLabel: z.string().min(1).max(20).optional(),
              scale: z.number().finite().positive(),
              votesKey: z
                .string()
                .regex(/^[a-zA-Z][a-zA-Z0-9_.-]*$/)
                .optional(),
              iconUrl: z
                .string()
                .max(32768)
                .refine(
                  (value) =>
                    /^data:image\/(?:png|webp|gif|x-icon);base64,[A-Za-z0-9+/]+={0,2}$/.test(
                      value,
                    ) ||
                    (z.string().url().safeParse(value).success &&
                      value.startsWith('https://')),
                  'Rating icons must be HTTPS URLs or embedded raster images',
                )
                .optional(),
            })
            .optional(),
        }),
      )
      .optional(),
  })
  .superRefine((manifest, context) => {
    const keys = (manifest.browseFields ?? []).map((field) => field.key)
    if (
      new Set(keys).size !== keys.length ||
      keys.some((key) => !key.startsWith(`plugin.${manifest.id}.`))
    ) {
      context.addIssue({
        code: 'custom',
        path: ['browseFields'],
        message: 'Browse keys must be unique and namespaced with plugin.<id>.',
      })
    }
    if (
      new Set(manifest.secrets.map((secret) => secret.key)).size !==
      manifest.secrets.length
    ) {
      context.addIssue({
        code: 'custom',
        path: ['secrets'],
        message: 'Credential keys must be unique',
      })
    }
  })

export function isMediaProviderPlugin(
  value: unknown,
): value is MediaProviderPlugin {
  if (typeof value !== 'object' || value === null || !('manifest' in value))
    return false
  if (!MediaPluginManifestSchema.safeParse(value.manifest).success) return false
  for (const key of [
    'testConnection',
    'scrapeMediaItem',
    'importLegacyRecord',
    'importFileRecord',
    'readStoredCollections',
    'readStoredPersonalState',
  ]) {
    if (key in value && typeof Reflect.get(value, key) !== 'function')
      return false
  }
  return true
}
