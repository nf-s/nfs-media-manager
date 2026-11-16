'use client'

import type { ReactNode } from 'react'
import { ArrowDown, ArrowUp, Columns3, Filter } from 'lucide-react'
import { Button } from '@repo/ui/components/ui/button'
import type { BrowseView } from '@/utils/media-grid'
import { BrowseViewSwitch } from './browse-controls'
import BrowseFilterPanel, { FilterPanelSection } from './browse-filter-panel'
import { ColumnFilterOptions, type ColumnFilterProps } from './secondary-table'

export type BrowseSort<Key extends string> = {
  key: Key
  direction?: 'asc' | 'desc'
  options: readonly { key: Key; label: string }[]
  onChange: (key: Key) => void
  onDirectionChange: (direction: 'asc' | 'desc') => void
}

export function BrowseColumnsSection({ children }: { children: ReactNode }) {
  return children ? (
    <FilterPanelSection title="Columns" icon={<Columns3 size={16} />}>
      <div className="filter-panel-columns">{children}</div>
    </FilterPanelSection>
  ) : null
}

export function BrowseColumnFilterSection<Value extends string>(
  props: ColumnFilterProps<Value>,
) {
  return (
    <FilterPanelSection title={props.label} icon={<Filter size={16} />}>
      <ColumnFilterOptions {...props} showLegend={false} />
    </FilterPanelSection>
  )
}

export default function BrowseToolbar<Key extends string>({
  actions,
  search,
  sort,
  filters,
  filterCount = 0,
  view,
  onViewChange,
  count,
}: {
  actions?: ReactNode
  search: ReactNode
  sort: BrowseSort<Key>
  filters?: ReactNode
  filterCount?: number
  view: BrowseView
  onViewChange: (view: BrowseView) => void
  count?: ReactNode
}) {
  const nextDirection = sort.direction === 'asc' ? 'desc' : 'asc'
  const directionLabel =
    nextDirection === 'asc' ? 'Sort ascending' : 'Sort descending'

  return (
    <div className="browse-toolbar">
      {actions}
      <div className="browse-toolbar-search">{search}</div>
      <div className="browse-controls">
        <div className="browse-sort">
          <select
            aria-label="Sort by"
            value={sort.key}
            onChange={(event) => {
              const option = sort.options.find(
                ({ key }) => key === event.target.value,
              )
              if (option) sort.onChange(option.key)
            }}
          >
            {sort.options.map(({ key, label }) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
          {sort.direction && (
            <Button
              size="md"
              type="button"
              variant="ghost"
              className="browse-sort-direction"
              aria-label={directionLabel}
              title={directionLabel}
              onClick={() => sort.onDirectionChange(nextDirection)}
            >
              {sort.direction === 'asc' ? (
                <ArrowUp size={16} aria-hidden="true" />
              ) : (
                <ArrowDown size={16} aria-hidden="true" />
              )}
            </Button>
          )}
        </div>
        {filters && (
          <BrowseFilterPanel count={filterCount}>{filters}</BrowseFilterPanel>
        )}
        <BrowseViewSwitch view={view} onChange={onViewChange} />
        {count != null && (
          <span className="browse-count" role="status">
            {count}
          </span>
        )}
      </div>
    </div>
  )
}
