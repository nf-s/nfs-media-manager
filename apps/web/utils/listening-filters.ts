import { formatCount } from '@repo/ui/lib/format'
import {
  ListeningFilterParamSchema,
  ListeningPeriodParamSchema,
  ListeningPeriodSchema,
  ListeningRuleSchema,
  listeningHistogramEdges,
  type ListeningFilter,
  type ListeningLibrary,
  type ListeningPeriod,
  type ListeningRule,
} from '@repo/schemas/listening'
import { listeningNoun } from '@repo/schemas/listening-display'

export {
  formatListeningFilter,
  formatListeningPeriod,
  formatListeningRule,
  listeningNoun,
  listeningScrobblesField,
  listeningScrobblesKey,
} from '@repo/schemas/listening-display'

export type ListeningView = 'histogram' | 'rules'

/** The listening filter and the period for the Scrobbles column, from the URL. */
export function parseListeningParams(searchParams: {
  get: (name: string) => string | null
}) {
  const filter = ListeningFilterParamSchema.safeParse(
    searchParams.get('listening'),
  )
  const period = ListeningPeriodParamSchema.safeParse(
    searchParams.get('listeningSort'),
  )
  return {
    listening:
      filter.success && filter.data?.rules.length ? filter.data : undefined,
    listeningSort: period.success ? period.data : undefined,
  }
}

const units = ['days', 'weeks', 'months', 'years'] as const
export type ListeningUnit = (typeof units)[number]
export const listeningUnits: readonly ListeningUnit[] = units

/** The periods offered by name. `rolling` and `dates` are entered by hand. */
const presetPeriods = {
  r30d: { kind: 'rolling', amount: 30, unit: 'days' },
  r90d: { kind: 'rolling', amount: 90, unit: 'days' },
  r1y: { kind: 'rolling', amount: 1, unit: 'years' },
  r2y: { kind: 'rolling', amount: 2, unit: 'years' },
  r5y: { kind: 'rolling', amount: 5, unit: 'years' },
  all: { kind: 'all' },
} as const satisfies Record<string, ListeningPeriod>
type PresetPeriod = keyof typeof presetPeriods
const presetKeys: readonly PresetPeriod[] = [
  'r30d',
  'r90d',
  'r1y',
  'r2y',
  'r5y',
  'all',
]

export type ListeningPeriodChoice = PresetPeriod | 'rolling' | 'dates'
export const listeningPeriodChoices: readonly ListeningPeriodChoice[] = [
  'all',
  'r30d',
  'r90d',
  'r1y',
  'r2y',
  'r5y',
  'rolling',
  'dates',
]

export type ListeningPeriodDraft = {
  choice: ListeningPeriodChoice
  amount: string
  unit: ListeningUnit
  from: string
  to: string
}

/** `any` is a condition with no range chosen yet; it filters nothing. */
export const listeningComparisons = [
  'min',
  'max',
  'eq',
  'between',
  'none',
] as const
export type ListeningComparison = (typeof listeningComparisons)[number] | 'any'

export type ListeningConditionDraft = {
  id: number
  comparison: ListeningComparison
  x: string
  y: string
  period: ListeningPeriodDraft
}

export function isListeningUnit(value: string): value is ListeningUnit {
  return units.some((unit) => unit === value)
}
export function isListeningPeriodChoice(
  value: string,
): value is ListeningPeriodChoice {
  return listeningPeriodChoices.some((choice) => choice === value)
}
export function isListeningComparison(
  value: string,
): value is (typeof listeningComparisons)[number] {
  return listeningComparisons.some((comparison) => comparison === value)
}

function presetOf(period: ListeningPeriod): PresetPeriod | undefined {
  return presetKeys.find((key) => {
    const preset = presetPeriods[key]
    if (preset.kind === 'all') return period.kind === 'all'
    return (
      period.kind === 'rolling' &&
      period.amount === preset.amount &&
      period.unit === preset.unit
    )
  })
}

export function listeningPeriodDraft(
  period: ListeningPeriod,
): ListeningPeriodDraft {
  return {
    choice: presetOf(period) ?? (period.kind === 'dates' ? 'dates' : 'rolling'),
    amount: period.kind === 'rolling' ? String(period.amount) : '18',
    unit: period.kind === 'rolling' ? period.unit : 'months',
    from: period.kind === 'dates' ? (period.from ?? '') : '',
    to: period.kind === 'dates' ? (period.to ?? '') : '',
  }
}

/** The period a draft stands for, or nothing while it is incomplete. */
export function listeningPeriodOf(
  draft: ListeningPeriodDraft,
): ListeningPeriod | undefined {
  if (draft.choice !== 'rolling' && draft.choice !== 'dates')
    return presetPeriods[draft.choice]
  const parsed = ListeningPeriodSchema.safeParse(
    draft.choice === 'rolling'
      ? {
          kind: 'rolling',
          amount: draft.amount === '' ? undefined : Number(draft.amount),
          unit: draft.unit,
        }
      : {
          kind: 'dates',
          from: draft.from || undefined,
          to: draft.to || undefined,
        },
  )
  return parsed.success ? parsed.data : undefined
}

export function listeningConditionDraft(
  rule: ListeningRule,
  id: number,
): ListeningConditionDraft {
  const period = listeningPeriodDraft(rule.period)
  const { min, max } = rule
  if (max === 0) return { id, comparison: 'none', x: '10', y: '20', period }
  if (min !== undefined && max !== undefined)
    return min === max
      ? { id, comparison: 'eq', x: String(min), y: String(min + 10), period }
      : { id, comparison: 'between', x: String(min), y: String(max), period }
  if (min !== undefined)
    return {
      id,
      comparison: 'min',
      x: String(min),
      y: String(min + 10),
      period,
    }
  return { id, comparison: 'max', x: String(max ?? 0), y: '20', period }
}

/** A condition with no range yet, as the histogram shows before a bar is chosen. */
export function emptyListeningCondition(
  id: number,
  period: ListeningPeriod,
): ListeningConditionDraft {
  return {
    id,
    comparison: 'any',
    x: '10',
    y: '20',
    period: listeningPeriodDraft(period),
  }
}

function whole(text: string): number | undefined {
  if (text.trim() === '') return undefined
  const value = Number(text)
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/** The rule a draft stands for, or nothing while it is incomplete or `any`. */
export function listeningRuleOf(
  draft: ListeningConditionDraft,
): ListeningRule | undefined {
  const period = listeningPeriodOf(draft.period)
  if (!period || draft.comparison === 'any') return undefined
  if (draft.comparison === 'none') return { period, max: 0 }
  const x = whole(draft.x)
  if (x === undefined) return undefined
  if (draft.comparison === 'min') return { period, min: x }
  if (draft.comparison === 'max') return { period, max: x }
  if (draft.comparison === 'eq') return { period, min: x, max: x }
  const y = whole(draft.y)
  return y === undefined || y < x ? undefined : { period, min: x, max: y }
}

/** The filter the drafts stand for. Incomplete conditions are left out. */
export function listeningFilterOf(
  match: ListeningFilter['match'],
  drafts: readonly ListeningConditionDraft[],
): ListeningFilter | undefined {
  const rules = drafts.flatMap((draft) => {
    const rule = listeningRuleOf(draft)
    return rule && ListeningRuleSchema.safeParse(rule).success ? [rule] : []
  })
  return rules.length ? { match, rules } : undefined
}

function serializePeriod(period: ListeningPeriod) {
  switch (period.kind) {
    case 'all':
      return { kind: period.kind }
    case 'rolling':
      return { kind: period.kind, amount: period.amount, unit: period.unit }
    case 'dates':
      return { kind: period.kind, from: period.from, to: period.to }
  }
}

/** One spelling for a period, whatever order its keys arrived in. */
export function serializeListeningPeriod(period: ListeningPeriod): string {
  return JSON.stringify(serializePeriod(period))
}

/** One spelling for a filter, whatever order its keys arrived in. */
export function serializeListeningFilter(
  filter: ListeningFilter | undefined,
): string {
  if (!filter?.rules.length) return ''
  return JSON.stringify({
    match: filter.match,
    rules: filter.rules.map((rule) => ({
      period: serializePeriod(rule.period),
      min: rule.min,
      max: rule.max,
    })),
  })
}

/* Histogram ------------------------------------------------------------- */

export type ListeningBar = {
  min: number
  /** The last bar has no upper bound. */
  max: number | undefined
  label: string
}

export function listeningBars(library: ListeningLibrary): ListeningBar[] {
  const edges: readonly number[] = listeningHistogramEdges[library]
  return edges.map((edge, index) => {
    const next = edges[index + 1]
    return {
      min: edge,
      max: next === undefined ? undefined : next - 1,
      label: edge === 0 ? '0' : `${formatCount(edge)}+`,
    }
  })
}

export type ListeningBarState = 'selected' | 'partial' | undefined

/** Which bars a rule covers: wholly, partly or not at all. */
export function listeningBarStates(
  bars: readonly ListeningBar[],
  rule: ListeningRule | undefined,
): ListeningBarState[] {
  return bars.map((bar) => {
    if (!rule) return undefined
    const min = rule.min ?? 0
    const inside =
      min <= bar.min &&
      (rule.max === undefined || (bar.max !== undefined && bar.max <= rule.max))
    if (inside) return 'selected'
    const touches =
      (rule.max === undefined || rule.max >= bar.min) &&
      (bar.max === undefined || min <= bar.max)
    return touches ? 'partial' : undefined
  })
}

function withBars(
  draft: ListeningConditionDraft,
  bars: readonly ListeningBar[],
  range: { first: number; last: number } | undefined,
): ListeningConditionDraft {
  const first = range ? bars[range.first] : undefined
  const last = range ? bars[range.last] : undefined
  if (!first || !last) return { ...draft, comparison: 'any' }
  const min = first.min === 0 ? undefined : first.min
  const max = last.max
  if (min === undefined && max === undefined)
    return { ...draft, comparison: 'any' }
  if (min === undefined && max === 0) return { ...draft, comparison: 'none' }
  if (min === undefined) return { ...draft, comparison: 'max', x: String(max) }
  if (max === undefined) return { ...draft, comparison: 'min', x: String(min) }
  if (min === max) return { ...draft, comparison: 'eq', x: String(min) }
  return { ...draft, comparison: 'between', x: String(min), y: String(max) }
}

/**
 * Selecting a bar. With nothing selected, a range off the bar edges, or a
 * bar inside a selected range, the bar becomes the whole range. The only
 * selected bar clears. Any other bar extends the range to reach it.
 */
export function selectListeningBar(
  draft: ListeningConditionDraft,
  bars: readonly ListeningBar[],
  index: number,
): ListeningConditionDraft {
  const states = listeningBarStates(bars, listeningRuleOf(draft))
  const first = states.indexOf('selected')
  const last = states.lastIndexOf('selected')
  if (
    first < 0 ||
    states.includes('partial') ||
    (first !== last && index >= first && index <= last)
  )
    return withBars(draft, bars, { first: index, last: index })
  if (first === last && index === first) return withBars(draft, bars, undefined)
  return withBars(draft, bars, {
    first: Math.min(first, index),
    last: Math.max(last, index),
  })
}

/** The periods on the histogram's switch. Any other period is `custom`. */
export const listeningRanges = ['r30d', 'r1y', 'r5y', 'all', 'custom'] as const
export type ListeningRange = (typeof listeningRanges)[number]

export function listeningRangeOf(draft: ListeningPeriodDraft): ListeningRange {
  return listeningRanges.find((range) => range === draft.choice) ?? 'custom'
}

/** A named period the switch does not carry becomes one entered by hand. */
export function periodForSwitch(
  draft: ListeningPeriodDraft,
): ListeningPeriodDraft {
  if (draft.choice === 'rolling' || draft.choice === 'dates') return draft
  if (listeningRangeOf(draft) !== 'custom') return draft
  const preset = presetPeriods[draft.choice]
  return preset.kind === 'rolling'
    ? {
        ...draft,
        choice: 'rolling',
        amount: String(preset.amount),
        unit: preset.unit,
      }
    : draft
}

/** A period entered by hand that equals a named one shows as the named one. */
export function periodForList(
  draft: ListeningPeriodDraft,
): ListeningPeriodDraft {
  if (draft.choice !== 'rolling') return draft
  const period = listeningPeriodOf(draft)
  const preset = period ? presetOf(period) : undefined
  return preset ? { ...draft, choice: preset } : draft
}

/* Wording --------------------------------------------------------------- */

type Noun = ReturnType<typeof listeningNoun>

/** A bar's range and count in words, for its tooltip and accessible name. */
export function formatListeningBar(
  bar: ListeningBar,
  noun: Noun,
  count: number | undefined,
  items: { one: string; other: string },
): string {
  const range =
    bar.max === undefined
      ? `${formatCount(bar.min)} or more ${noun.other}`
      : bar.min === bar.max
        ? bar.min === 0
          ? `No ${noun.other}`
          : `${formatCount(bar.min)} ${bar.min === 1 ? noun.one : noun.other}`
        : `${formatCount(bar.min)} to ${formatCount(bar.max)} ${noun.other}`
  return count === undefined
    ? range
    : `${range}: ${formatCount(count)} ${count === 1 ? items.one : items.other}`
}
