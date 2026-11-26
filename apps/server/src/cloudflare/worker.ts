import { AsyncLocalStorage } from 'node:async_hooks'
import { z } from 'zod'
// App initialization installs OpenAPI extensions before shared schemas are created.
import app from '@/app'
import {
  CloudDispatchControlSchema,
  CloudDispatchStatusSchema,
} from '@repo/schemas/job'
import {
  PlaybackReleaseResultSchema,
  PlaybackSyncResultSchema,
} from '@repo/schemas/playback'
import { PlaybackDiagnosticsResultSchema } from '@repo/schemas/playback-diagnostics'
import {
  ProviderLocalWorkerControlResultSchema,
  ProviderLocalWorkerControlSchema,
} from '@repo/schemas/provider'
import { env } from '@/env'
import { authMiddleware } from '@/middlewares/auth'
import { generateJsonResponse } from '@/lib/response'
import { logApiRequest, setRequestLogRoute } from '@/lib/request-log'
import { getScrapePlugin, listLoadedScrapePlugins } from '@/plugins/registry'
import { consumeCloudJobMessage } from '@/services/cloud-job-queue'
import { withJobDispatchWakeup } from '@/services/job-dispatch-context'
import { withDispatchStatusReader } from '@/services/dispatch-status'
import { dispatchQueuedImports, executeQueuedImport } from '@/services/imports'
import {
  runDatabaseMaintenance,
  runRecordingOrderMaintenance,
} from './database-maintenance'
import { flushDueLastfmPlays } from '@/services/lastfm-scrobbling'
import { queueDueLastfmSync } from '@/services/lastfm-sync-jobs'
import { queueDueYoutubeSync } from '@/services/youtube-sync-jobs'
import { queueDueSpotifyPodcastSync } from '@/services/spotify-podcast-sync-jobs'
import { queueDueMixStationSync } from '@/services/mix-station-sync-jobs'
import { queueDueSpotifyPlaylistSyncs } from '@/services/spotify-playlist-sync'
import { withCloudQueue } from '@/lib/runtime'
import {
  AI_TEXT_MODEL,
  AI_TRANSCRIPTION_MODEL,
  withWorkersAi,
} from '@/lib/workers-ai'
import { withCloudDatabase } from './db'
import { withProviderTransport } from '@/services/provider-transport'
import { withPlaybackSessions } from '@/services/playback-session-store'
import {
  configureLocalWorker,
  getLocalWorkerStatus,
  handleLocalWorkerRequest,
  localProviderTransport,
} from './local-worker'
export { ProviderCoordinator } from './provider-coordinator'
export { LocalRequestWorker } from './local-worker-coordinator'
export { PlaybackSessionStore } from './playback-session-store'

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
              () =>
                withDispatchStatusReader(async (provider) => {
                  const plugin = await getScrapePlugin(provider)
                  return {
                    dispatch:
                      await bindings.PROVIDER_COORDINATORS.getByName(
                        provider,
                      ).getStatus(provider),
                    worker: plugin?.manifest.localWorker
                      ? await getLocalWorkerStatus(bindings, plugin)
                      : null,
                  }
                }, execute),
            ),
        ),
      ),
  )
}

app.get(
  '/api/v1/cloud/providers/:provider/local-worker',
  authMiddleware({ sessionOnly: true }),
  async (c) => {
    const bindings = workerBindings.getStore()
    if (!bindings) return c.json({ message: 'Local workers unavailable' }, 503)
    const plugin = await getScrapePlugin(c.req.param('provider'))
    if (!plugin) return c.json({ message: 'Unknown provider' }, 404)
    return generateJsonResponse(
      c,
      await getLocalWorkerStatus(bindings, plugin),
      200,
    )
  },
)

app.post(
  '/api/v1/cloud/providers/:provider/local-worker',
  authMiddleware({ sessionOnly: true }),
  async (c) => {
    const input = ProviderLocalWorkerControlSchema.safeParse(
      await c.req.json().catch(() => null),
    )
    if (!input.success)
      return c.json({ message: 'Invalid worker settings' }, 422)
    const bindings = workerBindings.getStore()
    if (!bindings) return c.json({ message: 'Local workers unavailable' }, 503)
    const result = await configureLocalWorker(
      bindings,
      c.req.param('provider'),
      input.data.mode,
    )
    return generateJsonResponse(
      c,
      ProviderLocalWorkerControlResultSchema.parse(result),
      200,
    )
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
    return generateJsonResponse(
      c,
      CloudDispatchStatusSchema.nullable().parse(data),
      200,
    )
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

export const workerBindings = new AsyncLocalStorage<CloudflareBindings>()

export default {
  fetch(request, bindings, ctx?: ExecutionContext) {
    const respond = async () => {
      try {
        assertConfiguration()
        const local = await handleLocalWorkerRequest(request, bindings)
        if (local) {
          setRequestLogRoute(
            '/api/v1/local-worker/:provider/:action',
            request.headers,
          )
          return local
        }
        return await workerBindings.run(bindings, () =>
          withWorkersAi(
            {
              text: (input, signal) =>
                bindings.AI.run(AI_TEXT_MODEL, input, { signal }),
              transcribe: (input, signal) =>
                bindings.AI.run(AI_TRANSCRIPTION_MODEL, input, { signal }),
            },
            () =>
              withPlaybackSessions(
                {
                  canDispatchSonos: async (userId, clientId) =>
                    z
                      .boolean()
                      .parse(
                        await bindings.PLAYBACK_SESSIONS.getByName(
                          userId,
                        ).canDispatchSonos(clientId),
                      ),
                  sync: async (userId, input) =>
                    PlaybackSyncResultSchema.parse(
                      await bindings.PLAYBACK_SESSIONS.getByName(userId).sync(
                        input,
                      ),
                    ),
                  release: async (userId, input) =>
                    PlaybackReleaseResultSchema.parse(
                      await bindings.PLAYBACK_SESSIONS.getByName(
                        userId,
                      ).release(input),
                    ),
                  appendDiagnostics: async (userId, input) =>
                    bindings.PLAYBACK_SESSIONS.getByName(
                      userId,
                    ).appendDiagnostics(input),
                  readDiagnostics: async (userId) =>
                    PlaybackDiagnosticsResultSchema.parse(
                      await bindings.PLAYBACK_SESSIONS.getByName(
                        userId,
                      ).readDiagnostics(),
                    ),
                },
                () => run(bindings, async () => app.fetch(request)),
              ),
          ),
        )
      } catch {
        return Response.json(
          { message: 'Service unavailable' },
          { status: 503, headers: { 'Cache-Control': 'private, no-store' } },
        )
      }
    }
    return logApiRequest(request, respond, () => {
      // Yield the response before opening a separate pool for the refresh.
      ctx?.waitUntil(
        scheduler
          .wait(0)
          .then(() =>
            withCloudDatabase(() => runRecordingOrderMaintenance('browse')),
          )
          .catch(() => undefined),
      )
    })
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
  async scheduled(event, bindings, ctx) {
    ctx.waitUntil(
      run(bindings, () => runDatabaseMaintenance(event.scheduledTime)),
    )
    ctx.waitUntil(
      run(bindings, flushDueLastfmPlays).catch(() => {
        console.error('Last.fm scrobble flush failed.')
      }),
    )
    await run(bindings, async () => {
      await dispatchQueuedImports()
      if (env.SCRAPING_ENABLED) {
        await queueDueLastfmSync()
        await queueDueYoutubeSync()
        await queueDueSpotifyPodcastSync()
        await queueDueMixStationSync()
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
