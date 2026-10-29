import { inspect } from 'node:util'
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
  function entry(value: unknown) {
    const parsed = ErrorLikeSchema.safeParse(value)
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
    }
  }
  const causes: JobErrorDetails['causes'] = []
  const seen = new Set<unknown>([error])
  let current = error
  for (let depth = 0; depth < 5; depth++) {
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
