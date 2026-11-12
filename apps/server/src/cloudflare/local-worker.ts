import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { z } from 'zod'
import {
  ProviderRequestError,
  type MediaProviderPlugin,
} from '@repo/media-plugin-sdk'
import {
  LocalWorkerResultSchema,
  LOCAL_RESPONSE_BYTES,
  isLocalWorkerUrlAllowed,
} from '@repo/media-plugin-sdk/local-worker'
import { env } from '@/env'
import { ServerError } from '@/lib/error'
import { getScrapePlugin } from '@/plugins/registry'
import type { ProviderTransport } from '@/services/provider-transport'
import { protectProviderFromLocalResponse } from '@/services/provider-requests'
import { withCloudDatabase } from './db'

const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms))
const hash = (token: string) => createHash('sha256').update(token).digest('hex')
const IdSchema = z.object({ id: z.string().uuid() }).strict()
export const LocalWorkerModeSchema = z
  .object({ mode: z.enum(['pair', 'revoke', 'cloud', 'review']) })
  .strict()

export async function configureLocalWorker(
  bindings: CloudflareBindings,
  provider: string,
  mode: z.infer<typeof LocalWorkerModeSchema>['mode'],
) {
  const plugin = await getScrapePlugin(provider)
  if (!plugin)
    throw new ServerError({ statusCode: 404, message: 'Unknown provider' })
  const dispatch =
    await bindings.PROVIDER_COORDINATORS.getByName(provider).getStatus(provider)
  if (!dispatch?.paused || dispatch.slots.length)
    throw new ServerError({
      statusCode: 409,
      message:
        'Pause the provider and wait for active jobs before changing its worker',
    })
  const worker = bindings.LOCAL_WORKERS.getByName(provider)
  if (mode === 'review') {
    const result = await worker.getReviewResult()
    if (result?.kind === 'response')
      await protectProviderFromLocalResponse(
        plugin,
        result.status,
        new Headers(result.headers),
        result.body,
      )
    if (!(await worker.review()))
      throw new ServerError({
        statusCode: 409,
        message:
          'Wait for the local request execution window to expire before reviewing',
      })
    return { token: null, status: await worker.status() }
  }
  if (mode === 'revoke') {
    await worker.revoke()
    return { token: null, status: await worker.status() }
  }
  if (mode === 'cloud') {
    if (!(await worker.unconfigure()))
      throw new ServerError({
        statusCode: 409,
        message:
          'Local worker has an unresolved request; review it before changing execution mode',
      })
    return { token: null, status: await worker.status() }
  }
  if (
    !plugin.manifest.localWorker ||
    plugin.manifest.rateLimit.concurrentRequests ||
    plugin.manifest.rateLimit.fixedWindow ||
    plugin.manifest.rateLimit.requestBudget?.period === 'day'
  )
    throw new ServerError({
      statusCode: 422,
      message: 'Provider does not support local request execution',
    })
  const token = randomBytes(32).toString('base64url')
  if (!(await worker.configure(plugin.manifest.localWorker, hash(token))))
    throw new ServerError({
      statusCode: 409,
      message: 'Local worker has an active request',
    })
  return { token, status: await worker.status() }
}

export async function localProviderTransport(
  bindings: CloudflareBindings,
  plugin: MediaProviderPlugin,
): Promise<ProviderTransport | null> {
  const worker = bindings.LOCAL_WORKERS.getByName(plugin.manifest.id)
  const status = await worker.status()
  if (!status.configured) return null
  if (!status.online || status.blocked)
    throw new ProviderRequestError(
      'Local worker is offline or requires review; no provider request was sent',
      'request-failed',
      null,
      true,
    )
  const policy = await worker.getPolicy()
  if (!policy) throw new Error('Local worker policy is missing')
  return {
    async execute(url, timing) {
      if (!isLocalWorkerUrlAllowed(url, policy))
        throw new ProviderRequestError(
          'Local worker URL is outside the provider policy',
          'request-failed',
          null,
          true,
        )
      const task = { id: randomUUID(), url, ...timing }
      try {
        await worker.enqueue(task)
        // Never release the central provider lease on a lost client connection.
        // Wait through the entire possible remote execution horizon instead.
        for (;;) {
          const result = await worker.readResult(task.id)
          if (result) {
            await worker.consumeResult(task.id)
            if (result.kind === 'error')
              throw new ProviderRequestError(
                `Local worker request ${result.error}; review before retrying`,
                'request-failed',
                null,
                true,
              )
            return new Response(
              [204, 205, 304].includes(result.status) ? null : result.body,
              { status: result.status, headers: result.headers },
            )
          }
          if (Date.now() >= timing.expiresAt) {
            await worker.expire(task.id)
            throw new ProviderRequestError(
              'Local worker interrupted; request outcome is uncertain. No automatic retry.',
              'request-failed',
              null,
              true,
            )
          }
          await pause(Math.min(250, timing.expiresAt - Date.now()))
        }
      } catch (error) {
        // An RPC can fail after its write committed. Keep the provider lock until
        // even the latest permitted remote request must have stopped.
        if (Date.now() < timing.expiresAt)
          await pause(timing.expiresAt - Date.now())
        await worker.expire(task.id).catch(() => undefined)
        throw error
      }
    },
  }
}

async function readJson(request: Request, limit: number): Promise<unknown> {
  if (Number(request.headers.get('content-length')) > limit)
    throw new RangeError('Request too large')
  const reader = request.body?.getReader()
  if (!reader) return null
  let bytes = 0
  const chunks: Uint8Array[] = []
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > limit) {
        await reader.cancel()
        throw new RangeError('Request too large')
      }
      chunks.push(chunk.value)
    }
    return bytes ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null
  } finally {
    reader.releaseLock()
  }
}

export async function handleLocalWorkerRequest(
  request: Request,
  bindings: CloudflareBindings,
): Promise<Response | null> {
  const path = new URL(request.url).pathname
  const match =
    /^\/api\/v1\/local-worker\/([a-z][a-z0-9-]*)\/(poll|start|result|offline)$/.exec(
      path,
    )
  if (!match) return null
  const provider = match[1]
  const action = match[2]
  const headers = {
    'Cache-Control': 'private, no-store',
    'CDN-Cache-Control': 'no-store',
  }
  const reply = (body: unknown, status = 200) =>
    Response.json(body, { status, headers })
  if (!provider || request.method !== 'POST')
    return reply({ message: 'Not found' }, 404)
  const token = request.headers
    .get('authorization')
    ?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1]
  if (!token) return reply({ message: 'Unauthorized' }, 401)
  const worker = bindings.LOCAL_WORKERS.getByName(provider)
  const tokenHash = hash(token)
  // Authenticate before reading bodies or waking any dispatcher.
  const before = await worker.status()
  if (
    !(action === 'result'
      ? await worker.authorizeResult(tokenHash)
      : await worker.heartbeat(tokenHash))
  )
    return reply({ message: 'Unauthorized' }, 401)
  try {
    if (action === 'poll' || action === 'offline') await readJson(request, 1024)
    if (action === 'offline')
      return reply({ disconnected: await worker.disconnect(tokenHash) })
    if (action === 'result') {
      const result = LocalWorkerResultSchema.parse(
        await readJson(request, LOCAL_RESPONSE_BYTES * 6 + 32768),
      )
      const accepted = await worker.result(tokenHash, result)
      if (accepted && result.kind === 'response')
        await withCloudDatabase(async () => {
          const plugin = await getScrapePlugin(provider)
          if (plugin)
            await protectProviderFromLocalResponse(
              plugin,
              result.status,
              new Headers(result.headers),
              result.body,
            )
        })
      return reply({ accepted }, accepted ? 200 : 409)
    }
    if (!env.SCRAPING_ENABLED)
      return reply({ message: 'Scraping is disabled' }, 409)
    if (before.blocked)
      return reply(
        { message: 'Local request outcome requires owner review' },
        409,
      )
    if (action === 'start') {
      const { id } = IdSchema.parse(await readJson(request, 1024))
      const permit = await worker.confirmStart(tokenHash, id)
      return permit
        ? reply(permit)
        : reply({ message: 'Request permit expired or already consumed' }, 409)
    }
    if (!before.online)
      await bindings.PROVIDER_COORDINATORS.getByName(provider).wake(provider)
    const policy = await worker.getPolicy()
    if (!policy) return reply({ message: 'Worker revoked' }, 401)
    const until = Date.now() + 20000
    for (;;) {
      const task = await worker.take(tokenHash)
      if (task || Date.now() >= until)
        return reply({ serverTime: Date.now(), policy, task })
      if (request.signal.aborted) return reply({ message: 'Disconnected' }, 408)
      await pause(250)
    }
  } catch (error) {
    const invalid =
      error instanceof z.ZodError ||
      error instanceof SyntaxError ||
      error instanceof RangeError
    return reply(
      {
        message: invalid
          ? 'Invalid local worker operation'
          : 'Local worker operation temporarily unavailable',
      },
      invalid ? 422 : 503,
    )
  }
}
