import { z } from 'zod'
import type { StoreError } from './protocol'

/** The feed answered with an HTTP error. */
export class FeedStatusError extends Error {
  constructor(readonly status: number) {
    super(`The feed answered ${status}.`)
  }
}

/** The feed request did not reach the server. */
export class FeedUnreachableError extends Error {}

/** SQLite's primary result codes that name a cause (`sqlite3.h`). */
const SQLITE_CORRUPT = 11
const SQLITE_FULL = 13
const SQLITE_NOTADB = 26

function sqliteCode(error: unknown): number | undefined {
  return error instanceof Error &&
    'resultCode' in error &&
    typeof error.resultCode === 'number'
    ? error.resultCode & 0xff
    : undefined
}

/**
 * What the setting states for a failure in the Worker (DEVICE-42). The
 * exception's text stays in the Worker; `otherwise` names the step that
 * failed when the error itself says nothing more.
 */
export function storeErrorOf(
  error: unknown,
  otherwise: StoreError,
): StoreError {
  if (error instanceof DOMException && error.name === 'QuotaExceededError')
    return 'storage-full'
  const code = sqliteCode(error)
  if (code === SQLITE_FULL) return 'storage-full'
  if (code === SQLITE_CORRUPT || code === SQLITE_NOTADB) return 'unreadable'
  if (error instanceof z.ZodError) return 'version-mismatch'
  if (error instanceof FeedUnreachableError) return 'unreachable'
  if (error instanceof FeedStatusError)
    return error.status >= 500 ? 'unreachable' : 'failed'
  return otherwise
}
