import {
  DEVICE_ROW_VERSION,
  DeviceChangesQuerySchema,
  DeviceSnapshotQuerySchema,
  type DeviceEntity,
  type DeviceRow,
} from '@repo/schemas/device'
import { live, tombstone } from './fixtures'

/**
 * An in-memory server feed that answers the three routes as DEVICE-06 and
 * DEVICE-07 describe: one row per (entity, ID) at its latest `seq`, live
 * rows in snapshots, rows and tombstones in changes, `reset` for another
 * epoch or a `since` below `minSeq`.
 */
export class FakeFeed {
  ready = true
  epoch = 'epoch-1'
  rowVersion = DEVICE_ROW_VERSION
  minSeq = 0
  seq = 0
  readonly requests: string[] = []
  /** Runs before each request is answered, to change rows between pages. */
  beforeRequest: ((path: string) => void) | null = null
  private readonly rows = new Map<string, DeviceRow>()

  put(entity: DeviceEntity, id: string, payload: unknown): void {
    this.seq += 1
    this.rows.set(`${entity}\u0000${id}`, live(entity, id, this.seq, payload))
  }

  remove(entity: DeviceEntity, id: string): void {
    this.seq += 1
    this.rows.set(`${entity}\u0000${id}`, tombstone(entity, id, this.seq))
  }

  /** Rebuilds the feed from nothing: a new epoch with the live rows renumbered. */
  rebuild(epoch: string): void {
    const kept = [...this.rows.values()].filter((row) => !row.deleted)
    this.rows.clear()
    this.epoch = epoch
    this.seq = 0
    for (const row of kept) {
      if (!row.deleted) this.put(row.entity, row.id, row.payload)
    }
    this.minSeq = 0
  }

  readonly transport = (path: string): Promise<unknown> => {
    this.requests.push(path)
    this.beforeRequest?.(path)
    const url = new URL(path, 'http://feed.test')
    const params = Object.fromEntries(url.searchParams)
    const ordered = [...this.rows.values()].sort((a, b) => a.seq - b.seq)
    switch (url.pathname) {
      case '/api/v1/device/state':
        return Promise.resolve({
          ready: this.ready,
          epoch: this.epoch,
          seq: this.seq,
          minSeq: this.minSeq,
          rowVersion: this.rowVersion,
        })
      case '/api/v1/device/snapshot': {
        const query = DeviceSnapshotQuerySchema.parse(params)
        if (query.epoch !== this.epoch) return Promise.resolve({ reset: true })
        const matching = ordered.filter(
          (row) =>
            row.entity === query.entity &&
            !row.deleted &&
            row.seq > query.after,
        )
        const rows = matching.slice(0, query.limit)
        return Promise.resolve({
          reset: false,
          rows,
          seq: rows.at(-1)?.seq ?? query.after,
          hasMore: matching.length > rows.length,
        })
      }
      case '/api/v1/device/changes': {
        const query = DeviceChangesQuerySchema.parse(params)
        if (query.epoch !== this.epoch || query.since < this.minSeq) {
          return Promise.resolve({ reset: true })
        }
        const matching = ordered.filter((row) => row.seq > query.since)
        const rows = matching.slice(0, query.limit)
        return Promise.resolve({
          reset: false,
          rows,
          seq: rows.at(-1)?.seq ?? query.since,
          hasMore: matching.length > rows.length,
          pending: false,
        })
      }
      default:
        return Promise.reject(new Error(`No route for ${path}`))
    }
  }
}
