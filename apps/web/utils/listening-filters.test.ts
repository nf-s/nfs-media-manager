import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ListeningRule } from '@repo/schemas/listening'
import {
  emptyListeningCondition,
  formatListeningBar,
  formatListeningFilter,
  formatListeningPeriod,
  formatListeningRule,
  listeningBarStates,
  listeningBars,
  listeningConditionDraft,
  listeningFilterOf,
  listeningNoun,
  listeningPeriodDraft,
  listeningPeriodOf,
  listeningRangeOf,
  listeningRuleOf,
  listeningScrobblesField,
  parseListeningParams,
  periodForList,
  periodForSwitch,
  selectListeningBar,
  serializeListeningFilter,
} from './listening-filters'

const lastYear = { kind: 'rolling', amount: 1, unit: 'years' } as const
const albumBars = listeningBars('album')
const blank = () => emptyListeningCondition(0, lastYear)

test('a rule reads as a pill and a filter reads as one sentence', () => {
  const twoYears = { kind: 'rolling', amount: 2, unit: 'years' } as const
  assert.equal(
    formatListeningRule({ period: { kind: 'all' }, max: 6 }),
    'At most 6 track plays · all time',
  )
  assert.equal(
    formatListeningRule({ period: twoYears, max: 0 }),
    'No track plays · last 2 years',
  )
  assert.equal(
    formatListeningRule({ period: twoYears, min: 1 }, listeningNoun('track')),
    'At least 1 play · last 2 years',
  )
  assert.equal(
    formatListeningRule({ period: lastYear, min: 5, max: 5 }),
    'Exactly 5 track plays · last year',
  )
  assert.equal(
    formatListeningRule({ period: lastYear, min: 1000, max: 1999 }),
    'Between 1,000 and 1,999 track plays · last year',
  )
  assert.equal(
    formatListeningFilter({
      match: 'all',
      rules: [
        { period: { kind: 'all' }, max: 6 },
        { period: { kind: 'rolling', amount: 90, unit: 'days' }, min: 5 },
      ],
    }),
    'At most 6 track plays in total and at least 5 track plays in the last 90 days.',
  )
  assert.equal(
    formatListeningFilter(
      {
        match: 'any',
        rules: [
          { period: { kind: 'dates', from: '2020-01-01' }, max: 0 },
          {
            period: { kind: 'dates', from: '2019-01-01', to: '2019-12-31' },
            min: 2,
          },
        ],
      },
      listeningNoun('track'),
    ),
    'No plays since 2020-01-01 or at least 2 plays between 2019-01-01 and 2019-12-31.',
  )
})

test('period labels keep inclusive and open-ended UTC date bounds', () => {
  assert.equal(formatListeningPeriod({ kind: 'all' }), 'all time')
  assert.equal(formatListeningPeriod(lastYear), 'last year')
  assert.equal(
    formatListeningPeriod({ kind: 'rolling', amount: 30, unit: 'days' }),
    'last 30 days',
  )
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
  assert.equal(listeningScrobblesField(undefined).label, 'Scrobbles, last year')
})

test('a stored rule opens as the condition that wrote it', () => {
  const rules: ListeningRule[] = [
    { period: { kind: 'all' }, max: 0 },
    { period: lastYear, min: 10 },
    { period: { kind: 'rolling', amount: 18, unit: 'months' }, max: 6 },
    { period: { kind: 'dates', to: '2020-12-31' }, min: 4, max: 4 },
    { period: { kind: 'rolling', amount: 90, unit: 'days' }, min: 10, max: 49 },
  ]
  const drafts = rules.map(listeningConditionDraft)
  assert.deepEqual(
    drafts.map((draft) => [draft.comparison, draft.period.choice]),
    [
      ['none', 'all'],
      ['min', 'r1y'],
      ['max', 'rolling'],
      ['eq', 'dates'],
      ['between', 'r90d'],
    ],
  )
  assert.equal(
    serializeListeningFilter(listeningFilterOf('any', drafts)),
    serializeListeningFilter({ match: 'any', rules }),
  )
})

test('an incomplete condition is left out of the filter, not sent', () => {
  const rule = listeningConditionDraft({ period: lastYear, max: 10 }, 0)
  for (const patch of [
    { x: '' },
    { x: '-1' },
    { x: '0.5' },
    { x: 'ten' },
    { comparison: 'between' as const, x: '11', y: '10' },
    { comparison: 'any' as const },
  ])
    assert.equal(listeningRuleOf({ ...rule, ...patch }), undefined)
  for (const amount of ['', '0', '-1', '1.5', '1001'])
    assert.equal(
      listeningPeriodOf({ ...rule.period, choice: 'rolling', amount }),
      undefined,
    )
  const dates = listeningPeriodDraft({
    kind: 'dates',
    from: '2020-01-01',
    to: '2020-12-31',
  })
  assert.equal(listeningPeriodOf({ ...dates, from: '2021-01-01' }), undefined)
  assert.equal(listeningPeriodOf({ ...dates, from: '', to: '' }), undefined)
  assert.deepEqual(listeningPeriodOf({ ...dates, choice: 'all' }), {
    kind: 'all',
  })
  assert.equal(listeningFilterOf('all', [{ ...rule, x: '' }]), undefined)
  assert.deepEqual(
    listeningFilterOf('all', [rule, { ...rule, id: 1, x: '' }]),
    { match: 'all', rules: [{ period: lastYear, max: 10 }] },
  )
  assert.equal(serializeListeningFilter(undefined), '')
  assert.equal(serializeListeningFilter({ match: 'all', rules: [] }), '')
})

test('the URL gives the filter and the period, and drops what it cannot read', () => {
  const read = (values: Record<string, string>) =>
    parseListeningParams(new URLSearchParams(values))
  assert.deepEqual(
    read({
      listening: JSON.stringify({
        match: 'any',
        rules: [{ period: { kind: 'all' }, max: 0 }],
      }),
      listeningSort: JSON.stringify(lastYear),
    }),
    {
      listening: { match: 'any', rules: [{ period: { kind: 'all' }, max: 0 }] },
      listeningSort: lastYear,
    },
  )
  assert.deepEqual(read({}), {
    listening: undefined,
    listeningSort: undefined,
  })
  assert.deepEqual(
    read({
      listening: JSON.stringify({ match: 'all', rules: [] }),
      listeningSort: 'last year',
    }),
    { listening: undefined, listeningSort: undefined },
  )
})

test('bars follow the library edges and end open', () => {
  assert.deepEqual(
    albumBars.map((bar) => [bar.label, bar.min, bar.max]),
    [
      ['0', 0, 0],
      ['1+', 1, 4],
      ['5+', 5, 9],
      ['10+', 10, 19],
      ['20+', 20, 49],
      ['50+', 50, 99],
      ['100+', 100, 199],
      ['200+', 200, undefined],
    ],
  )
  assert.equal(listeningBars('artist').at(-1)?.label, '1,000+')
  const noun = listeningNoun('album')
  const items = { one: 'album', other: 'albums' }
  assert.deepEqual(
    [0, 1, 7].map((index) => {
      const bar = albumBars[index]
      return bar && formatListeningBar(bar, noun, 1, items)
    }),
    [
      'No track plays: 1 album',
      '1 to 4 track plays: 1 album',
      '200 or more track plays: 1 album',
    ],
  )
})

test('selecting bars sets one bar, extends a range and clears', () => {
  const states = (draft: ReturnType<typeof blank>) =>
    listeningBarStates(albumBars, listeningRuleOf(draft))
      .map((state) =>
        state === 'selected' ? 'x' : state === 'partial' ? '/' : '.',
      )
      .join('')
  let draft = selectListeningBar(blank(), albumBars, 3)
  assert.deepEqual(listeningRuleOf(draft), {
    period: lastYear,
    min: 10,
    max: 19,
  })
  assert.equal(states(draft), '...x....')

  draft = selectListeningBar(draft, albumBars, 5)
  assert.deepEqual(listeningRuleOf(draft), {
    period: lastYear,
    min: 10,
    max: 99,
  })
  assert.equal(states(draft), '...xxx..')

  // A bar inside the range becomes the whole range.
  draft = selectListeningBar(draft, albumBars, 4)
  assert.equal(states(draft), '....x...')
  // The only selected bar clears.
  draft = selectListeningBar(draft, albumBars, 4)
  assert.equal(draft.comparison, 'any')
  assert.equal(listeningRuleOf(draft), undefined)

  // The first bar is "no plays"; the last is open-ended.
  assert.deepEqual(listeningRuleOf(selectListeningBar(blank(), albumBars, 0)), {
    period: lastYear,
    max: 0,
  })
  draft = selectListeningBar(blank(), albumBars, 7)
  assert.deepEqual(listeningRuleOf(draft), { period: lastYear, min: 200 })
  draft = selectListeningBar(draft, albumBars, 6)
  assert.deepEqual(listeningRuleOf(draft), { period: lastYear, min: 100 })
  draft = selectListeningBar(
    selectListeningBar(blank(), albumBars, 0),
    albumBars,
    2,
  )
  assert.deepEqual(listeningRuleOf(draft), { period: lastYear, max: 9 })
  // Every bar is no filter at all.
  draft = selectListeningBar(draft, albumBars, 7)
  assert.equal(draft.comparison, 'any')
})

test('a range off the bar edges keeps its value until a bar is selected', () => {
  const draft = listeningConditionDraft({ period: { kind: 'all' }, max: 6 }, 0)
  assert.deepEqual(listeningBarStates(albumBars, listeningRuleOf(draft)), [
    'selected',
    'selected',
    'partial',
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
  ])
  assert.deepEqual(listeningRuleOf(selectListeningBar(draft, albumBars, 2)), {
    period: { kind: 'all' },
    min: 5,
    max: 9,
  })
})

test('the histogram switch and the rules list name periods their own way', () => {
  const ninetyDays = listeningPeriodDraft({
    kind: 'rolling',
    amount: 90,
    unit: 'days',
  })
  assert.equal(ninetyDays.choice, 'r90d')
  assert.equal(listeningRangeOf(ninetyDays), 'custom')
  const switched = periodForSwitch(ninetyDays)
  assert.deepEqual(
    [switched.choice, switched.amount, switched.unit],
    ['rolling', '90', 'days'],
  )
  assert.equal(periodForList(switched).choice, 'r90d')
  assert.deepEqual(listeningPeriodOf(switched), listeningPeriodOf(ninetyDays))

  const year = listeningPeriodDraft(lastYear)
  assert.equal(listeningRangeOf(year), 'r1y')
  assert.equal(periodForSwitch(year), year)
  const typed = { ...year, choice: 'rolling' as const, amount: '7' }
  assert.equal(periodForList(typed), typed)
})
