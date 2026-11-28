import { createHash } from 'node:crypto'
import type { JsonValue } from '@repo/schemas/common'
import { DeviceEntitySchema, type DeviceEntity } from '@repo/schemas/device'

/** JSON with every object's keys in code-unit order, so equal payloads give equal text. */
export function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`
  return JSON.stringify(value)
}

/** The hash a device row keeps: a row whose hash is unchanged keeps its `seq`. */
export function deviceRowHash(payload: JsonValue) {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex')
}

export interface DeviceMark {
  key: number
  entity: string
  id: string
}

/**
 * The distinct IDs of each entity in a batch of marks, in the order first
 * marked, and every key read. A mark for an entity this server does not
 * publish is dropped with the others.
 */
export function groupDeviceMarks(marks: readonly DeviceMark[]) {
  const ids = new Map<DeviceEntity, Set<string>>()
  for (const mark of marks) {
    const entity = DeviceEntitySchema.safeParse(mark.entity)
    if (!entity.success) continue
    const entityIds = ids.get(entity.data) ?? new Set<string>()
    entityIds.add(mark.id)
    ids.set(entity.data, entityIds)
  }
  return {
    entities: [...ids].map(([entity, entityIds]) => ({
      entity,
      ids: [...entityIds],
    })),
    keys: marks.map((mark) => mark.key),
  }
}

/** `ids` followed by each expanded ID not already among them. */
export function withExpandedIds(
  ids: readonly string[],
  expanded: readonly string[],
) {
  return [...new Set([...ids, ...expanded])]
}
