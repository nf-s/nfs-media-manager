import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  formatListeningPeriod,
  formatListeningRule,
  listeningPeriodDraft,
  listeningRuleDraft,
  parseListeningFilterDraft,
  parseListeningPeriodDraft,
} from './listening-filters'

test('listening labels distinguish zero, exact counts, ranges and open bounds', () => {
  const period = listeningPeriodDraft({
    kind: 'rolling',
    amount: 2,
    unit: 'years',
  })
  const parsed = parseListeningPeriodDraft(period)
  assert.ok(parsed.success)
  assert.equal(formatListeningPeriod(parsed.data), 'last 2 years')
  assert.equal(
    formatListeningPeriod({ kind: 'rolling', amount: 1, unit: 'months' }),
    'last 1 month',
  )
  assert.equal(
    formatListeningRule({ period: parsed.data, min: 0, max: 0 }),
    '0 scrobbles · last 2 years',
  )
  assert.equal(
    formatListeningRule({ period: parsed.data, max: 9 }),
    'at most 9 scrobbles · last 2 years',
  )
  assert.equal(
    formatListeningRule({ period: parsed.data, min: 100 }),
    'at least 100 scrobbles · last 2 years',
  )
  assert.equal(
    formatListeningRule({ period: parsed.data, min: 5, max: 10 }),
    '5–10 scrobbles · last 2 years',
  )
})

test('date labels preserve inclusive and open-ended UTC date bounds', () => {
  assert.equal(formatListeningPeriod({ kind: 'all' }), 'all time')
  assert.equal(
    formatListeningPeriod({
      kind: 'dates',
      from: '2020-01-01',
      to: '2020-12-31',
    }),
    '2020-01-01 to 2020-12-31',
  )
  assert.equal(
    formatListeningPeriod({ kind: 'dates', from: '2020-01-01' }),
    'from 2020-01-01',
  )
  assert.equal(
    formatListeningPeriod({ kind: 'dates', to: '2020-12-31' }),
    'through 2020-12-31',
  )
})

test('applying drafts retains multiple independent periods and zero bounds', () => {
  const rules = [
    listeningRuleDraft(
      { period: { kind: 'rolling', amount: 2, unit: 'years' }, max: 0 },
      0,
    ),
    listeningRuleDraft(
      { period: { kind: 'dates', to: '2020-12-31' }, min: 100 },
      1,
    ),
  ]
  const parsed = parseListeningFilterDraft('all', rules)
  assert.ok(parsed.success)
  assert.deepEqual(parsed.data, {
    match: 'all',
    rules: [
      {
        period: { kind: 'rolling', amount: 2, unit: 'years' },
        min: undefined,
        max: 0,
      },
      {
        period: { kind: 'dates', from: undefined, to: '2020-12-31' },
        min: 100,
        max: undefined,
      },
    ],
  })
  assert.equal(parseListeningFilterDraft('any', rules).success, true)
})

test('invalid count and period drafts fail before changing the browse query', () => {
  const rule = listeningRuleDraft(
    { period: { kind: 'rolling', amount: 2, unit: 'years' }, max: 10 },
    0,
  )
  for (const patch of [
    { min: '11' },
    { max: '-1' },
    { max: '0.5' },
    { min: '', max: '' },
    { max: 'not a count' },
  ])
    assert.equal(
      parseListeningFilterDraft('all', [{ ...rule, ...patch }]).success,
      false,
    )
  for (const amount of ['', '0', '-1', '1.5', '1001'])
    assert.equal(
      parseListeningPeriodDraft({ ...rule.period, amount }).success,
      false,
    )
  const dates = listeningPeriodDraft({
    kind: 'dates',
    from: '2020-01-01',
    to: '2020-12-31',
  })
  assert.equal(
    parseListeningPeriodDraft({ ...dates, from: '2021-01-01' }).success,
    false,
  )
  assert.equal(
    parseListeningPeriodDraft({ ...dates, from: '', to: '' }).success,
    false,
  )
})

test('changing period kind does not apply hidden stale bounds', () => {
  const draft = listeningPeriodDraft({
    kind: 'dates',
    from: '2020-01-01',
    to: '2020-12-31',
  })
  assert.deepEqual(parseListeningPeriodDraft({ ...draft, kind: 'all' }), {
    success: true,
    data: { kind: 'all' },
  })
  assert.deepEqual(
    parseListeningPeriodDraft({
      ...draft,
      kind: 'rolling',
      amount: '3',
      unit: 'weeks',
    }),
    { success: true, data: { kind: 'rolling', amount: 3, unit: 'weeks' } },
  )
})
