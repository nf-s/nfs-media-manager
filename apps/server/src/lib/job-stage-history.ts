import type { JsonValue } from '@repo/schemas/common'
import { getJobActivityStage } from '@repo/schemas/job'

export function jobActivityEnding(
  options: Record<string, JsonValue>,
  now: Date,
): Record<string, JsonValue> {
  const activity = getJobActivityStage(options)
  return activity
    ? {
        previousActivity: {
          ...activity,
          durationMs: Math.max(
            0,
            now.getTime() - Date.parse(activity.startedAt),
          ),
        },
      }
    : {}
}
