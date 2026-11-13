import {
  ListeningFilterSchema,
  ListeningPeriodSchema,
  type ListeningPeriod,
  type ListeningRule,
} from '@repo/schemas/listening'

export type ListeningPeriodDraft = {
  kind: ListeningPeriod['kind']
  amount: string
  unit: 'days' | 'weeks' | 'months' | 'years'
  from: string
  to: string
}

export type ListeningRuleDraft = {
  id: number
  period: ListeningPeriodDraft
  min: string
  max: string
}

export function listeningPeriodDraft(
  period: ListeningPeriod,
): ListeningPeriodDraft {
  return {
    kind: period.kind,
    amount: period.kind === 'rolling' ? String(period.amount) : '2',
    unit: period.kind === 'rolling' ? period.unit : 'years',
    from: period.kind === 'dates' ? (period.from ?? '') : '',
    to: period.kind === 'dates' ? (period.to ?? '') : '',
  }
}

export function listeningRuleDraft(
  rule: ListeningRule,
  id: number,
): ListeningRuleDraft {
  return {
    id,
    period: listeningPeriodDraft(rule.period),
    min: rule.min === undefined ? '' : String(rule.min),
    max: rule.max === undefined ? '' : String(rule.max),
  }
}

function periodInput(draft: ListeningPeriodDraft) {
  switch (draft.kind) {
    case 'all':
      return { kind: draft.kind }
    case 'rolling':
      return {
        kind: draft.kind,
        amount: Number(draft.amount),
        unit: draft.unit,
      }
    case 'dates':
      return {
        kind: draft.kind,
        from: draft.from || undefined,
        to: draft.to || undefined,
      }
  }
}

export function parseListeningPeriodDraft(draft: ListeningPeriodDraft) {
  return ListeningPeriodSchema.safeParse(periodInput(draft))
}

export function parseListeningFilterDraft(
  match: 'all' | 'any',
  rules: ListeningRuleDraft[],
) {
  return ListeningFilterSchema.safeParse({
    match,
    rules: rules.map((rule) => ({
      period: periodInput(rule.period),
      min: rule.min === '' ? undefined : Number(rule.min),
      max: rule.max === '' ? undefined : Number(rule.max),
    })),
  })
}

export function formatListeningPeriod(period: ListeningPeriod): string {
  switch (period.kind) {
    case 'all':
      return 'all time'
    case 'rolling':
      return `last ${period.amount} ${period.amount === 1 ? period.unit.slice(0, -1) : period.unit}`
    case 'dates':
      if (period.from && period.to) return `${period.from} to ${period.to}`
      return period.from ? `from ${period.from}` : `through ${period.to}`
  }
}

export function formatListeningRule(rule: ListeningRule): string {
  const count =
    rule.min !== undefined && rule.max !== undefined
      ? rule.min === rule.max
        ? `${rule.min}`
        : `${rule.min}–${rule.max}`
      : rule.min !== undefined
        ? `at least ${rule.min}`
        : `at most ${rule.max}`
  return `${count} scrobbles · ${formatListeningPeriod(rule.period)}`
}
