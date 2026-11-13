import type { z } from 'zod'
import {
  AiSearchResponseSchema,
  AiYoutubeSearchResponseSchema,
  type AiMediaLibrary,
  type AiSearchLibrary,
  type AiSearchPlan,
  type AiYoutubePlan,
} from '@repo/schemas/ai-search'
import { formatBrowseValue, type BrowseField } from '@repo/schemas/browse'
import { formatListeningPeriod, formatListeningRule } from './listening-filters'
import { youtubeDurationLabels, youtubeSortLabels } from './youtube'

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

export const youtubeAiSearchTarget: AiSearchTarget<AiYoutubePlan> = {
  mediaType: 'youtube',
  responseSchema: AiYoutubeSearchResponseSchema,
  describe: describeAiYoutubePlan,
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

/** Videos page parameters for a YouTube plan; every search parameter is replaced. */
export function aiYoutubeSearchParams(
  plan: AiYoutubePlan,
): Record<string, string | string[] | null> {
  return {
    q: plan.q || null,
    fields: plan.q && plan.fields === 'title' ? 'title' : null,
    channelId: plan.channels.map((channel) => channel.id),
    duration: plan.duration,
    publishedFrom: plan.publishedFrom,
    publishedTo: plan.publishedTo,
    sortBy: plan.sortBy,
    sortDirection: plan.sortDirection === 'asc' ? 'asc' : null,
    video: null,
  }
}

export function describeAiYoutubePlan(plan: AiYoutubePlan): string[] {
  const descriptions: string[] = []
  if (plan.q)
    descriptions.push(
      `Search: ${plan.q}${plan.fields === 'title' ? ' (titles only)' : ''}`,
    )
  if (plan.channels.length)
    descriptions.push(
      `Channels: ${plan.channels.map((channel) => channel.title).join(', ')}`,
    )
  if (plan.duration)
    descriptions.push(`Duration: ${youtubeDurationLabels[plan.duration]}`)
  if (plan.publishedFrom || plan.publishedTo)
    descriptions.push(
      `Published: ${plan.publishedFrom ?? '*'} to ${plan.publishedTo ?? '*'}`,
    )
  descriptions.push(
    plan.sortBy === 'relevance'
      ? `Sort: ${youtubeSortLabels.relevance}`
      : `Sort: ${youtubeSortLabels[plan.sortBy]}, ${plan.sortDirection === 'asc' ? 'ascending' : 'descending'}`,
  )
  return descriptions
}
