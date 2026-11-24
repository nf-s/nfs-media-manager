'use client'

import type { ReactNode } from 'react'
import {
  formatBrowseValue,
  type BrowseField,
  type BrowseFilter,
  type BrowseRange,
} from '@repo/schemas/browse'
import type { ListeningFilter } from '@repo/schemas/listening'
import type { BrowseFilterHref } from '@/utils/browse-items'
import { formatListeningRule } from '@/utils/listening-filters'
import {
  Toolbar,
  ToolbarCount,
  ToolbarEnd,
} from '@repo/ui/components/ds/toolbar'
import { Button } from '@repo/ui/components/ui/button'
import {
  BrowseFilterChips,
  BrowseFilterPill,
  RangeEditor,
} from './browse-controls'
import BrowseFilterPanel from './browse-filter-panel'
import {
  LibraryScopePills,
  LibraryScopeSections,
  LibraryScopeToggle,
  type LibraryScopeControl,
} from './library-scope-controls'
import { libraryScopeFilterCount } from '@/utils/library-scope'

export type MetadataSelectionFilters = {
  q: string
  filters: BrowseFilter[]
  ranges: BrowseRange[]
  limitResults?: number
  listening?: ListeningFilter
}

/**
 * One metadata-table layout: active filters, then search, the page's own
 * filters, the count, and Filters and Columns at the end.
 */
export default function MetadataSelectionToolbar({
  fields,
  value,
  onChange,
  onClear,
  filterHref,
  otherFiltersActive = false,
  providerFilters = [],
  disabled = false,
  search,
  filters,
  count,
  actions,
  columns,
  children,
  libraryScope,
}: {
  fields: BrowseField[]
  value: MetadataSelectionFilters
  onChange: (value: MetadataSelectionFilters) => void
  onClear: () => void
  filterHref?: BrowseFilterHref
  otherFiltersActive?: boolean
  providerFilters?: { key: string; label: string; remove: () => void }[]
  disabled?: boolean
  search: ReactNode
  /** Controls placed after the search, such as the library. */
  filters?: ReactNode
  count: ReactNode
  /** Actions on the whole result, placed after the count. */
  actions?: ReactNode
  columns: ReactNode
  children?: ReactNode
  libraryScope?: LibraryScopeControl
}) {
  const activeCount =
    Number(Boolean(value.q)) +
    value.filters.length +
    value.ranges.length +
    Number(value.limitResults !== undefined) +
    (value.listening?.rules.length ?? 0) +
    providerFilters.length +
    (libraryScope ? libraryScopeFilterCount(libraryScope.value) : 0)
  function change(next: MetadataSelectionFilters) {
    if (!disabled) onChange(next)
  }
  const activeFilters =
    activeCount > 0 || otherFiltersActive ? (
      <div className="ops-chips" role="group" aria-label="Active filters">
        {value.q && (
          <BrowseFilterPill
            onRemove={() => change({ ...value, q: '' })}
            removeLabel="Remove search"
          >
            Search: {value.q}
          </BrowseFilterPill>
        )}
        <BrowseFilterChips
          filters={value.filters}
          fields={fields}
          filterHref={filterHref}
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
          const label = field?.label ?? range.field
          return (
            <BrowseFilterPill
              key={range.field}
              onRemove={() =>
                change({
                  ...value,
                  ranges: value.ranges.filter(
                    (item) => item.field !== range.field,
                  ),
                })
              }
              removeLabel={`Remove ${label} range`}
            >
              {label}: {bound(range.min)} to {bound(range.max)}
              {range.includeMissing ? ' + missing' : ''}
            </BrowseFilterPill>
          )
        })}
        {value.listening?.rules.map((rule, index) => (
          <BrowseFilterPill
            key={`listening:${index}`}
            removeLabel={`Remove listening rule: ${formatListeningRule(rule)}`}
            onRemove={() => {
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
            {formatListeningRule(rule)}
          </BrowseFilterPill>
        ))}
        {value.limitResults !== undefined && (
          <BrowseFilterPill
            onRemove={() => change({ ...value, limitResults: undefined })}
            removeLabel="Remove limit"
          >
            Limit: {value.limitResults}
          </BrowseFilterPill>
        )}
        {providerFilters.map(({ key, label, remove }) => (
          <BrowseFilterPill
            key={key}
            removeLabel={`Remove ${label} filter`}
            onRemove={() => {
              if (!disabled) remove()
            }}
          >
            {label}
          </BrowseFilterPill>
        ))}
        {libraryScope && <LibraryScopePills {...libraryScope} />}
        <Button
          variant="link"
          size="xs"
          onClick={() => {
            if (!disabled) onClear()
          }}
        >
          Clear all
        </Button>
      </div>
    ) : null
  return (
    <fieldset disabled={disabled} className="ops-selection-controls">
      {activeFilters}
      <Toolbar>
        {search}
        {filters}
        <ToolbarCount>{count}</ToolbarCount>
        {actions}
        <ToolbarEnd>
          {libraryScope && <LibraryScopeToggle {...libraryScope} />}
          <BrowseFilterPanel count={activeCount}>
            {activeFilters}
            {libraryScope && <LibraryScopeSections {...libraryScope} />}
            <RangeEditor
              presentation="panel"
              fields={fields.filter((field) => field.filterable)}
              ranges={value.ranges}
              onChange={(ranges) => change({ ...value, ranges })}
            />
            {children}
          </BrowseFilterPanel>
          {columns}
        </ToolbarEnd>
      </Toolbar>
    </fieldset>
  )
}
