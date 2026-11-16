import { AsyncLocalStorage } from 'node:async_hooks'
import { z } from 'zod'
import { CloudDispatchStatusSchema } from '@repo/schemas/job'
import { ProviderLocalWorkerStatusSchema } from '@repo/schemas/provider'

const ProviderDispatchStatusSchema = z.object({
  dispatch: CloudDispatchStatusSchema.nullable(),
  worker: ProviderLocalWorkerStatusSchema.pick({
    mode: true,
    paired: true,
    online: true,
    blocked: true,
  }).nullable(),
})
export type ProviderDispatchStatus = z.infer<
  typeof ProviderDispatchStatusSchema
>

/**
 * Reads a provider's dispatcher and local worker state. Only the Cloudflare
 * deployment has them; the Node server dispatches in process without pauses.
 */
type ReadDispatchStatus = (provider: string) => Promise<unknown>
const readers = new AsyncLocalStorage<ReadDispatchStatus>()

export function withDispatchStatusReader<T>(
  read: ReadDispatchStatus,
  execute: () => T,
): T {
  return readers.run(read, execute)
}

/** Null when this runtime has no dispatcher state or it could not be read. */
export async function readProviderDispatchStatus(
  provider: string,
): Promise<ProviderDispatchStatus | null> {
  const read = readers.getStore()
  if (!read) return null
  try {
    const status = ProviderDispatchStatusSchema.safeParse(await read(provider))
    return status.success ? status.data : null
  } catch {
    // A status page must not fail because one coordinator is unreachable.
    return null
  }
}
