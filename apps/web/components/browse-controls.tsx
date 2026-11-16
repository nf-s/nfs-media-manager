'use client'

import { useState, type ReactNode } from 'react'
import {
  LayoutGrid,
  List as ListIcon,
  SlidersHorizontal,
  Table2,
  X,
} from 'lucide-react'
import { Button } from '@repo/ui/components/ui/button'
import { Segmented } from '@repo/ui/components/ds/segmented'
import {
  Pill,
  PillLabel,
  Pills,
  type PillMode,
} from '@repo/ui/components/ds/pill'
import { Select } from '@repo/ui/components/ds/toolbar'
import {
  BrowseRangeSchema,
  type BrowseField,
  type BrowseRange,
  type BrowseFilter,
} from '@repo/schemas/browse'
import { FilterPanelSection } from './browse-filter-panel'
import type { BrowseView } from '@/utils/media-grid'
import { musicDisplayTags } from '@repo/schemas/music-tags'

const views = [
  {
    value: 'grid',
    label: 'Grid view',
    icon: <LayoutGrid className="ds-i" data-size="sm" aria-hidden />,
  },
  {
    value: 'list',
    label: 'List view',
    icon: <ListIcon className="ds-i" data-size="sm" aria-hidden />,
  },
  {
    value: 'table',
    label: 'Table view',
    icon: <Table2 className="ds-i" data-size="sm" aria-hidden />,
  },
] satisfies Array<{ value: BrowseView; label: string; icon: ReactNode }>

export function BrowseViewSwitch({
  view,
  onChange,
}: {
  view: BrowseView
  onChange: (view: BrowseView) => void
}) {
  return (
    <Segmented
      label="Browse views"
      value={view}
      options={views}
      onChange={onChange}
    />
  )
}

/**
 * An item's tags as pills that add a filter. Shows the first `max` and a
 * `+N` count; the pills are never clipped or scrolled. Artist tags shown in
 * place of missing album tags use the outline pill.
 */
export function BrowseTagBadges({
  field = 'genre',
  tags,
  artistTags,
  onFilter,
  className,
  max = 3,
}: {
  field?: string
  tags: string[]
  artistTags?: string[]
  onFilter: (filter: BrowseFilter) => void
  className?: string
  max?: number
}) {
  const shown =
    artistTags === undefined
      ? tags.map((name) => ({
          name,
          source: field === 'artistTag' ? 'artist' : 'album',
        }))
      : musicDisplayTags(tags, artistTags)
  if (shown.length === 0) return null
  return (
    <Pills label="Tags" max={max} className={className}>
      {shown.map(({ name: tag, source }) => (
        <Pill
          asChild
          key={tag}
          tone={source === 'artist' ? 'outline' : undefined}
        >
          <button
            type="button"
            title={`${source === 'artist' ? 'Artist tag' : 'Tag'}: ${tag}`}
            onClick={(event) => {
              event.stopPropagation()
              onFilter({
                field: source === 'artist' ? 'artistTag' : field,
                value: tag,
              })
            }}
          >
            <PillLabel>{tag}</PillLabel>
            {source === 'artist' && (
              <span className="sr-only">, artist tag</span>
            )}
          </button>
        </Pill>
      ))}
    </Pills>
  )
}

/** The legacy class for a filter mode. Prefer `filterPillMode` with `Pill`. */
export function filterModeClass(mode: BrowseFilter['mode']) {
  return mode === 'required'
    ? 'filter-required'
    : mode === 'exclude'
      ? 'filter-exclude'
      : 'filter-any'
}

/** The `Pill` mode for a filter: any, required or excluded. */
export function filterPillMode(mode: BrowseFilter['mode']): PillMode {
  return mode ?? 'any'
}

/**
 * A removable filter pill. Its label is a button when `onActivate` is set
 * (for example to cycle the mode); the cross removes it.
 */
export function BrowseFilterPill({
  mode,
  children,
  title,
  label,
  onActivate,
  onRemove,
  removeLabel,
}: {
  mode?: PillMode
  children: ReactNode
  title?: string
  label?: string
  onActivate?: () => void
  onRemove: () => void
  removeLabel: string
}) {
  return (
    <Pill mode={mode} asChild>
      <span className="browse-filter-pill">
        {onActivate ? (
          <button
            type="button"
            className="browse-pill-action"
            title={title}
            aria-label={label}
            onClick={onActivate}
          >
            <PillLabel>{children}</PillLabel>
          </button>
        ) : (
          <PillLabel>{children}</PillLabel>
        )}
        <button
          type="button"
          className="browse-pill-action"
          aria-label={removeLabel}
          title={removeLabel}
          onClick={onRemove}
        >
          <X className="ds-i" aria-hidden />
        </button>
      </span>
    </Pill>
  )
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
    const fieldLabel =
      fields.find((field) => field.key === filter.field)?.label ?? filter.field
    return (
      <BrowseFilterPill
        key={`${filter.field}:${filter.value}`}
        mode={filterPillMode(filter.mode)}
        title="Cycle Any / Required / Excluded"
        onActivate={() =>
          onChange(
            filters.map((item, i) =>
              i === index ? { ...item, mode: nextMode } : item,
            ),
          )
        }
        onRemove={() => onChange(filters.filter((_, i) => i !== index))}
        removeLabel={`Remove ${filter.value} filter`}
      >
        {label} · {fieldLabel}: {filter.value}
      </BrowseFilterPill>
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
        presentation === 'panel'
          ? 'browse-form'
          : 'browse-form ds-pop browse-popover-panel'
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
      <label className="ds-field">
        <span className="ds-label">Field</span>
        <Select
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
        </Select>
      </label>
      <div className="browse-form-pair">
        {['min', 'max'].map((name) => {
          const value = name === 'min' ? current?.min : current?.max
          return (
            <label className="ds-field" key={name}>
              <span className="ds-label">
                {name === 'min' ? 'Minimum' : 'Maximum'}
              </span>
              <input
                className="ds-input"
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
      <label className="ds-checkrow">
        <input
          type="checkbox"
          className="ds-check"
          name="missing"
          defaultChecked={current?.includeMissing ?? false}
        />
        Include missing values
      </label>
      {error && (
        <p role="alert" className="browse-form-error">
          {error}
        </p>
      )}
      <div>
        <Button variant="primary" type="submit">
          Apply range
        </Button>
      </div>
    </form>
  )
  return presentation === 'panel' ? (
    <FilterPanelSection
      title="Ranges"
      icon={<SlidersHorizontal className="ds-i" data-size="sm" aria-hidden />}
      count={ranges.length}
      defaultOpen
    >
      {editor}
    </FilterPanelSection>
  ) : (
    <details className="browse-popover">
      <summary className="ds-btn">
        <SlidersHorizontal className="ds-i" data-size="sm" aria-hidden />
        Ranges
        {ranges.length ? ` (${ranges.length})` : ''}
      </summary>
      {editor}
    </details>
  )
}
