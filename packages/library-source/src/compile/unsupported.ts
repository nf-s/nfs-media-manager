import type { UnsupportedReason } from '../source'

/**
 * Thrown while a query is planned, before its rows are read, when the device
 * does not answer it exactly (DEVICE-27). The source turns it into
 * `{ served: false, reason }`.
 */
export class UnsupportedQuery extends Error {
  constructor(readonly reason: UnsupportedReason) {
    super(`The device does not serve this read: ${reason}`)
    this.name = 'UnsupportedQuery'
  }
}

export function unsupported(reason: UnsupportedReason): never {
  throw new UnsupportedQuery(reason)
}
