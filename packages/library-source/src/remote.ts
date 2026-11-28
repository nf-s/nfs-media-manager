import { libraryReadPath } from './paths'
import { librarySourceFrom, libraryResponseSchemas } from './reads'
import type { LibrarySource } from './source'

/**
 * Sends a `GET` for an API path (with its query string) and returns the
 * response envelope's `data`. The host supplies the base URL and the
 * credentials; a failed request rejects.
 */
export type RemoteTransport = (path: string) => Promise<unknown>

/**
 * `RemoteLibrarySource`: every read is a request to the API, built as the
 * web client builds it, and its `data` is parsed with the method's response
 * schema. It always serves; transport and schema errors reject.
 */
export function createRemoteLibrarySource(
  transport: RemoteTransport,
): LibrarySource {
  return librarySourceFrom(async (method, query) => {
    const data = await transport(libraryReadPath(method, query))
    return { served: true, data: libraryResponseSchemas[method].parse(data) }
  })
}
