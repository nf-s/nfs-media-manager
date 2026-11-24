import type { JobActivityStage } from '@repo/schemas/job'
import { formatCount } from '@repo/ui/lib/format'

export function jobActivityCount({
  done,
  total,
  unit,
}: JobActivityStage): string | null {
  const quantity = unit ? ` ${unit}` : ''
  if (done === undefined)
    return total === undefined ? null : `${formatCount(total)}${quantity} total`
  if (total === undefined) return `${formatCount(done)}${quantity}`
  return `${formatCount(done)} of ${formatCount(total)}${quantity}`
}

export function jobActivityLabel(activity: JobActivityStage): string {
  const count = jobActivityCount(activity)
  return count ? `${activity.stage} · ${count}` : activity.stage
}
