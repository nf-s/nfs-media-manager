import { librarySourceFrom, readSource } from './reads'
import type {
  LibraryMethod,
  LibrarySource,
  SourceResult,
  UnsupportedReason,
} from './source'

/** Which source answered one read (DEVICE-46), reported once the answer is in. */
export type LibraryReadReport = {
  method: LibraryMethod
  source: 'device' | 'remote'
  /** Why the device did not answer: present when `source` is `remote`. */
  reason?: UnsupportedReason
  /** From the call to the answer, the device's attempt included. */
  durationMs: number
}

export type FallbackSourceOptions = {
  onRead?: (report: LibraryReadReport) => void
  /** Milliseconds for `durationMs`; `performance.now` by default. */
  now?: () => number
}

/** The device's answer; a rejected device read is a store error, as DEVICE-40 sends any store error to the API. */
async function attempt<T>(
  read: () => Promise<SourceResult<T>>,
): Promise<SourceResult<T>> {
  try {
    return await read()
  } catch {
    return { served: false, reason: 'store-error' }
  }
}

/**
 * Asks `primary` (the device) first and `secondary` (the API) when the
 * device does not serve the read, `store-error` included. A rejection from
 * `secondary` propagates and is not reported.
 */
export function createFallbackLibrarySource(
  primary: LibrarySource,
  secondary: LibrarySource,
  options: FallbackSourceOptions = {},
): LibrarySource {
  const now = options.now ?? (() => performance.now())
  return librarySourceFrom(async (method, query) => {
    const startedAt = now()
    const first = await attempt(() => readSource(primary, method, query))
    if (first.served) {
      options.onRead?.({
        method,
        source: 'device',
        durationMs: now() - startedAt,
      })
      return first
    }
    const second = await readSource(secondary, method, query)
    options.onRead?.({
      method,
      source: 'remote',
      reason: first.reason,
      durationMs: now() - startedAt,
    })
    return second
  })
}
