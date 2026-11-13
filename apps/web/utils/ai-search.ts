import type { AiSearchPlan } from '@repo/schemas/ai-search'
import { formatBrowseValue, type BrowseField } from '@repo/schemas/browse'
import { formatListeningPeriod, formatListeningRule } from './listening-filters'

export function aiSearchParams(
  plan: AiSearchPlan,
): Record<string, string | null> {
  return {
    q: plan.q || null,
    filters: plan.filters.length ? JSON.stringify(plan.filters) : null,
    ranges: plan.ranges.length ? JSON.stringify(plan.ranges) : null,
    listening: plan.listening ? JSON.stringify(plan.listening) : null,
    listeningSort: plan.listeningSort
      ? JSON.stringify(plan.listeningSort)
      : null,
    sortBy: plan.sortBy,
    direction: plan.direction,
    limitResults: plan.limitResults === null ? null : String(plan.limitResults),
    item: null,
  }
}

export function describeAiSearchPlan(
  plan: AiSearchPlan,
  fields: BrowseField[],
): string[] {
  const descriptions: string[] = []
  if (plan.q) descriptions.push(`Search: ${plan.q}`)
  for (const filter of plan.filters) {
    const mode =
      filter.mode === 'required'
        ? 'Required'
        : filter.mode === 'exclude'
          ? 'Exclude'
          : 'Any'
    const label =
      fields.find((field) => field.key === filter.field)?.label ?? filter.field
    descriptions.push(`${mode} · ${label}: ${filter.value}`)
  }
  for (const range of plan.ranges) {
    const field = fields.find((field) => field.key === range.field)
    const display = (value: number) =>
      field ? formatBrowseValue(field, value) : String(value)
    const bounds = [
      range.min === undefined ? '' : `at least ${display(range.min)}`,
      range.max === undefined ? '' : `at most ${display(range.max)}`,
    ]
      .filter(Boolean)
      .join(', ')
    descriptions.push(
      `${field?.label ?? range.field}: ${bounds || 'has a value'}${range.includeMissing ? ' (including missing values)' : ''}`,
    )
  }
  if (plan.listening?.rules.length) {
    descriptions.push(
      `Listening · ${plan.listening.match === 'all' ? 'all rules' : 'any rule'}: ${plan.listening.rules.map(formatListeningRule).join('; ')}`,
    )
  }
  const sort =
    plan.sortBy === 'listeningScrobbles' && plan.listeningSort
      ? `Scrobbles · ${formatListeningPeriod(plan.listeningSort)}`
      : (fields.find((field) => field.key === plan.sortBy)?.label ??
        plan.sortBy)
  descriptions.push(
    `Sort: ${sort}, ${plan.direction === 'asc' ? 'ascending' : 'descending'}`,
  )
  if (plan.limitResults !== null)
    descriptions.push(`Limit: ${plan.limitResults} results`)
  return descriptions
}
