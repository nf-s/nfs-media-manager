import { z } from 'zod'
import { PaginatedDataSchema } from './common'
import {
  MAX_LOCAL_PROVIDER_RESPONSE_BYTES,
  ProviderResponseBodySchema,
  ProviderResponseContentTypeSchema,
} from './provider-response-body'
export * from './provider-response-body'

const identifier = z.string().min(1).max(200)
const ordinal = z.number().int().positive().max(2147483647)
const method = z.string().regex(/^[A-Z]{1,16}$/)
const requestKey = z
  .string()
  .regex(/^[a-f0-9]{64}$/i)
  .nullable()

const requestUrl = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value)
      return (
        (url.protocol === 'http:' || url.protocol === 'https:') &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      )
    } catch {
      return false
    }
  }, 'Expected an HTTP URL without credentials, query or fragment')
  .nullable()

const phase = z.enum(['media', 'artist', 'task'])
const status = z.number().int().min(100).max(599).nullable()
const receivedAt = z.string().datetime().nullable()

export const ProviderResponseCaptureSchema = z.object({
  ordinal,
  phase,
  request: z.object({
    method,
    url: requestUrl,
    key: z
      .string()
      .regex(/^[a-f0-9]{64}$/i)
      .nullable()
      .optional(),
  }),
  response: z.object({
    status,
    receivedAt,
    contentType: ProviderResponseContentTypeSchema,
    retry: ordinal.optional(),
    notFound: z.boolean().optional(),
    body: ProviderResponseBodySchema,
  }),
})

export const ProviderResponseSummarySchema = z.object({
  id: identifier,
  jobId: identifier,
  jobItemId: identifier.nullable(),
  artistId: identifier.nullable(),
  provider: identifier,
  attempt: ordinal,
  ordinal,
  phase,
  method,
  requestUrl,
  status,
  receivedAt,
  contentType: ProviderResponseContentTypeSchema,
  retry: ordinal.nullable(),
  notFound: z.boolean(),
  bodyState: z.enum(['captured', 'local', 'unavailable']),
  retainedBytes: z
    .number()
    .int()
    .nonnegative()
    .max(MAX_LOCAL_PROVIDER_RESPONSE_BYTES),
})

export const ProviderResponseSchema = ProviderResponseSummarySchema.extend({
  requestKey,
  body: ProviderResponseBodySchema,
})

export const ProviderResponsePageSchema = PaginatedDataSchema(
  ProviderResponseSummarySchema,
)

export type ProviderResponseCapture = z.infer<
  typeof ProviderResponseCaptureSchema
>
export type ProviderResponseSummary = z.infer<
  typeof ProviderResponseSummarySchema
>
export type ProviderResponse = z.infer<typeof ProviderResponseSchema>
