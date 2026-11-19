import { z } from 'zod'
import {
  ProviderResponseBodySchema,
  ProviderResponseContentTypeSchema,
} from '@repo/schemas/provider-response-body'

export const LOCAL_RESPONSE_BYTES = 2 * 1024 * 1024
const LiteralPathPattern = /^\/[a-zA-Z0-9/_-]+(?:\.[a-zA-Z0-9]+)?$/
const NumericPathPattern = /^(\/[a-zA-Z0-9/_-]+)\/\{id\}$/

export const LocalWorkerPolicySchema = z
  .object({
    origin: z
      .string()
      .url()
      .refine((value) => {
        try {
          const url = new URL(value)
          return url.protocol === 'https:' && url.origin === value
        } catch {
          return false
        }
      }),
    paths: z
      .array(
        z
          .string()
          .refine(
            (path) =>
              LiteralPathPattern.test(path) || NumericPathPattern.test(path),
          ),
      )
      .min(1)
      .max(10),
    credentialHeaders: z
      .array(z.string().regex(/^[A-Za-z][A-Za-z0-9-]*$/))
      .max(10),
    queryParameters: z
      .array(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/))
      .max(20)
      .default([]),
  })
  .strict()
export type LocalWorkerPolicy = z.infer<typeof LocalWorkerPolicySchema>

function matchesNumericPath(path: string, pattern: string): boolean {
  const prefix = NumericPathPattern.exec(pattern)?.[1]
  if (!prefix || !path.startsWith(`${prefix}/`)) return false
  const id = path.slice(prefix.length + 1)
  return /^[1-9]\d{0,15}$/.test(id) && Number.isSafeInteger(Number(id))
}

export function isLocalWorkerUrlAllowed(
  value: string,
  policy: LocalWorkerPolicy,
): boolean {
  try {
    const url = new URL(value)
    const keys = [...url.searchParams.keys()]
    const literalPath = policy.paths.includes(url.pathname)
    const numericPath =
      keys.length === 0 &&
      policy.paths.some((pattern) => matchesNumericPath(url.pathname, pattern))
    return (
      url.origin === policy.origin &&
      !url.username &&
      !url.password &&
      !url.hash &&
      (literalPath || numericPath) &&
      new Set(keys).size === keys.length &&
      keys.every((key) => policy.queryParameters.includes(key))
    )
  } catch {
    return false
  }
}

export const LocalWorkerTaskSchema = z
  .object({
    id: z.string().uuid(),
    url: z.string().url(),
    dispatchBefore: z.number().int().positive(),
    expiresAt: z.number().int().positive(),
  })
  .strict()
export type LocalWorkerTask = z.infer<typeof LocalWorkerTaskSchema>

export const LocalWorkerPermitSchema = z
  .object({
    serverTime: z.number().int().positive(),
    dispatchBefore: z.number().int().positive(),
    expiresAt: z.number().int().positive(),
  })
  .strict()

export const LocalWorkerPollSchema = z
  .object({
    serverTime: z.number().int().positive(),
    policy: LocalWorkerPolicySchema,
    task: LocalWorkerTaskSchema.nullable(),
  })
  .strict()

/** Evidence supplied by a paired worker that transforms the upstream response. */
export const LocalWorkerCaptureSchema = z
  .object({
    contentType: ProviderResponseContentTypeSchema,
    body: ProviderResponseBodySchema,
    representation: z.literal('native').optional(),
    status: z.number().int().min(100).max(599).optional(),
  })
  .strict()

export type LocalWorkerCapture = z.infer<typeof LocalWorkerCaptureSchema>

export const LocalWorkerResultSchema = z
  .discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('response'),
        id: z.string().uuid(),
        status: z.number().int().min(200).max(599),
        capture: LocalWorkerCaptureSchema.optional(),
        nativeBody: z.object({ redacted: z.boolean() }).strict().optional(),
        headers: z
          .record(z.string().max(80), z.string().max(4096))
          .refine((headers) =>
            Object.keys(headers).every((key) =>
              [
                'content-type',
                'retry-after',
                'x-ratelimit-limit',
                'x-ratelimit-remaining',
                'x-ratelimit-reset',
                'x-discogs-ratelimit',
                'x-discogs-ratelimit-used',
                'x-discogs-ratelimit-remaining',
              ].includes(key),
            ),
          ),
        body: z
          .string()
          .max(LOCAL_RESPONSE_BYTES)
          .refine(
            (body) =>
              new TextEncoder().encode(body).byteLength <= LOCAL_RESPONSE_BYTES,
          ),
      })
      .strict(),
    z
      .object({
        kind: z.literal('error'),
        id: z.string().uuid(),
        capture: LocalWorkerCaptureSchema.optional(),
        error: z.enum([
          'network',
          'timeout',
          'interrupted',
          'policy',
          'expired',
          'response-too-large',
        ]),
      })
      .strict(),
  ])
  .refine((result) => {
    const capture = result.capture?.body
    if (result.kind === 'response' && result.nativeBody && capture) return false
    if (capture?.state !== 'captured') return true
    const encoder = new TextEncoder()
    const projectedBytes =
      result.kind === 'response' ? encoder.encode(result.body).byteLength : 0
    return (
      projectedBytes + encoder.encode(capture.text).byteLength <=
      LOCAL_RESPONSE_BYTES
    )
  }, 'The response and inline capture exceed the relay limit')
export type LocalWorkerResult = z.infer<typeof LocalWorkerResultSchema>
