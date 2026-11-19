import { z } from 'zod'

export const MAX_PROVIDER_RESPONSE_BYTES = 10 * 1024 * 1024
export const MAX_LOCAL_PROVIDER_RESPONSE_BYTES = 16 * 1024 * 1024

export const ProviderResponseContentTypeSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/i)
  .nullable()

export const ProviderResponseUnavailableReasonSchema = z.enum([
  'empty',
  'byte-limit',
  'read-failed',
  'unsupported-format',
  'local-response',
  'policy',
  'redact-failed',
  'transport-error',
  'capture-limit',
])

export const ProviderResponseBodySchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('captured'),
    text: z.string().max(MAX_PROVIDER_RESPONSE_BYTES),
    redacted: z.boolean().optional(),
    retainedRepresentation: z
      .enum(['station-discovery', 'station-episode-data'])
      .optional(),
  }),
  z.object({
    state: z.literal('local'),
    // A local reference is an opaque token. The server never reads or follows it.
    reference: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
    retainedBytes: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_LOCAL_PROVIDER_RESPONSE_BYTES),
  }),
  z.object({
    state: z.literal('unavailable'),
    reason: ProviderResponseUnavailableReasonSchema,
  }),
])

export type ProviderResponseBody = z.infer<typeof ProviderResponseBodySchema>
