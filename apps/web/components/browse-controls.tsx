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
  formatBrowseFilterValue,
  type BrowseField,
  type BrowseRange,
  type BrowseFilter,
} from '@repo/schemas/browse'
import { FilterPanelSection } from './browse-filter-panel'
import {
  gridDensities,
  type BrowseView,
  type GridDensity,
} from '@/utils/media-grid'
import { musicDisplayTags } from '@repo/schemas/music-tags'
import { formatTagName } from '@repo/schemas/tags'
import type { BrowseFilterHref } from '@/utils/browse-items'
import { workspaceTabLinkProps } from '@/utils/workspace-tab-destination'

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

const densityLabels: Record<GridDensity, string> = {
  compact: 'Compact',
  standard: 'Standard',
  roomy: 'Roomy',
}
const densities = gridDensities.map((value) => ({
  value,
  label: densityLabels[value],
}))

/** Card size in the Grid view, the first control under View in the Filters drawer. */
export function BrowseDensitySwitch({
  density,
  onChange,
}: {
  density: GridDensity
  onChange: (density: GridDensity) => void
}) {
  return (
    <Segmented
      label="Grid size"
      value={density}
      options={densities}
      onChange={onChange}
    />
  )
}

/**
 * An item's tags as pills that add a filter. Shows the first `max` and a
 * `+N` count; the pills are never clipped or scrolled. Artist tags shown in
 * place of missing album tags use the outline pill. `storedNames` shows tags
 * from outside the tag library, such as a subscription's, as their source
 * wrote them.
 */
export function BrowseTagBadges({
  field = 'genre',
  tags,
  artistTags,
  onFilter,
  filterHref,
  className,
  max = 3,
  storedNames = false,
}: {
  field?: string
  tags: string[]
  artistTags?: string[]
  onFilter: (filter: BrowseFilter) => void
  filterHref?: BrowseFilterHref
  className?: string
  max?: number
  storedNames?: boolean
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
      {shown.map(({ name: tag, source }) => {
        const label = storedNames ? tag : formatTagName(tag)
        const filter = {
          field: source === 'artist' ? 'artistTag' : field,
          value: tag,
        }
        return (
          <Pill
            asChild
            key={tag}
            tone={source === 'artist' ? 'outline' : undefined}
          >
            <button
              {...(filterHref
                ? workspaceTabLinkProps(filterHref(filter), label)
                : undefined)}
              type="button"
              title={`${source === 'artist' ? 'Artist tag' : 'Tag'}: ${label}`}
              onClick={(event) => {
                event.stopPropagation()
                onFilter(filter)
              }}
            >
              <PillLabel>{label}</PillLabel>
              {source === 'artist' && (
                <span className="sr-only">, artist tag</span>
              )}
            </button>
          </Pill>
        )
      })}
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
  destination,
  onRemove,
  removeLabel,
}: {
  mode?: PillMode
  children: ReactNode
  title?: string
  label?: string
  onActivate?: () => void
  destination?: { href: string; label: string }
  onRemove: () => void
  removeLabel: string
}) {
  return (
    <Pill mode={mode} asChild>
      <span className="browse-filter-pill">
        {onActivate ? (
          <button
            {...(destination
              ? workspaceTabLinkProps(destination.href, destination.label)
              : undefined)}
            type="button"
            className="browse-pill-action"
            title={title}
            aria-label={label}
            onClick={onActivate}
          >
            <PillLabel>{children}</PillLabel>
          </button>
        ) : destination ? (
          <PillLabel
            {...workspaceTabLinkProps(destination.href, destination.label)}
            tabIndex={0}
          >
            {children}
          </PillLabel>
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

/** `storedTagNames` shows tag values from outside the tag library as stored. */
export function BrowseFilterChips({
  filters,
  fields,
  onChange,
  filterHref,
  storedTagNames = false,
}: {
  filters: BrowseFilter[]
  fields: BrowseField[]
  onChange: (filters: BrowseFilter[]) => void
  filterHref?: BrowseFilterHref
  storedTagNames?: boolean
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
    const value = storedTagNames
      ? filter.value
      : formatBrowseFilterValue(filter.field, filter.value)
    return (
      <BrowseFilterPill
        key={`${filter.field}:${filter.value}`}
        mode={filterPillMode(filter.mode)}
        title="Cycle Any / Required / Excluded"
        destination={
          filterHref ? { href: filterHref(filter), label: value } : undefined
        }
        onActivate={() =>
          onChange(
            filters.map((item, i) =>
              i === index ? { ...item, mode: nextMode } : item,
            ),
          )
        }
        onRemove={() => onChange(filters.filter((_, i) => i !== index))}
        removeLabel={`Remove ${value} filter`}
      >
        {label} · {fieldLabel}: {value}
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
