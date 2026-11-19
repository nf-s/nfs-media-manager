import { AsyncLocalStorage } from 'node:async_hooks'
import {
  ProviderRequestError,
  type MediaProviderPlugin,
} from '@repo/media-plugin-sdk'
import type { ProviderResponseCapture } from '@repo/schemas/provider-response'

export const LOCAL_WORKER_DISPATCH_WINDOW_MS = 12000

export type PairedProviderResponseCapture = Pick<
  ProviderResponseCapture['response'],
  'body' | 'contentType'
> & { status?: number; representation?: 'adapter' | 'native' }

export interface ProviderTransport {
  execute(
    url: string,
    timing: { dispatchBefore: number; expiresAt: number },
  ): Promise<
    | Response
    | {
        response: Response
        providerResponseCapture: PairedProviderResponseCapture
      }
  >
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
  const transport = (await transports.getStore()?.(plugin)) ?? null
  if (plugin.manifest.localWorkerRequired && !transport)
    throw new ProviderRequestError(
      'Provider requires a paired local worker',
      'request-failed',
      null,
      true,
    )
  return transport
}
