'use client'

import type { ReactNode } from 'react'
import { X } from 'lucide-react'
import {
  formatBrowseValue,
  type BrowseField,
  type BrowseFilter,
  type BrowseRange,
} from '@repo/schemas/browse'
import type { ListeningFilter } from '@repo/schemas/listening'
import { formatListeningRule } from '@/utils/listening-filters'
import { BrowseFilterChips, RangeEditor } from './browse-controls'
import BrowseFilterPanel from './browse-filter-panel'
import { FilterButton } from './filter-affordance'
import { SecondaryTableToolbar } from './secondary-table'

export type MetadataSelectionFilters = {
  q: string
  filters: BrowseFilter[]
  ranges: BrowseRange[]
  limitResults?: number
  listening?: ListeningFilter
}

/** One metadata-table layout: active filters, then search/count/Columns. */
export default function MetadataSelectionToolbar({
  fields,
  value,
  onChange,
  onClear,
  otherFiltersActive = false,
  providerFilters = [],
  disabled = false,
  search,
  count,
  columns,
  children,
}: {
  fields: BrowseField[]
  value: MetadataSelectionFilters
  onChange: (value: MetadataSelectionFilters) => void
  onClear: () => void
  otherFiltersActive?: boolean
  providerFilters?: { key: string; label: string; remove: () => void }[]
  disabled?: boolean
  search: ReactNode
  count: ReactNode
  columns: ReactNode
  children?: ReactNode
}) {
  const activeCount =
    Number(Boolean(value.q)) +
    value.filters.length +
    value.ranges.length +
    Number(value.limitResults !== undefined) +
    (value.listening?.rules.length ?? 0) +
    providerFilters.length
  function change(next: MetadataSelectionFilters) {
    if (!disabled) onChange(next)
  }
  const activeFilters =
    activeCount > 0 || otherFiltersActive ? (
      <div
        className="metadata-selection-filters flex flex-wrap items-center gap-2"
        aria-label="Active filters"
      >
        {value.q && (
          <FilterButton
            className="filter-pill"
            onClick={() => change({ ...value, q: '' })}
          >
            Search: {value.q} <X size={12} />
          </FilterButton>
        )}
        <BrowseFilterChips
          filters={value.filters}
          fields={fields}
          onChange={(filters) => change({ ...value, filters })}
        />
        {value.ranges.map((range) => {
          const field = fields.find((field) => field.key === range.field)
          const bound = (number: number | undefined) =>
            number === undefined
              ? '*'
              : field
                ? formatBrowseValue(field, number)
                : number
          return (
            <FilterButton
              key={range.field}
              className="filter-pill"
              onClick={() =>
                change({
                  ...value,
                  ranges: value.ranges.filter(
                    (item) => item.field !== range.field,
                  ),
                })
              }
            >
              {field?.label ?? range.field}: {bound(range.min)} to{' '}
              {bound(range.max)}
              {range.includeMissing ? ' + missing' : ''} <X size={12} />
            </FilterButton>
          )
        })}
        {value.listening?.rules.map((rule, index) => (
          <FilterButton
            key={`listening:${index}`}
            className="filter-pill"
            aria-label={`Remove listening rule: ${formatListeningRule(rule)}`}
            onClick={() => {
              if (!value.listening) return
              const rules = value.listening.rules.filter((_, i) => i !== index)
              change({
                ...value,
                listening: rules.length
                  ? { ...value.listening, rules }
                  : undefined,
              })
            }}
          >
            {value.listening?.match === 'all' ? 'Required' : 'Any'} ·{' '}
            {formatListeningRule(rule)} <X size={12} />
          </FilterButton>
        ))}
        {value.limitResults !== undefined && (
          <FilterButton
            className="filter-pill"
            onClick={() => change({ ...value, limitResults: undefined })}
          >
            Limit: {value.limitResults} <X size={12} />
          </FilterButton>
        )}
        {providerFilters.map(({ key, label, remove }) => (
          <FilterButton
            key={key}
            className="filter-pill"
            aria-label={`Remove ${label} filter`}
            onClick={() => {
              if (!disabled) remove()
            }}
          >
            {label} <X size={12} />
          </FilterButton>
        ))}
        <button
          type="button"
          className="clear-filters"
          onClick={() => {
            if (!disabled) onClear()
          }}
        >
          Clear all
        </button>
      </div>
    ) : null
  return (
    <fieldset disabled={disabled} className="film-selection-controls">
      {activeFilters}
      <SecondaryTableToolbar
        search={search}
        count={count}
        columns={
          <>
            <BrowseFilterPanel count={activeCount}>
              {activeFilters}
              <RangeEditor
                presentation="panel"
                fields={fields.filter((field) => field.filterable)}
                ranges={value.ranges}
                onChange={(ranges) => change({ ...value, ranges })}
              />
              {children}
            </BrowseFilterPanel>
            {columns}
          </>
        }
      />
    </fieldset>
  )
}
