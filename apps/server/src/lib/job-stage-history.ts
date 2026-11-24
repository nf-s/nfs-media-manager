import type { JsonValue } from '@repo/schemas/common'
import { z } from 'zod'

export const storedJobActivitySchema = z.object({
  stage: z.string(),
  done: z.number().int().nonnegative().optional(),
  total: z.number().int().nonnegative().optional(),
  unit: z.string().optional(),
  startedAt: z.iso.datetime(),
})

export function jobActivityOptions(options: Record<string, JsonValue>) {
  const activity = storedJobActivitySchema.safeParse(options.activity)
  return activity.success ? activity.data : undefined
}

export function jobActivityEnding(
  options: Record<string, JsonValue>,
  now: Date,
): Record<string, JsonValue> {
  const activity = jobActivityOptions(options)
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
