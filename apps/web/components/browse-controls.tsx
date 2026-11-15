'use client'

import { useState } from 'react'
import { Grid2X2, Rows3, SlidersHorizontal, Table2, X } from 'lucide-react'
import { Button } from '@repo/ui/components/ui/button'
import {
  BrowseRangeSchema,
  type BrowseField,
  type BrowseRange,
  type BrowseFilter,
} from '@repo/schemas/browse'
import { FilterButton } from './filter-affordance'
import { FilterPanelSection } from './browse-filter-panel'
import type { BrowseView } from '@/utils/media-grid'

const views = [
  { value: 'grid', label: 'Grid view', Icon: Grid2X2 },
  { value: 'list', label: 'List view', Icon: Rows3 },
  { value: 'table', label: 'Table view', Icon: Table2 },
] satisfies Array<{ value: BrowseView; label: string; Icon: typeof Grid2X2 }>

export function BrowseViewSwitch({
  view,
  onChange,
}: {
  view: BrowseView
  onChange: (view: BrowseView) => void
}) {
  return (
    <div className="view-switch" role="group" aria-label="Browse views">
      {views.map(({ value, label, Icon }) => (
        <Button
          type="button"
          key={value}
          variant={view === value ? 'default' : 'ghost'}
          aria-label={label}
          aria-pressed={view === value}
          title={label}
          onClick={() => onChange(value)}
        >
          <Icon size={16} />
        </Button>
      ))}
    </div>
  )
}

export function BrowseTagBadges({
  field = 'genre',
  tags,
  onFilter,
  className = '',
}: {
  field?: string
  tags: string[]
  onFilter: (filter: BrowseFilter) => void
  className?: string
}) {
  if (tags.length === 0) return null
  return (
    <div
      className={`browse-tag-badges ${className}`}
      role="group"
      aria-label="Tags"
    >
      {tags.map((tag) => (
        <FilterButton
          key={tag}
          title={`Filter by ${tag}`}
          onClick={() => onFilter({ field, value: tag })}
        >
          {tag}
        </FilterButton>
      ))}
    </div>
  )
}

export function filterModeClass(mode: BrowseFilter['mode']) {
  return mode === 'required'
    ? 'filter-required'
    : mode === 'exclude'
      ? 'filter-exclude'
      : 'filter-any'
}

export function BrowseFilterChips({
  filters,
  fields,
  onChange,
}: {
  filters: BrowseFilter[]
  fields: BrowseField[]
  onChange: (filters: BrowseFilter[]) => void
}) {
  return filters.map((filter, index) => {
    const label =
      filter.mode === 'required'
        ? 'Required'
        : filter.mode === 'exclude'
          ? 'Excluded'
          : 'Any'
    const nextMode =
      filter.mode === 'required'
        ? 'exclude'
        : filter.mode === 'exclude'
          ? 'any'
          : 'required'
    return (
      <span
        className={`filter-pill ${filterModeClass(filter.mode)}`}
        key={`${filter.field}:${filter.value}`}
      >
        <FilterButton
          type="button"
          title="Cycle Any / Required / Excluded"
          onClick={() =>
            onChange(
              filters.map((item, i) =>
                i === index ? { ...item, mode: nextMode } : item,
              ),
            )
          }
        >
          {label} ·{' '}
          {fields.find((field) => field.key === filter.field)?.label ??
            filter.field}
          : {filter.value}
        </FilterButton>
        <button
          type="button"
          aria-label={`Remove ${filter.value} filter`}
          onClick={() => onChange(filters.filter((_, i) => i !== index))}
        >
          <X size={12} />
        </button>
      </span>
    )
  })
}

export function RangeEditor({
  fields,
  ranges,
  onChange,
  presentation = 'popover',
}: {
  fields: BrowseField[]
  ranges: BrowseRange[]
  presentation?: 'popover' | 'panel'
  onChange: (ranges: BrowseRange[]) => void
}) {
  const [key, setKey] = useState(
    fields.find((field) => field.type !== 'text')?.key ?? '',
  )
  const [error, setError] = useState('')
  const field = fields.find((field) => field.key === key)
  const current = ranges.find((range) => range.field === key)
  const isDate = field?.type === 'date'
  const editor = (
    <form
      key={`${key}:${JSON.stringify(current)}`}
      className={
        presentation === 'panel' ? 'range-editor' : 'popover-panel range-editor'
      }
      onSubmit={(event) => {
        event.preventDefault()
        const data = new FormData(event.currentTarget)
        const parse = (name: string) => {
          const value = data.get(name)
          return typeof value === 'string' && value !== ''
            ? isDate
              ? Date.parse(value) + (name === 'max' ? 86400000 - 1 : 0)
              : Number(value)
            : undefined
        }
        const next = BrowseRangeSchema.safeParse({
          field: key,
          min: parse('min'),
          max: parse('max'),
          includeMissing: data.get('missing') === 'on',
        })
        if (!next.success) {
          setError('Check the range bounds.')
          return
        }
        setError('')
        onChange([...ranges.filter((range) => range.field !== key), next.data])
      }}
    >
      <label>
        Field
        <select
          aria-label="Range field"
          value={key}
          onChange={(event) => {
            setKey(event.target.value)
            setError('')
          }}
        >
          {fields
            .filter((field) => field.type !== 'text')
            .map((field) => (
              <option value={field.key} key={field.key}>
                {field.label}
              </option>
            ))}
        </select>
      </label>
      <div className="range-inputs">
        {['min', 'max'].map((name) => {
          const value = name === 'min' ? current?.min : current?.max
          return (
            <label key={name}>
              {name === 'min' ? 'Minimum' : 'Maximum'}
              <input
                name={name}
                type={isDate ? 'date' : 'number'}
                step="any"
                defaultValue={
                  value === undefined
                    ? ''
                    : isDate
                      ? new Date(value).toISOString().slice(0, 10)
                      : value
                }
              />
            </label>
          )
        })}
      </div>
      <label className="check-label">
        <input
          type="checkbox"
          name="missing"
          defaultChecked={current?.includeMissing ?? false}
        />{' '}
        Include missing values
      </label>
      {error && <p role="alert">{error}</p>}
      <Button type="submit">Apply range</Button>
    </form>
  )
  return presentation === 'panel' ? (
    <FilterPanelSection
      title="Ranges"
      icon={<SlidersHorizontal size={16} />}
      count={ranges.length}
      defaultOpen
    >
      {editor}
    </FilterPanelSection>
  ) : (
    <details className="toolbar-popover">
      <summary>
        <SlidersHorizontal size={15} /> Ranges
        {ranges.length ? ` (${ranges.length})` : ''}
      </summary>
      {editor}
    </details>
  )
}
