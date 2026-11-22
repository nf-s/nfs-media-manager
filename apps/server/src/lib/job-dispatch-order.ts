import { sql, type AnyColumn } from 'drizzle-orm'

/**
 * A provider's queued jobs run highest `options.dispatchPriority` first
 * (0 when unset), then oldest first, so work someone is waiting on is not
 * stuck behind a bulk run. Jobs without a priority keep their order.
 */
export const dispatchPriorityOrder = (options: AnyColumn) => sql`case
  when ${options}->>'dispatchPriority' ~ '^[0-9]{1,3}$'
  then (${options}->>'dispatchPriority')::int else 0 end desc`
