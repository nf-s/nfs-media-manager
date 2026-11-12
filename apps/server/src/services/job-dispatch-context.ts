import { AsyncLocalStorage } from 'node:async_hooks'

type WakeProvider = (provider: string) => Promise<void>
const dispatch = new AsyncLocalStorage<WakeProvider>()

export function withJobDispatchWakeup<T>(
  wake: WakeProvider,
  callback: () => T,
): T {
  return dispatch.run(wake, callback)
}

export async function wakeJobProvider(provider: string): Promise<void> {
  await dispatch.getStore()?.(provider)
}
