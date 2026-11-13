import { AsyncLocalStorage } from 'node:async_hooks'
import { z } from 'zod'
// App initialization installs OpenAPI extensions before shared schemas are created.
import app from '@/app'
import { CloudDispatchControlSchema } from '@repo/schemas/job'
import { env } from '@/env'
import { authMiddleware } from '@/middlewares/auth'
import { getScrapePlugin, listLoadedScrapePlugins } from '@/plugins/registry'
import { consumeCloudJobMessage } from '@/services/cloud-job-queue'
import { withJobDispatchWakeup } from '@/services/job-dispatch-context'
import { dispatchQueuedImports, executeQueuedImport } from '@/services/imports'
import { queueDueLastfmSync } from '@/services/lastfm-sync-jobs'
import { queueDueYoutubeSync } from '@/services/youtube-sync-jobs'
import { queueDueSpotifyPodcastSync } from '@/services/spotify-podcast-sync-jobs'
import { queueDueSpotifyPlaylistSyncs } from '@/services/spotify-playlist-sync'
import { withCloudQueue } from '@/lib/runtime'
import {
  AI_TEXT_MODEL,
  AI_TRANSCRIPTION_MODEL,
  withWorkersAi,
} from '@/lib/workers-ai'
import { withCloudDatabase } from './db'
import { withProviderTransport } from '@/services/provider-transport'
import {
  configureLocalWorker,
  handleLocalWorkerRequest,
  localProviderTransport,
  LocalWorkerModeSchema,
} from './local-worker'
export { ProviderCoordinator } from './provider-coordinator'
export { LocalRequestWorker } from './local-worker-coordinator'

const ImportMessageSchema = z
  .object({ type: z.literal('import'), importId: z.string().min(1) })
  .strict()

function assertConfiguration() {
  if (
    env.NODE_ENV !== 'production' ||
    env.RUNTIME_KIND !== 'cloudflare' ||
    !env.OWNER_EMAIL
  ) {
    throw new Error(
      'Cloud deployment requires production single-owner configuration',
    )
  }
}

function run<T>(
  bindings: CloudflareBindings,
  execute: () => Promise<T>,
): Promise<T> {
  assertConfiguration()
  return withProviderTransport(
    (plugin) => localProviderTransport(bindings, plugin),
    () =>
      withCloudDatabase(() =>
        withCloudQueue(
          {
            send: async (message) => {
              await bindings.SCRAPE_QUEUE.send(message)
            },
          },
          () =>
            withJobDispatchWakeup(
              {
                wake: async (provider) => {
                  if (env.SCRAPING_ENABLED)
                    await bindings.PROVIDER_COORDINATORS.getByName(
                      provider,
                    ).wake(provider)
                },
                resume: async (provider) => {
                  if (env.SCRAPING_ENABLED)
                    await bindings.PROVIDER_COORDINATORS.getByName(
                      provider,
                    ).resume(provider)
                },
              },
              execute,
            ),
        ),
      ),
  )
}

app.get(
  '/api/v1/cloud/providers/:provider/local-worker',
  authMiddleware(),
  async (c) => {
    const bindings = workerBindings.getStore()
    if (!bindings) return c.json({ message: 'Local workers unavailable' }, 503)
    if (!(await getScrapePlugin(c.req.param('provider'))))
      return c.json({ message: 'Unknown provider' }, 404)
    return c.json({
      data: await bindings.LOCAL_WORKERS.getByName(
        c.req.param('provider'),
      ).status(),
    })
  },
)

app.post(
  '/api/v1/cloud/providers/:provider/local-worker',
  authMiddleware(),
  async (c) => {
    const input = LocalWorkerModeSchema.safeParse(
      await c.req.json().catch(() => null),
    )
    if (!input.success)
      return c.json({ message: 'Invalid worker settings' }, 422)
    const bindings = workerBindings.getStore()
    if (!bindings) return c.json({ message: 'Local workers unavailable' }, 503)
    return c.json({
      data: await configureLocalWorker(
        bindings,
        c.req.param('provider'),
        input.data.mode,
      ),
    })
  },
)

// This handler is behind the same owner and origin checks as every private API.
app.get(
  '/api/v1/cloud/providers/:provider/dispatch',
  authMiddleware(),
  async (c) => {
    const provider = c.req.param('provider')
    if (!(await getScrapePlugin(provider)))
      return c.json({ message: 'Unknown provider' }, 404)
    const bindings = workerBindings.getStore()
    if (!bindings) return c.json({ message: 'Dispatcher unavailable' }, 503)
    const data =
      await bindings.PROVIDER_COORDINATORS.getByName(provider).getStatus(
        provider,
      )
    return c.json({ statusCode: 200, data })
  },
)

app.post(
  '/api/v1/cloud/providers/:provider/dispatch',
  authMiddleware(),
  async (c) => {
    const input = CloudDispatchControlSchema.safeParse(
      await c.req.json().catch(() => null),
    )
    if (!input.success)
      return c.json({ message: 'Invalid dispatch settings' }, 422)
    if (!env.SCRAPING_ENABLED && !input.data.paused)
      return c.json(
        { message: 'Scraping is disabled for this deployment' },
        409,
      )
    const provider = c.req.param('provider')
    if (!(await getScrapePlugin(provider)))
      return c.json({ message: 'Unknown provider' }, 404)
    const bindings = workerBindings.getStore()
    if (!bindings) return c.json({ message: 'Dispatcher unavailable' }, 503)
    const updated = await bindings.PROVIDER_COORDINATORS.getByName(
      provider,
    ).setPaused(provider, input.data.paused, input.data.jobIds)
    if (!updated)
      return c.json(
        { message: 'Cannot change job selection while dispatch slots exist' },
        409,
      )
    return c.json({
      statusCode: 200,
      message: 'Dispatch settings updated',
      data: input.data,
    })
  },
)

const workerBindings = new AsyncLocalStorage<CloudflareBindings>()

export default {
  async fetch(request, bindings) {
    try {
      assertConfiguration()
      const local = await handleLocalWorkerRequest(request, bindings)
      if (local) return local
      return await workerBindings.run(bindings, () =>
        withWorkersAi(
          {
            text: (input, signal) =>
              bindings.AI.run(AI_TEXT_MODEL, input, { signal }),
            transcribe: (input, signal) =>
              bindings.AI.run(AI_TRANSCRIPTION_MODEL, input, { signal }),
          },
          () => run(bindings, async () => app.fetch(request)),
        ),
      )
    } catch {
      return Response.json(
        { message: 'Service unavailable' },
        { status: 503, headers: { 'Cache-Control': 'private, no-store' } },
      )
    }
  },
  async queue(batch, bindings) {
    for (const message of batch.messages) {
      try {
        await run(bindings, async () => {
          const task = ImportMessageSchema.safeParse(message.body)
          if (task.success) {
            await executeQueuedImport(task.data.importId)
            message.ack()
          } else {
            await consumeCloudJobMessage(
              message,
              bindings.PROVIDER_COORDINATORS,
            )
          }
        })
      } catch {
        message.retry({ delaySeconds: 60 })
      }
    }
  },
  async scheduled(_event, bindings) {
    await run(bindings, async () => {
      await dispatchQueuedImports()
      if (env.SCRAPING_ENABLED) {
        await queueDueLastfmSync()
        await queueDueYoutubeSync()
        await queueDueSpotifyPodcastSync()
        await queueDueSpotifyPlaylistSyncs()
        for (const plugin of await listLoadedScrapePlugins()) {
          await bindings.PROVIDER_COORDINATORS.getByName(
            plugin.manifest.id,
          ).wake(plugin.manifest.id)
        }
      }
    })
  },
} satisfies ExportedHandler<CloudflareBindings>
