import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import { resolve } from 'node:path'
import { LocalWorkerPolicySchema } from '@repo/media-plugin-sdk/local-worker'
import { z } from 'zod'

export class WorkerError extends Error {}

export function trustedOrigin(value: string): string {
  const url = new URL(value)
  const hostname = url.hostname
  if (
    url.protocol !== 'https:' ||
    url.origin !== value ||
    isIP(hostname) ||
    hostname.includes(':') ||
    !hostname.includes('.') ||
    hostname.endsWith('.') ||
    /(^|\.)(localhost|local|internal|lan|home)$/.test(hostname) ||
    !/^[a-z0-9.-]+$/.test(hostname)
  )
    throw new WorkerError(
      'Configuration requires an exact public HTTPS hostname origin',
    )
  return value
}

const EnvironmentSchema = z.object({
  LOCAL_WORKER_URL: z.string().min(1),
  LOCAL_WORKER_PROVIDER: z.string().regex(/^[a-z][a-z0-9-]{0,79}$/),
  LOCAL_WORKER_TOKEN: z
    .string()
    .min(1)
    .regex(/^[\x21-\x7e]+$/),
  LOCAL_WORKER_ORIGIN: z.string().min(1),
  LOCAL_WORKER_PATHS: z.string().min(1),
  LOCAL_WORKER_QUERY_PARAMETERS: z.string().default(''),
  LOCAL_WORKER_CREDENTIALS: z.string().default('{}'),
  LOCAL_WORKER_STATE_DIR: z.string().min(1).default('.local-worker'),
})

export function loadConfig(environment: NodeJS.ProcessEnv = process.env) {
  try {
    const env = EnvironmentSchema.parse(environment)
    const credentialVariables = z
      .record(
        z.string().regex(/^[A-Za-z][A-Za-z0-9-]*$/),
        z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
      )
      .parse(JSON.parse(env.LOCAL_WORKER_CREDENTIALS))
    const credentials: Record<string, string> = {}
    for (const [name, variable] of Object.entries(credentialVariables)) {
      const header = name.toLowerCase()
      if (
        Object.hasOwn(credentials, header) ||
        /^(host|connection|content-length|transfer-encoding|proxy-.*|sec-.*|upgrade|te|trailer|keep-alive)$/.test(
          header,
        )
      ) {
        throw new Error('Unsafe credential header')
      }
      const value = environment[variable]
      if (!value || /[^\x20-\x7e]/.test(value))
        throw new Error('Missing credential')
      credentials[header] = value
    }
    const appOrigin = trustedOrigin(env.LOCAL_WORKER_URL)
    const policy = LocalWorkerPolicySchema.parse({
      origin: trustedOrigin(env.LOCAL_WORKER_ORIGIN),
      paths: env.LOCAL_WORKER_PATHS.split(',').map((path) => path.trim()),
      queryParameters: env.LOCAL_WORKER_QUERY_PARAMETERS.split(',')
        .map((name) => name.trim())
        .filter(Boolean),
      credentialHeaders: Object.keys(credentials),
    })
    return {
      appOrigin,
      provider: env.LOCAL_WORKER_PROVIDER,
      token: env.LOCAL_WORKER_TOKEN,
      policy,
      credentials,
      stateDir: resolve(env.LOCAL_WORKER_STATE_DIR),
      binding: createHash('sha256')
        .update(
          JSON.stringify([appOrigin, env.LOCAL_WORKER_PROVIDER, policy.origin]),
        )
        .digest('hex'),
    }
  } catch {
    throw new WorkerError(
      'Invalid local worker configuration; check required variables, origins, paths and credentials',
    )
  }
}

export type WorkerConfig = ReturnType<typeof loadConfig>

export function redact(value: string, config: WorkerConfig): string {
  let clean = value
  for (const secret of [
    config.token,
    ...Object.values(config.credentials),
  ].sort((a, b) => b.length - a.length)) {
    clean = clean.split(secret).join('[redacted]')
  }
  return clean
}
