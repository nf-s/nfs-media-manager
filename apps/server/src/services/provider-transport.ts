import { AsyncLocalStorage } from 'node:async_hooks'
import type { MediaProviderPlugin } from '@repo/media-plugin-sdk'

export interface ProviderTransport {
  execute(
    url: string,
    timing: { dispatchBefore: number; expiresAt: number },
  ): Promise<Response>
}
type ResolveTransport = (
  plugin: MediaProviderPlugin,
) => Promise<ProviderTransport | null>
const transports = new AsyncLocalStorage<ResolveTransport>()

export function withProviderTransport<T>(
  resolve: ResolveTransport,
  execute: () => T,
): T {
  return transports.run(resolve, execute)
}

export async function getProviderTransport(
  plugin: MediaProviderPlugin,
): Promise<ProviderTransport | null> {
  return (await transports.getStore()?.(plugin)) ?? null
}
