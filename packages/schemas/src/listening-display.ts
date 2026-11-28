import type { BrowseField } from './browse'
import {
  defaultListeningPeriod,
  type ListeningFilter,
  type ListeningLibrary,
  type ListeningPeriod,
  type ListeningRule,
} from './listening'
import { formatCount } from './value-format'

/** The sort key and column for scrobbles in the chosen period. */
export const listeningScrobblesKey = 'listeningScrobbles'

/** The Scrobbles column and sort for a period, named with the period. */
export function listeningScrobblesField(
  period: ListeningPeriod | undefined,
): BrowseField {
  return {
    key: listeningScrobblesKey,
    label: `Scrobbles, ${formatListeningPeriod(period ?? defaultListeningPeriod)}`,
    type: 'number',
    filterable: false,
  }
}

/** What a library counts: an album's or artist's track plays, a track's plays. */
export function listeningNoun(library: ListeningLibrary) {
  return library === 'track'
    ? { one: 'play', other: 'plays' }
    : { one: 'track play', other: 'track plays' }
}
type Noun = ReturnType<typeof listeningNoun>
const trackPlays = listeningNoun('album')

export function formatListeningPeriod(period: ListeningPeriod): string {
  switch (period.kind) {
    case 'all':
      return 'all time'
    case 'rolling':
      return period.amount === 1
        ? `last ${period.unit.slice(0, -1)}`
        : `last ${period.amount} ${period.unit}`
    case 'dates':
      if (period.from && period.to) return `${period.from} to ${period.to}`
      return period.from ? `from ${period.from}` : `through ${period.to}`
  }
}

function during(period: ListeningPeriod): string {
  switch (period.kind) {
    case 'all':
      return 'in total'
    case 'rolling':
      return `in the ${formatListeningPeriod(period)}`
    case 'dates':
      if (period.from && period.to)
        return `between ${period.from} and ${period.to}`
      return period.from ? `since ${period.from}` : `up to ${period.to}`
  }
}

function clause(rule: ListeningRule, noun: Noun): string {
  const plays = (count: number) =>
    `${formatCount(count)} ${count === 1 ? noun.one : noun.other}`
  const { min, max } = rule
  if (max === 0) return `no ${noun.other}`
  if (min !== undefined && max !== undefined)
    return min === max
      ? `exactly ${plays(min)}`
      : `between ${formatCount(min)} and ${plays(max)}`
  if (min !== undefined) return `at least ${plays(min)}`
  return `at most ${plays(max ?? 0)}`
}

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

/** A rule as its filter pill reads: `At most 6 track plays · all time`. */
export function formatListeningRule(
  rule: ListeningRule,
  noun: Noun = trackPlays,
): string {
  return `${capital(clause(rule, noun))} · ${formatListeningPeriod(rule.period)}`
}

/** The whole filter as one sentence. */
export function formatListeningFilter(
  filter: ListeningFilter,
  noun: Noun = trackPlays,
): string {
  const joined = filter.rules
    .map((rule) => `${clause(rule, noun)} ${during(rule.period)}`)
    .join(filter.match === 'all' ? ' and ' : ' or ')
  return `${capital(joined)}.`
}
