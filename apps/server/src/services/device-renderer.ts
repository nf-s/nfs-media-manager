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
   * Published IDs of an entity greater than `afterId`, ascending by code
   * point, at most `limit`. The sweep walks an entity with it.
   */
  listIds(
    entity: DeviceEntity,
    afterId: string | null,
    limit: number,
  ): Promise<string[]>
}
