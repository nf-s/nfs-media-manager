import type { DeviceEntity } from '@repo/schemas/device'
import type { JsonValue } from '@repo/schemas/common'

/**
 * Renders the rows of the device feed (docs/requirements/device-store.md).
 * The feed stores, hashes and numbers what a renderer returns; it never
 * builds a payload itself.
 */
export interface DeviceRowRenderer {
  /**
   * The payload of each given ID that is published now, parsed by the
   * entity's schema in `@repo/schemas/device`. An ID missing from the result
   * has no row: the feed writes a tombstone for it.
   */
  render(
    entity: DeviceEntity,
    ids: readonly string[],
  ): Promise<Map<string, JsonValue>>
  /**
   * IDs of an entity greater than `afterId`, at most `limit`, ascending in
   * the database's default collation: compared and ordered in SQL without a
   * `collate` clause, so a source table's key index serves the page. Every
   * published ID is listed; an ID may be listed that `render` leaves out,
   * where proving it unpublished costs more than rendering it. The sweep
   * walks an entity with it and compares the listed range with
   * `device_row.id`, which has the same collation; no code compares IDs by
   * order in TypeScript. Devices page by `seq` and need no ID order.
   */
  listIds(
    entity: DeviceEntity,
    afterId: string | null,
    limit: number,
  ): Promise<string[]>
}
