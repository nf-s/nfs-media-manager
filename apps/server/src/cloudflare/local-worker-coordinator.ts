import { DurableObject } from 'cloudflare:workers'
import { z } from 'zod'
import type {
  LocalWorkerPolicy,
  LocalWorkerTask,
  LocalWorkerResult,
} from '@repo/media-plugin-sdk/local-worker'
import { LocalWorkerCoordinator } from '@/services/local-worker-coordinator'

export class LocalRequestWorker extends DurableObject<CloudflareBindings> {
  private readonly worker: LocalWorkerCoordinator

  constructor(ctx: DurableObjectState, bindings: CloudflareBindings) {
    super(ctx, bindings)
    this.worker = new LocalWorkerCoordinator({
      storage: {
        load: async () => {
          const count = await ctx.storage.get('state-parts')
          if (count === undefined) return undefined
          const parts = z.number().int().min(1).max(1024).parse(count)
          let json = ''
          for (let index = 0; index < parts; index++)
            json += z.string().parse(await ctx.storage.get(`state-${index}`))
          return JSON.parse(json)
        },
        save: async (state) => {
          const json = JSON.stringify(state)
          const parts = Math.ceil(json.length / 16000)
          await ctx.storage.transaction(async (tx) => {
            const previous = z
              .number()
              .int()
              .nonnegative()
              .max(1024)
              .parse((await tx.get('state-parts')) ?? 0)
            for (let index = 0; index < parts; index++)
              await tx.put(
                `state-${index}`,
                json.slice(index * 16000, (index + 1) * 16000),
              )
            for (let index = parts; index < previous; index++)
              await tx.delete(`state-${index}`)
            await tx.put('state-parts', parts)
          })
        },
      },
    })
  }

  configure(policy: LocalWorkerPolicy, tokenHash: string) {
    return this.worker.configure(policy, tokenHash)
  }
  revoke() {
    return this.worker.revoke()
  }
  review() {
    return this.worker.review()
  }
  getReviewResult() {
    return this.worker.getReviewResult()
  }
  authorizeResult(hash: string) {
    return this.worker.authorizeResult(hash)
  }
  unconfigure() {
    return this.worker.unconfigure()
  }
  status() {
    return this.worker.status()
  }
  getPolicy() {
    return this.worker.getPolicy()
  }
  heartbeat(tokenHash: string) {
    return this.worker.heartbeat(tokenHash)
  }
  disconnect(tokenHash: string) {
    return this.worker.disconnect(tokenHash)
  }
  take(tokenHash: string) {
    return this.worker.take(tokenHash)
  }
  confirmStart(tokenHash: string, id: string) {
    return this.worker.confirmStart(tokenHash, id)
  }
  enqueue(task: LocalWorkerTask) {
    return this.worker.enqueue(task)
  }
  result(tokenHash: string, result: LocalWorkerResult) {
    return this.worker.result(tokenHash, result)
  }
  readResult(id: string) {
    return this.worker.readResult(id)
  }
  expire(id: string) {
    return this.worker.expire(id)
  }
  consumeResult(id: string) {
    return this.worker.consumeResult(id)
  }
}
