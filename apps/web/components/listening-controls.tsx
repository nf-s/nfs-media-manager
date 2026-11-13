'use client'

import { useState } from 'react'
import { Headphones, Plus, X } from 'lucide-react'
import { Button } from '@repo/ui/components/ui/button'
import { FilterPanelSection } from './browse-filter-panel'
import {
  defaultListeningPeriod,
  type ListeningFilter,
  type ListeningPeriod,
  type ListeningRule,
} from '@repo/schemas/listening'
import {
  listeningPeriodDraft,
  listeningRuleDraft,
  parseListeningFilterDraft,
  parseListeningPeriodDraft,
  type ListeningPeriodDraft,
} from '@/utils/listening-filters'

type ListeningControlsProps = {
  presentation?: 'popover' | 'panel'
  filter: ListeningFilter | undefined
  sortPeriod: ListeningPeriod | undefined
  sorting: boolean
  onFilterChange: (filter: ListeningFilter | undefined) => void
  onSortChange: (period: ListeningPeriod) => void
}

const countBounds: Array<'min' | 'max'> = ['min', 'max']
const initialRule: ListeningRule = {
  period: { kind: 'rolling', amount: 2, unit: 'years' },
  max: 10,
}

function PeriodInputs({
  value,
  label,
  onChange,
}: {
  value: ListeningPeriodDraft
  label: string
  onChange: (value: ListeningPeriodDraft) => void
}) {
  return (
    <div className="grid gap-2">
      <label>
        Period
        <select
          aria-label={`${label} period`}
          value={value.kind}
          onChange={(event) => {
            const kind = event.target.value
            if (kind === 'all' || kind === 'rolling' || kind === 'dates')
              onChange({ ...value, kind })
          }}
        >
          <option value="rolling">In the last</option>
          <option value="dates">Date range</option>
          <option value="all">All time</option>
        </select>
      </label>
      {value.kind === 'rolling' && (
        <div className="range-inputs">
          <label>
            Amount
            <input
              aria-label={`${label} period amount`}
              type="number"
              min="1"
              max="1000"
              step="1"
              required
              value={value.amount}
              onChange={(event) =>
                onChange({ ...value, amount: event.target.value })
              }
            />
          </label>
          <label>
            Unit
            <select
              aria-label={`${label} period unit`}
              value={value.unit}
              onChange={(event) => {
                const unit = event.target.value
                if (
                  unit === 'days' ||
                  unit === 'weeks' ||
                  unit === 'months' ||
                  unit === 'years'
                )
                  onChange({ ...value, unit })
              }}
            >
              <option value="days">Days</option>
              <option value="weeks">Weeks</option>
              <option value="months">Months</option>
              <option value="years">Years</option>
            </select>
          </label>
        </div>
      )}
      {value.kind === 'dates' && (
        <div className="range-inputs">
          <label>
            From
            <input
              aria-label={`${label} from date`}
              type="date"
              value={value.from}
              onChange={(event) =>
                onChange({ ...value, from: event.target.value })
              }
            />
          </label>
          <label>
            Through
            <input
              aria-label={`${label} through date`}
              type="date"
              value={value.to}
              onChange={(event) =>
                onChange({ ...value, to: event.target.value })
              }
            />
          </label>
        </div>
      )}
    </div>
  )
}

function ListeningFilterEditor({
  filter,
  onFilterChange,
}: Pick<ListeningControlsProps, 'filter' | 'onFilterChange'>) {
  const [match, setMatch] = useState(filter?.match ?? 'all')
  const [rules, setRules] = useState(() =>
    (filter?.rules ?? [initialRule]).map(listeningRuleDraft),
  )
  const [filterError, setFilterError] = useState('')

  return (
    <form
      className="grid gap-3"
      onSubmit={(event) => {
        event.preventDefault()
        if (rules.length === 0) {
          setFilterError('')
          onFilterChange(undefined)
          return
        }
        const parsed = parseListeningFilterDraft(match, rules)
        if (!parsed.success) {
          setFilterError(
            'Check each period and enter a minimum or maximum. Counts must be whole numbers; minimum cannot exceed maximum.',
          )
          return
        }
        setFilterError('')
        onFilterChange(parsed.data)
      }}
    >
      <label>
        Match
        <select
          aria-label="Match listening rules"
          value={match}
          onChange={(event) =>
            setMatch(event.target.value === 'any' ? 'any' : 'all')
          }
        >
          <option value="all">All rules</option>
          <option value="any">Any rule</option>
        </select>
      </label>
      {rules.map((rule, index) => (
        <fieldset
          className="grid min-w-0 gap-2 border-t border-slate-200 pt-2"
          key={rule.id}
        >
          <legend className="text-xs font-medium">Rule {index + 1}</legend>
          <PeriodInputs
            label={`Rule ${index + 1}`}
            value={rule.period}
            onChange={(period) =>
              setRules((current) =>
                current.map((item) =>
                  item.id === rule.id ? { ...item, period } : item,
                ),
              )
            }
          />
          <div className="range-inputs">
            {countBounds.map((bound) => (
              <label key={bound}>
                {bound === 'min' ? 'Minimum' : 'Maximum'}
                <input
                  aria-label={`Rule ${index + 1} ${bound === 'min' ? 'minimum' : 'maximum'} scrobbles`}
                  type="number"
                  min="0"
                  step="1"
                  placeholder="Any"
                  value={rule[bound]}
                  onChange={(event) => {
                    const value = event.target.value
                    setRules((current) =>
                      current.map((item) =>
                        item.id === rule.id
                          ? { ...item, [bound]: value }
                          : item,
                      ),
                    )
                  }}
                />
              </label>
            ))}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="justify-self-start gap-1"
            aria-label={`Remove listening rule ${index + 1}`}
            onClick={() =>
              setRules((current) =>
                current.filter((item) => item.id !== rule.id),
              )
            }
          >
            <X size={12} /> Remove rule
          </Button>
        </fieldset>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="justify-self-start gap-1"
        disabled={rules.length >= 10}
        onClick={() =>
          setRules((current) => [
            ...current,
            listeningRuleDraft(
              { period: { kind: 'rolling', amount: 2, unit: 'years' } },
              Math.max(-1, ...current.map((rule) => rule.id)) + 1,
            ),
          ])
        }
      >
        <Plus size={12} /> Add rule
      </Button>
      {filterError && <p role="alert">{filterError}</p>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm">
          Apply rules
        </Button>
        {filter && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onFilterChange(undefined)}
          >
            Clear rules
          </Button>
        )}
      </div>
    </form>
  )
}

function ListeningSortEditor({
  sortPeriod,
  sorting,
  onSortChange,
}: Pick<ListeningControlsProps, 'sortPeriod' | 'sorting' | 'onSortChange'>) {
  const [sortDraft, setSortDraft] = useState(() =>
    listeningPeriodDraft(sortPeriod ?? defaultListeningPeriod),
  )
  const [sortError, setSortError] = useState('')

  return (
    <form
      className="grid gap-3 border-t border-slate-200 pt-3"
      onSubmit={(event) => {
        event.preventDefault()
        const parsed = parseListeningPeriodDraft(sortDraft)
        if (!parsed.success) {
          setSortError('Enter a valid sort period.')
          return
        }
        setSortError('')
        onSortChange(parsed.data)
      }}
    >
      <fieldset className="grid min-w-0 gap-2">
        <legend className="mb-2 text-xs font-medium">Sort period</legend>
        <PeriodInputs label="Sort" value={sortDraft} onChange={setSortDraft} />
      </fieldset>
      {sortError && <p role="alert">{sortError}</p>}
      <Button type="submit" size="sm">
        {sorting ? 'Update sort period' : 'Sort by scrobbles'}
      </Button>
    </form>
  )
}

export function ListeningControls(props: ListeningControlsProps) {
  const editor = (
    <div
      className={
        props.presentation === 'panel'
          ? 'range-editor'
          : 'popover-panel range-editor'
      }
    >
      <p className="quiet text-xs">
        Counts synced, linked Last.fm track scrobbles, not full album plays.
        Bounds are inclusive; dates use UTC.
      </p>
      <ListeningFilterEditor
        key={JSON.stringify(props.filter)}
        filter={props.filter}
        onFilterChange={props.onFilterChange}
      />
      <ListeningSortEditor
        key={JSON.stringify(props.sortPeriod)}
        sortPeriod={props.sortPeriod}
        sorting={props.sorting}
        onSortChange={props.onSortChange}
      />
    </div>
  )
  return props.presentation === 'panel' ? (
    <FilterPanelSection
      title="Listening"
      icon={<Headphones size={16} />}
      count={props.filter?.rules.length}
      defaultOpen={Boolean(props.filter?.rules.length)}
    >
      {editor}
    </FilterPanelSection>
  ) : (
    <details className="toolbar-popover">
      <summary>
        <Headphones size={15} /> Listening
        {props.filter?.rules.length ? ` (${props.filter.rules.length})` : ''}
      </summary>
      {editor}
    </details>
  )
}
