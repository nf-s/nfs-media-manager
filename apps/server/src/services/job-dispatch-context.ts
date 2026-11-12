import { AsyncLocalStorage } from 'node:async_hooks'

interface JobDispatchHooks {
  wake(provider: string): Promise<void>
  /** Clears a safety stop after the owner explicitly restarts work. */
  resume(provider: string): Promise<void>
}
const dispatch = new AsyncLocalStorage<JobDispatchHooks>()

export function withJobDispatchWakeup<T>(
  hooks: JobDispatchHooks,
  callback: () => T,
): T {
  return dispatch.run(hooks, callback)
}

export async function wakeJobProvider(provider: string): Promise<void> {
  await dispatch.getStore()?.wake(provider)
}

export async function resumeJobProvider(provider: string): Promise<void> {
  await dispatch.getStore()?.resume(provider)
}
