import { z } from 'zod'

export const LOCAL_RESPONSE_BYTES = 2 * 1024 * 1024
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
      .array(z.string().regex(/^\/[a-zA-Z0-9/_-]+(?:\.[a-zA-Z0-9]+)?$/))
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

export function isLocalWorkerUrlAllowed(
  value: string,
  policy: LocalWorkerPolicy,
): boolean {
  try {
    const url = new URL(value)
    const keys = [...url.searchParams.keys()]
    return (
      url.origin === policy.origin &&
      !url.username &&
      !url.password &&
      !url.hash &&
      policy.paths.includes(url.pathname) &&
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

export const LocalWorkerResultSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('response'),
      id: z.string().uuid(),
      status: z.number().int().min(200).max(599),
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
export type LocalWorkerResult = z.infer<typeof LocalWorkerResultSchema>
