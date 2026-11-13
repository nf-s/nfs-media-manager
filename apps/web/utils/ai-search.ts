import type { z } from 'zod'
import {
  AiSearchResponseSchema,
  AiSubscriptionSearchResponseSchema,
  aiSubscriptionBrowseQuery,
  type AiMediaLibrary,
  type AiSearchLibrary,
  type AiSearchPlan,
  type AiSubscriptionPlan,
} from '@repo/schemas/ai-search'
import { formatBrowseValue, type BrowseField } from '@repo/schemas/browse'
import { subscriptionTypeLabels } from '@repo/schemas/subscriptions'
import { formatListeningPeriod, formatListeningRule } from './listening-filters'
import { subscriptionSortLabels } from './subscriptions'
import { formatVideoDuration } from './youtube'

export type AiSearchResult<Plan> = {
  plan: Plan | null
  explanation: string
  assumptions: string[]
  warnings: string[]
}

/** The library the AI search control searches, how it reads the response and how it lists a plan. */
export type AiSearchTarget<Plan> = {
  mediaType: AiSearchLibrary
  responseSchema: z.ZodType<AiSearchResult<Plan>>
  describe: (plan: Plan) => string[]
}

export function mediaAiSearchTarget(
  mediaType: AiMediaLibrary,
  fields: BrowseField[],
): AiSearchTarget<AiSearchPlan> {
  return {
    mediaType,
    responseSchema: AiSearchResponseSchema,
    describe: (plan) => describeAiSearchPlan(plan, fields),
  }
}

export const subscriptionAiSearchTarget: AiSearchTarget<AiSubscriptionPlan> = {
  mediaType: 'subscription',
  responseSchema: AiSubscriptionSearchResponseSchema,
  describe: describeAiSubscriptionPlan,
}

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

/** Subscriptions browse parameters for a plan; every search parameter is replaced and the drawer closes. */
export function aiSubscriptionSearchParams(
  plan: AiSubscriptionPlan,
): Record<string, string | null> {
  const query = aiSubscriptionBrowseQuery(plan)
  return {
    q: query.q || null,
    fields: query.q && query.fields === 'title' ? 'title' : null,
    filters: query.filters.length ? JSON.stringify(query.filters) : null,
    ranges: query.ranges.length ? JSON.stringify(query.ranges) : null,
    sortBy: query.sortBy,
    direction: query.sortBy === 'relevance' ? null : query.direction,
    item: null,
  }
}

export function describeAiSubscriptionPlan(plan: AiSubscriptionPlan): string[] {
  const descriptions: string[] = []
  if (plan.q)
    descriptions.push(
      `Search: ${plan.q}${plan.fields === 'title' ? ' (titles only)' : ''}`,
    )
  if (plan.sources.length)
    descriptions.push(
      `Channels: ${plan.sources.map((source) => source.title).join(', ')}`,
    )
  const types = [...new Set(plan.types)]
  if (types.length === 1)
    descriptions.push(
      `Type: ${types.map((type) => subscriptionTypeLabels[type]).join(', ')}`,
    )
  if (plan.publishedFrom || plan.publishedTo)
    descriptions.push(
      `Published: ${plan.publishedFrom ?? '*'} to ${plan.publishedTo ?? '*'}`,
    )
  if (plan.durationMinSec !== null || plan.durationMaxSec !== null)
    descriptions.push(
      `Duration: ${plan.durationMinSec === null ? '*' : formatVideoDuration(plan.durationMinSec)} to ${plan.durationMaxSec === null ? '*' : formatVideoDuration(plan.durationMaxSec)}`,
    )
  descriptions.push(
    plan.sortBy === 'relevance'
      ? `Sort: ${subscriptionSortLabels.relevance}`
      : `Sort: ${subscriptionSortLabels[plan.sortBy]}, ${plan.direction === 'asc' ? 'ascending' : 'descending'}`,
  )
  return descriptions
}
