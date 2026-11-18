import { DurableObject } from 'cloudflare:workers'
import type { ProviderLocalWorkerMode } from '@repo/schemas/provider'
import { env } from '@/env'
import { withCloudDatabase } from '@/cloudflare/db'
import { providerJobQueue } from '@/cloudflare/job-queues'
import { CloudJobCoordinator } from '@/services/cloud-job-coordinator'
import type {
  CloudJobMessage,
  CloudJobOutcome,
} from '@/services/cloud-job-contract'
import {
  cloudProviderStartsPaused,
  getCloudProviderDispatchPolicy,
  listCloudQueuedJobIds,
  recoverCloudJobById,
} from '@/services/cloud-job-store'
import { getScrapePlugin } from '@/plugins/registry'
import { getLocalWorkerStatus, localWorkerBlocksDispatch } from './local-worker'

async function workerBlocksDispatch(
  bindings: CloudflareBindings,
  provider: string,
) {
  const plugin = await getScrapePlugin(provider)
  if (!plugin) return true
  return localWorkerBlocksDispatch(await getLocalWorkerStatus(bindings, plugin))
}

export class ProviderCoordinator extends DurableObject<CloudflareBindings> {
  private readonly coordinator: CloudJobCoordinator

  constructor(ctx: DurableObjectState, bindings: CloudflareBindings) {
    super(ctx, bindings)
    this.coordinator = new CloudJobCoordinator({
      storage: {
        load: () => ctx.storage.get('provider-dispatch'),
        save: (state, alarmAt) =>
          ctx.storage.transaction(async (tx) => {
            await tx.put('provider-dispatch', state)
            if (alarmAt === null) await tx.deleteAlarm()
            else await tx.setAlarm(alarmAt)
          }),
      },
      send: async (message) => {
        await providerJobQueue(bindings, message.provider).send(message)
      },
      policy: async (provider) => {
        if (
          !env.SCRAPING_ENABLED ||
          (await workerBlocksDispatch(bindings, provider))
        )
          return { maxConcurrent: 1, blocked: true, wakeAt: null }
        return getCloudProviderDispatchPolicy(provider)
      },
      queued: listCloudQueuedJobIds,
      recover: recoverCloudJobById,
      initiallyPaused: cloudProviderStartsPaused,
    })
  }

  wake(provider: string): Promise<void> {
    return this.coordinator.wake(provider)
  }

  resume(provider: string): Promise<void> {
    return this.coordinator.resume(provider)
  }

  getStatus(provider: string) {
    return this.coordinator.getStatus(provider)
  }

  setPaused(
    provider: string,
    paused: boolean,
    jobIds?: string[] | null,
  ): Promise<boolean> {
    return this.coordinator.setPaused(provider, paused, jobIds)
  }

  setWorkerMode(provider: string, mode: ProviderLocalWorkerMode) {
    return this.coordinator.runWhilePausedAndIdle(provider, () =>
      this.env.LOCAL_WORKERS.getByName(provider).setMode(mode),
    )
  }

  async begin(message: CloudJobMessage): Promise<boolean> {
    if (!env.SCRAPING_ENABLED) return Promise.resolve(false)
    if (await workerBlocksDispatch(this.env, message.provider)) return false
    return this.coordinator.begin(message)
  }

  isActive(message: CloudJobMessage): Promise<boolean> {
    if (!env.SCRAPING_ENABLED) return Promise.resolve(false)
    return this.coordinator.isActive(message)
  }

  recordOutcome(
    message: CloudJobMessage,
    outcome: CloudJobOutcome,
  ): Promise<void> {
    return this.coordinator.recordOutcome(message, outcome)
  }

  finish(message: CloudJobMessage): Promise<void> {
    return this.coordinator.finish(message)
  }

  alarm(): Promise<void> {
    return withCloudDatabase(() => this.coordinator.alarm())
  }
}
