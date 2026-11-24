import { inspect } from 'node:util'
import { DrizzleQueryError } from 'drizzle-orm'
import { z } from 'zod'
import {
  JobErrorDetailsSchema,
  JobErrorReviewSchema,
  type JobErrorDetails,
} from '@repo/schemas/job'
import type { MediaProviderPlugin } from '@repo/media-plugin-sdk'

const ReviewMetadataSchema = z.object({
  error: JobErrorDetailsSchema.optional(),
  classification: z.literal('not-found').optional(),
  benignReview: JobErrorReviewSchema.optional(),
})

export function jobErrorReview(
  metadata: unknown,
  plugin: MediaProviderPlugin | null,
) {
  const parsed = ReviewMetadataSchema.safeParse(metadata)
  if (!parsed.success) return { canMarkBenign: false, benignReview: null }
  const { error, classification, benignReview } = parsed.data
  const notFound =
    error?.name === 'ProviderItemNotFoundError' &&
    classification === 'not-found'
  const knownLegacyError =
    error?.name === 'Error' &&
    error.causes.length === 0 &&
    plugin?.manifest.reviewableErrors?.some(
      (rule) => rule.name === error.name && rule.message === error.message,
    )
  return {
    canMarkBenign: !benignReview && !!(notFound || knownLegacyError),
    benignReview: benignReview ?? null,
  }
}

const ErrorLikeSchema = z.object({
  name: z.string().optional(),
  message: z.string(),
  stack: z.string().optional(),
  cause: z.unknown().optional(),
  code: z.unknown().optional(),
  retryAt: z.unknown().optional(),
  diagnostics: z.unknown().optional(),
})
const credentialName =
  '(?:api[_-]?(?:key|user)|access[_-]?token|refresh[_-]?token|token|secret|client[_-]?secret|password|passkey|authorization|cookie|set-cookie)'

export function redactJobText(text: string, secrets: string[]): string {
  const values = [
    ...new Set(
      secrets
        .filter(Boolean)
        .flatMap((value) => [value, encodeURIComponent(value)]),
    ),
  ].sort((a, b) => b.length - a.length)
  let result = text
  for (const value of values) result = result.replaceAll(value, '[REDACTED]')
  return result
    .replace(/\b(Bearer|Basic)\s+[^\s"',;]+/gi, '$1 [REDACTED]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(
      new RegExp(
        `(["']?${credentialName}["']?\\s*[:=]\\s*)(?:"[^"\\r\\n]*"|'[^'\\r\\n]*'|[^\\s,;&}]+)`,
        'gi',
      ),
      '$1[REDACTED]',
    )
}

export function jobErrorDetails(
  error: unknown,
  secrets: string[],
): JobErrorDetails {
  const redact = (value: string) => {
    const safe = redactJobText(value, secrets)
    return safe.length > 16000 ? `${safe.slice(0, 16000)}\n[truncated]` : safe
  }
  function diagnosticField<T>(
    schema: z.ZodType<T>,
    value: unknown,
  ): T | undefined {
    const parsed = schema.safeParse(value)
    if (!parsed.success || parsed.data === undefined) return undefined
    const text = JSON.stringify(parsed.data)
    if (text === undefined) return undefined
    return redactJobText(text, secrets) === text ? parsed.data : undefined
  }
  function entry(value: unknown) {
    if (value instanceof DrizzleQueryError) {
      // Drizzle puts the complete SQL and every bound value in both message and stack.
      // PostgreSQL messages can also quote the rejected row. Keep the safe reason.
      const result = z
        .object({ code: z.string().regex(/^[0-9A-Z]{5}$/) })
        .safeParse(value.cause)
      const reasons: Record<string, string> = {
        '22P02': 'Invalid input value',
        '23502': 'A required value was missing',
        '23503': 'A referenced record was missing',
        '23505': 'A unique value already exists',
        '23514': 'A check constraint failed',
        '40001': 'Concurrent transaction conflict',
        '40P01': 'Database deadlock',
        '55P03': 'Database lock unavailable',
        '57014': 'Database statement cancelled',
      }
      const message = result.success
        ? `${reasons[result.data.code] ?? 'Database statement failed'} (SQLSTATE ${result.data.code})`
        : 'Database statement failed'
      return { name: 'DatabaseError', message, stack: null }
    }
    const parsed = ErrorLikeSchema.safeParse(value)
    const code = diagnosticField(
      JobErrorDetailsSchema.shape.code,
      parsed.success ? parsed.data.code : undefined,
    )
    const retryAt = diagnosticField(
      JobErrorDetailsSchema.shape.retryAt,
      parsed.success ? parsed.data.retryAt : undefined,
    )
    const diagnostics = diagnosticField(
      JobErrorDetailsSchema.shape.diagnostics,
      parsed.success ? parsed.data.diagnostics : undefined,
    )
    return {
      name: redact(
        parsed.success ? (parsed.data.name ?? 'Error') : 'Thrown value',
      ),
      message: redact(
        parsed.success
          ? parsed.data.message
          : typeof value === 'string'
            ? value
            : inspect(value, { depth: 3, maxArrayLength: 20 }),
      ),
      stack:
        parsed.success && parsed.data.stack ? redact(parsed.data.stack) : null,
      ...(code !== undefined ? { code } : {}),
      ...(retryAt !== undefined ? { retryAt } : {}),
      ...(diagnostics !== undefined ? { diagnostics } : {}),
    }
  }
  const causes: JobErrorDetails['causes'] = []
  const seen = new Set<unknown>([error])
  let current = error
  for (let depth = 0; depth < 5; depth++) {
    if (current instanceof DrizzleQueryError) break
    const parsed = ErrorLikeSchema.safeParse(current)
    const cause = parsed.success ? parsed.data.cause : undefined
    if (cause === undefined || seen.has(cause)) break
    causes.push(entry(cause))
    seen.add(cause)
    current = cause
  }
  return { ...entry(error), causes }
}

export function jobLogSecrets(
  providerSecrets: Record<string, string>,
): string[] {
  return [
    ...Object.values(providerSecrets),
    ...Object.entries(process.env).flatMap(([key, value]) =>
      value &&
      /secret|password|token|api.?key|api.?user|encryption|database_url/i.test(
        key,
      )
        ? [value]
        : [],
    ),
  ]
}
