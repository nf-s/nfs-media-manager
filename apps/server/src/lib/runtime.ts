import { AsyncLocalStorage } from 'node:async_hooks'

export interface RuntimeQueue {
  send(message: { type: 'import'; importId: string }): Promise<void>
}

const queues = new AsyncLocalStorage<RuntimeQueue>()

export function cloudQueue(): RuntimeQueue | undefined {
  return queues.getStore()
}

export function withCloudQueue<T>(queue: RuntimeQueue, execute: () => T): T {
  return queues.run(queue, execute)
}
