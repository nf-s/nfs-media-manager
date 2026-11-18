'use client'

import { useState, type ReactNode } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Headphones, Plus, X } from 'lucide-react'
import { Button } from '@repo/ui/components/ui/button'
import { Condition, ConditionLine } from '@repo/ui/components/ds/condition'
import { Section } from '@repo/ui/components/ds/facts'
import { Notice } from '@repo/ui/components/ds/feedback'
import { Histogram } from '@repo/ui/components/ds/histogram'
import { List, ListRow, RowTitle } from '@repo/ui/components/ds/list-row'
import { Segmented } from '@repo/ui/components/ds/segmented'
import { Select } from '@repo/ui/components/ds/toolbar'
import { formatCount } from '@repo/ui/lib/format'
import {
  ListeningHistogramSchema,
  defaultListeningPeriod,
  type ListeningFilter,
  type ListeningLibrary,
  type ListeningPeriod,
} from '@repo/schemas/listening'
import { fetchApiData } from '@/utils/api'
import {
  emptyListeningCondition,
  formatListeningBar,
  formatListeningFilter,
  formatListeningRule,
  isListeningComparison,
  isListeningPeriodChoice,
  isListeningUnit,
  listeningBarStates,
  listeningBars,
  listeningConditionDraft,
  listeningFilterOf,
  listeningNoun,
  listeningPeriodDraft,
  listeningPeriodOf,
  listeningRangeOf,
  listeningRanges,
  listeningRuleOf,
  listeningUnits,
  periodForList,
  periodForSwitch,
  selectListeningBar,
  serializeListeningFilter,
  serializeListeningPeriod,
  type ListeningConditionDraft,
  type ListeningPeriodDraft,
  type ListeningRange,
  type ListeningView,
} from '@/utils/listening-filters'
import { BrowseFilterPill } from './browse-controls'
import { FilterPanelSection } from './browse-filter-panel'
import { DetailLink } from './detail-link'
import { MediaThumb } from './media-artwork'

export type ListeningExample = {
  id: string
  title: string
  by?: ReactNode
  artworkUrl?: string | null
}

type ListeningControlsProps = {
  apiBaseUrl: string
  library: ListeningLibrary
  /** The browse query in force. The histogram counts the items it leaves. */
  params: URLSearchParams
  filter: ListeningFilter | undefined
  sortPeriod: ListeningPeriod | undefined
  /** How many items the browse query returns, listening filter included. */
  total: number | undefined
  examples: readonly ListeningExample[]
  onFilterChange: (filter: ListeningFilter | undefined) => void
  onSortPeriodChange: (period: ListeningPeriod) => void
}

const libraries = {
  album: {
    collection: 'albums',
    item: { one: 'album', other: 'albums' },
    help: 'Track plays are the synced Last.fm scrobbles of each album’s tracks. Dates use UTC.',
  },
  track: {
    collection: 'tracks',
    item: { one: 'track', other: 'tracks' },
    help: 'Plays are the synced Last.fm scrobbles of each track. Dates use UTC.',
  },
  artist: {
    collection: 'artists',
    item: { one: 'artist', other: 'artists' },
    help: 'Track plays are the synced Last.fm scrobbles of each artist’s tracks. Dates use UTC.',
  },
} as const satisfies Record<ListeningLibrary, unknown>

const maxConditions = 10
const viewStorageKey = 'browse:listening-view'

/** The view last used. The section is only drawn in the browser, on demand. */
function storedView(): ListeningView {
  try {
    return window.localStorage.getItem(viewStorageKey) === 'rules'
      ? 'rules'
      : 'histogram'
  } catch {
    return 'histogram'
  }
}
const views: readonly { value: ListeningView; label: string }[] = [
  { value: 'histogram', label: 'Histogram' },
  { value: 'rules', label: 'Rules' },
]
const rangeLabels: Record<ListeningRange, string> = {
  r30d: '30d',
  r1y: '1y',
  r5y: '5y',
  all: 'All',
  custom: 'Custom',
}
const rangeOptions = listeningRanges.map((value) => ({
  value,
  label: rangeLabels[value],
}))
const comparisonLabels = {
  min: 'At least',
  max: 'At most',
  eq: 'Exactly',
  between: 'Between',
  none: 'No',
} as const
const periodLabels = {
  all: 'all time',
  r30d: 'the last 30 days',
  r90d: 'the last 90 days',
  r1y: 'the last year',
  r2y: 'the last 2 years',
  r5y: 'the last 5 years',
  rolling: 'the last…',
  dates: 'a date range…',
} as const
const sortPeriodLabels: Record<ListeningRange, string> = {
  r30d: 'Last 30 days',
  r1y: 'Last year',
  r5y: 'Last 5 years',
  all: 'All time',
  custom: 'Other period…',
}

/**
 * Drafts for a value kept in the URL. A change from outside replaces the
 * drafts; a change the drafts sent keeps them, so a half-typed condition
 * survives the URL catching up.
 */
function useUrlDrafts<Draft>(serialized: string, create: () => Draft) {
  const [state, setState] = useState<{
    seen: string
    pending: readonly string[]
    draft: Draft
  }>(() => ({ seen: serialized, pending: [], draft: create() }))
  let current = state
  if (serialized !== state.seen) {
    const at = state.pending.indexOf(serialized)
    current =
      at >= 0
        ? { ...state, seen: serialized, pending: state.pending.slice(at + 1) }
        : { seen: serialized, pending: [], draft: create() }
    setState(current)
  } else if (state.pending.at(-1) === serialized) {
    current = { ...state, pending: [] }
    setState(current)
  }
  /**
   * Stores the draft. `sent` is the value the draft now stands for, when it
   * stands for one. Returns whether that value is new and should be sent.
   */
  function update(draft: Draft, sent?: string) {
    const last = current.pending.at(-1) ?? current.seen
    const send = sent !== undefined && sent !== last
    setState({
      ...current,
      draft,
      pending: send ? [...current.pending, sent] : current.pending,
    })
    return send
  }
  return [current.draft, update] as const
}

type Editor = {
  match: ListeningFilter['match']
  drafts: readonly ListeningConditionDraft[]
  /** The condition the histogram is editing. */
  editing: number
  nextId: number
}

/** Histogram always has one condition to edit, on a period its switch carries. */
function forHistogram(editor: Editor): Editor {
  const drafts = editor.drafts.length
    ? editor.drafts
    : [emptyListeningCondition(editor.nextId, defaultListeningPeriod)]
  const first = drafts[0]
  const editing =
    drafts.find((draft) => draft.id === editor.editing)?.id ??
    first?.id ??
    editor.nextId
  return {
    ...editor,
    nextId: Math.max(editor.nextId, ...drafts.map((draft) => draft.id + 1)),
    editing,
    drafts: drafts.map((draft) =>
      draft.id === editing
        ? { ...draft, period: periodForSwitch(draft.period) }
        : draft,
    ),
  }
}

/** Rules lists only conditions that say something, on named periods. */
function forRules(editor: Editor): Editor {
  return {
    ...editor,
    drafts: editor.drafts
      .filter((draft) => draft.comparison !== 'any')
      .map((draft) => ({ ...draft, period: periodForList(draft.period) })),
  }
}

const arrange = (editor: Editor, view: ListeningView) =>
  view === 'histogram' ? forHistogram(editor) : forRules(editor)

function editorFrom(filter: ListeningFilter | undefined): Editor {
  const drafts = (filter?.rules ?? []).map(listeningConditionDraft)
  return {
    match: filter?.match ?? 'all',
    drafts,
    editing: 0,
    nextId: drafts.length,
  }
}

function PeriodInputs({
  value,
  onChange,
}: {
  value: ListeningPeriodDraft
  onChange: (value: ListeningPeriodDraft) => void
}) {
  if (value.choice === 'rolling')
    return (
      <>
        <input
          className="ds-input"
          aria-label="Amount"
          type="number"
          min="1"
          max="1000"
          step="1"
          value={value.amount}
          onChange={(event) =>
            onChange({ ...value, amount: event.target.value })
          }
        />
        <Select
          aria-label="Unit"
          value={value.unit}
          onChange={(event) => {
            const unit = event.target.value
            if (isListeningUnit(unit)) onChange({ ...value, unit })
          }}
        >
          {listeningUnits.map((unit) => (
            <option key={unit} value={unit}>
              {unit}
            </option>
          ))}
        </Select>
      </>
    )
  if (value.choice === 'dates')
    return (
      <>
        <input
          className="ds-input"
          aria-label="From"
          type="date"
          value={value.from}
          onChange={(event) => onChange({ ...value, from: event.target.value })}
        />
        <span>to</span>
        <input
          className="ds-input"
          aria-label="Through"
          type="date"
          value={value.to}
          onChange={(event) => onChange({ ...value, to: event.target.value })}
        />
      </>
    )
  return null
}

/** A period entered by hand: in the last so many units, or between dates. */
function CustomPeriod({
  value,
  onChange,
}: {
  value: ListeningPeriodDraft
  onChange: (value: ListeningPeriodDraft) => void
}) {
  return (
    <ConditionLine>
      <Select
        aria-label="Custom period"
        value={value.choice === 'dates' ? 'dates' : 'rolling'}
        onChange={(event) =>
          onChange({
            ...value,
            choice: event.target.value === 'dates' ? 'dates' : 'rolling',
          })
        }
      >
        <option value="rolling">In the last</option>
        <option value="dates">Between dates</option>
      </Select>
      <PeriodInputs value={value} onChange={onChange} />
    </ConditionLine>
  )
}

function SortPeriod({
  period,
  onChange,
}: {
  period: ListeningPeriod | undefined
  onChange: (period: ListeningPeriod) => void
}) {
  const applied = period ?? defaultListeningPeriod
  const [draft, update] = useUrlDrafts(serializeListeningPeriod(applied), () =>
    periodForSwitch(listeningPeriodDraft(applied)),
  )
  function change(next: ListeningPeriodDraft) {
    const value = listeningPeriodOf(next)
    if (update(next, value && serializeListeningPeriod(value)) && value)
      onChange(value)
  }
  const range = listeningRangeOf(draft)
  return (
    <Section>
      <label className="ds-field">
        <span className="ds-label">
          Period for the Scrobbles column and sort
        </span>
        <Select
          className="browse-start"
          value={range}
          onChange={(event) => {
            const value = listeningRanges.find(
              (item) => item === event.target.value,
            )
            if (value)
              change({
                ...draft,
                choice: value === 'custom' ? 'rolling' : value,
              })
          }}
        >
          {listeningRanges.map((value) => (
            <option key={value} value={value}>
              {sortPeriodLabels[value]}
            </option>
          ))}
        </Select>
      </label>
      {range === 'custom' && <CustomPeriod value={draft} onChange={change} />}
      {!listeningPeriodOf(draft) && (
        <p role="alert" className="browse-form-error">
          Enter a valid period.
        </p>
      )}
    </Section>
  )
}

/** The listening filter in the Active filters row: one pill per condition. */
export function ListeningFilterPills({
  library = 'album',
  filter,
  onChange,
}: {
  library?: ListeningLibrary
  filter: ListeningFilter | undefined
  onChange: (filter: ListeningFilter | undefined) => void
}) {
  if (!filter) return null
  const noun = listeningNoun(library)
  const mode = filter.match === 'all' ? 'required' : 'any'
  return (
    <>
      {filter.rules.map((rule, index) => {
        const label = formatListeningRule(rule, noun)
        return (
          <BrowseFilterPill
            key={`listening:${index}`}
            mode={mode}
            removeLabel={`Remove listening condition: ${label}`}
            onRemove={() => {
              const rules = filter.rules.filter((_, at) => at !== index)
              onChange(rules.length ? { ...filter, rules } : undefined)
            }}
          >
            {mode === 'required' ? 'Required' : 'Any'} · {label}
          </BrowseFilterPill>
        )
      })}
    </>
  )
}

export function ListeningControls({
  apiBaseUrl,
  library,
  params,
  filter,
  sortPeriod,
  total,
  examples,
  onFilterChange,
  onSortPeriodChange,
}: ListeningControlsProps) {
  const { collection, item, help } = libraries[library]
  const noun = listeningNoun(library)
  const bars = listeningBars(library)
  const [open, setOpen] = useState(Boolean(filter?.rules.length))
  const [view, setView] = useState(storedView)
  const [editor, update] = useUrlDrafts(serializeListeningFilter(filter), () =>
    arrange(editorFrom(filter), view),
  )

  function change(next: Editor, nextView = view) {
    const arranged = nextView === 'histogram' ? forHistogram(next) : next
    const nextFilter = listeningFilterOf(arranged.match, arranged.drafts)
    if (update(arranged, serializeListeningFilter(nextFilter)))
      onFilterChange(nextFilter)
  }
  function changeDraft(
    id: number,
    patch: (draft: ListeningConditionDraft) => ListeningConditionDraft,
  ) {
    change({
      ...editor,
      drafts: editor.drafts.map((draft) =>
        draft.id === id ? patch(draft) : draft,
      ),
    })
  }
  const changePeriod = (id: number, period: ListeningPeriodDraft) =>
    changeDraft(id, (draft) => ({ ...draft, period }))
  function remove(id: number) {
    change({
      ...editor,
      drafts: editor.drafts.filter((draft) => draft.id !== id),
    })
  }
  function add() {
    const id = editor.nextId
    const added =
      view === 'rules'
        ? listeningConditionDraft(
            { period: defaultListeningPeriod, min: 10 },
            id,
          )
        : emptyListeningCondition(id, { kind: 'all' })
    change({
      ...editor,
      drafts: [...editor.drafts, added],
      editing: id,
      nextId: id + 1,
    })
  }
  function changeView(next: ListeningView) {
    setView(next)
    change(arrange(editor, next), next)
    try {
      window.localStorage.setItem(viewStorageKey, next)
    } catch {
      /* The view still changes when browser storage is unavailable. */
    }
  }

  const current = listeningFilterOf(editor.match, editor.drafts)
  const editing = editor.drafts.find((draft) => draft.id === editor.editing)
  const histogramPeriod =
    (view === 'histogram' && editing
      ? listeningPeriodOf(editing.period)
      : undefined) ?? defaultListeningPeriod
  const histogramParams = new URLSearchParams(params)
  for (const key of ['listening', 'listeningSort', 'sortBy', 'direction'])
    histogramParams.delete(key)
  histogramParams.set('period', serializeListeningPeriod(histogramPeriod))
  const histogram = useQuery({
    queryKey: ['listening-histogram', collection, histogramParams.toString()],
    enabled: open,
    placeholderData: keepPreviousData,
    queryFn: () =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/${collection}/listening-histogram?${histogramParams}`,
        ListeningHistogramSchema,
      ),
  })
  const counts =
    histogram.data?.counts.length === bars.length
      ? histogram.data.counts
      : undefined
  const libraryTotal = counts?.reduce((sum, count) => sum + count, 0)
  const result =
    total === undefined
      ? ''
      : libraryTotal === undefined
        ? formatCount(total)
        : `${formatCount(total)} of ${formatCount(libraryTotal)}`

  return (
    <FilterPanelSection
      title="Listening"
      icon={<Headphones className="ds-i" data-size="sm" aria-hidden />}
      count={filter?.rules.length}
      defaultOpen={open}
      onToggle={setOpen}
    >
      <Section
        title={`Show ${item.other} with`}
        aside={
          <Segmented
            label="View"
            value={view}
            options={views}
            onChange={changeView}
          />
        }
      >
        {editor.drafts.length > 1 && (
          <ConditionLine>
            <span>Match</span>
            <Select
              aria-label="Match"
              value={editor.match}
              onChange={(event) =>
                change({
                  ...editor,
                  match: event.target.value === 'any' ? 'any' : 'all',
                })
              }
            >
              <option value="all">all conditions</option>
              <option value="any">any condition</option>
            </Select>
          </ConditionLine>
        )}
        {view === 'rules' ? (
          editor.drafts.map((draft, index) => (
            <Condition
              key={draft.id}
              role="group"
              aria-label={`Condition ${index + 1}`}
            >
              <ConditionLine>
                <Select
                  aria-label="Comparison"
                  value={draft.comparison}
                  onChange={(event) => {
                    const comparison = event.target.value
                    if (!isListeningComparison(comparison)) return
                    changeDraft(draft.id, (item) => ({
                      ...item,
                      comparison,
                      y:
                        comparison === 'between' &&
                        !(Number(item.y) >= Number(item.x))
                          ? String((Number(item.x) || 0) + 10)
                          : item.y,
                    }))
                  }}
                >
                  {Object.entries(comparisonLabels).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </Select>
                {draft.comparison !== 'none' && (
                  <input
                    className="ds-input"
                    aria-label={
                      draft.comparison === 'between' ? 'Minimum' : 'Number'
                    }
                    type="number"
                    min="0"
                    step="1"
                    value={draft.x}
                    onChange={(event) => {
                      const x = event.target.value
                      changeDraft(draft.id, (item) => ({ ...item, x }))
                    }}
                  />
                )}
                {draft.comparison === 'between' && (
                  <>
                    <span>and</span>
                    <input
                      className="ds-input"
                      aria-label="Maximum"
                      type="number"
                      min="0"
                      step="1"
                      value={draft.y}
                      onChange={(event) => {
                        const y = event.target.value
                        changeDraft(draft.id, (item) => ({ ...item, y }))
                      }}
                    />
                  </>
                )}
                <span>{noun.other}</span>
              </ConditionLine>
              <ConditionLine>
                <span>during</span>
                <Select
                  aria-label="Period"
                  value={draft.period.choice}
                  onChange={(event) => {
                    const choice = event.target.value
                    if (isListeningPeriodChoice(choice))
                      changePeriod(draft.id, { ...draft.period, choice })
                  }}
                >
                  {Object.entries(periodLabels).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </Select>
                <PeriodInputs
                  value={draft.period}
                  onChange={(period) => changePeriod(draft.id, period)}
                />
              </ConditionLine>
              <Button
                type="button"
                variant="ghost"
                onClick={() => remove(draft.id)}
              >
                <X className="ds-i" data-size="sm" aria-hidden /> Remove
              </Button>
              {!listeningRuleOf(draft) && (
                <p role="alert" className="browse-form-error">
                  Enter whole numbers and a valid period.
                </p>
              )}
            </Condition>
          ))
        ) : (
          <div className="browse-conditions">
            {editor.drafts.map((draft, index) => {
              const rule = listeningRuleOf(draft)
              const removeButton = (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  icon
                  aria-label="Remove condition"
                  onClick={() => remove(draft.id)}
                >
                  <X className="ds-i" data-size="sm" aria-hidden />
                </Button>
              )
              if (draft.id !== editor.editing)
                return (
                  <div
                    key={draft.id}
                    className="browse-condition-row"
                    role="group"
                    aria-label={`Condition ${index + 1}`}
                  >
                    <span className="ds-truncate">
                      {rule
                        ? formatListeningRule(rule, noun)
                        : 'No range chosen'}
                    </span>
                    <Button
                      type="button"
                      size="xs"
                      onClick={() => change({ ...editor, editing: draft.id })}
                    >
                      Edit
                    </Button>
                    {removeButton}
                  </div>
                )
              const period = listeningPeriodOf(draft.period)
              const range = listeningRangeOf(draft.period)
              const states = listeningBarStates(bars, rule)
              const shown = period ? counts : bars.map(() => 0)
              return (
                <div
                  key={draft.id}
                  className="browse-condition"
                  role="group"
                  aria-label={`Condition ${index + 1}`}
                >
                  <div className="browse-condition-head">
                    <Segmented
                      label="Period"
                      value={range}
                      options={rangeOptions}
                      onChange={(value) =>
                        changePeriod(draft.id, {
                          ...draft.period,
                          choice: value === 'custom' ? 'rolling' : value,
                        })
                      }
                    />
                    {editor.drafts.length > 1 && removeButton}
                  </div>
                  {range === 'custom' && (
                    <CustomPeriod
                      value={draft.period}
                      onChange={(value) => changePeriod(draft.id, value)}
                    />
                  )}
                  <Histogram
                    label={`Number of ${noun.other}`}
                    bars={bars.map((bar, at) => ({
                      label: bar.label,
                      title: formatListeningBar(bar, noun, shown?.[at], item),
                      state: states[at],
                    }))}
                    counts={shown}
                    onSelect={(at) =>
                      changeDraft(draft.id, (current) =>
                        selectListeningBar(current, bars, at),
                      )
                    }
                  />
                  {!period ? (
                    <p role="alert" className="browse-form-error">
                      Enter a valid period.
                    </p>
                  ) : (
                    !rule && (
                      <p className="ds-help">
                        Select one bar, or a first and last bar, to set a range.
                      </p>
                    )
                  )}
                </div>
              )
            })}
          </div>
        )}
        {histogram.isError && view === 'histogram' && (
          <Notice
            tone="danger"
            action={
              <Button
                type="button"
                size="xs"
                onClick={() => histogram.refetch()}
              >
                Retry
              </Button>
            }
          >
            Could not load the counts.
          </Notice>
        )}
        <Button
          type="button"
          className="browse-start"
          disabled={editor.drafts.length >= maxConditions}
          onClick={add}
        >
          <Plus className="ds-i" data-size="sm" aria-hidden />{' '}
          {view === 'rules' ? 'Add condition' : 'Add period'}
        </Button>
        <p className="ds-help">{help}</p>
      </Section>
      <Section
        title={`Matching ${item.other}`}
        aside={<span className="ds-mono">{result}</span>}
      >
        {current && (
          <>
            <Notice icon={false}>{formatListeningFilter(current, noun)}</Notice>
            {examples.length > 0 ? (
              <List compact aria-label={`Matching ${item.other}`}>
                {examples.map((example) => (
                  <ListRow
                    key={example.id}
                    thumb={
                      <MediaThumb
                        kind={library}
                        src={example.artworkUrl}
                        size={40}
                      />
                    }
                    title={
                      <RowTitle>
                        <DetailLink kind={library} id={example.id}>
                          {example.title}
                        </DetailLink>
                      </RowTitle>
                    }
                    by={example.by}
                  />
                ))}
              </List>
            ) : (
              total === 0 && (
                <p className="ds-help">
                  No example {item.other} match this filter.
                </p>
              )
            )}
            <Button
              type="button"
              variant="ghost"
              className="browse-start"
              onClick={() => change({ ...editor, match: 'all', drafts: [] })}
            >
              Clear listening filter
            </Button>
          </>
        )}
      </Section>
      <SortPeriod period={sortPeriod} onChange={onSortPeriodChange} />
    </FilterPanelSection>
  )
}
