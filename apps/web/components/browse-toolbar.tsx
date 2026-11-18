'use client'

import type { ReactNode } from 'react'
import { ArrowDown, ArrowUp, Columns3, Filter } from 'lucide-react'
import { Button } from '@repo/ui/components/ui/button'
import { Select, Toolbar, ToolbarCount } from '@repo/ui/components/ds/toolbar'
import type { BrowseView, GridDensity } from '@/utils/media-grid'
import { BrowseDensitySwitch, BrowseViewSwitch } from './browse-controls'
import BrowseFilterPanel, { FilterPanelSection } from './browse-filter-panel'
import { ColumnFilterOptions, type ColumnFilterProps } from './secondary-table'

export type BrowseSort<Key extends string> = {
  key: Key
  direction?: 'asc' | 'desc'
  options: readonly { key: Key; label: string }[]
  onChange: (key: Key) => void
  onDirectionChange: (direction: 'asc' | 'desc') => void
}

/** The column picker in the Filters drawer: one checkbox per column. */
export function BrowseColumnsSection({ children }: { children: ReactNode }) {
  return children ? (
    <FilterPanelSection
      title="Columns"
      icon={<Columns3 className="ds-i" data-size="sm" aria-hidden />}
    >
      <div className="browse-check-list">{children}</div>
    </FilterPanelSection>
  ) : null
}

export function BrowseColumnFilterSection<Value extends string>(
  props: ColumnFilterProps<Value>,
) {
  return (
    <FilterPanelSection
      title={props.label}
      icon={<Filter className="ds-i" data-size="sm" aria-hidden />}
    >
      <ColumnFilterOptions {...props} showLegend={false} />
    </FilterPanelSection>
  )
}

/**
 * The browse toolbar. Order: actions, search, sort, direction, filters,
 * view, density (Grid only), count.
 */
export default function BrowseToolbar<Key extends string>({
  actions,
  search,
  sort,
  filters,
  filterCount = 0,
  view,
  onViewChange,
  density,
  count,
}: {
  actions?: ReactNode
  search: ReactNode
  sort: BrowseSort<Key>
  filters?: ReactNode
  filterCount?: number
  view: BrowseView
  /** Absent on a list fixed to one view, which shows no view switch. */
  onViewChange?: (view: BrowseView) => void
  /** Card size, shown while the Grid view is active. */
  density?: {
    value: GridDensity
    onChange: (density: GridDensity) => void
  }
  count?: ReactNode
}) {
  const nextDirection = sort.direction === 'asc' ? 'desc' : 'asc'
  const directionLabel =
    nextDirection === 'asc' ? 'Sort ascending' : 'Sort descending'

  return (
    <Toolbar>
      {actions}
      <div className="browse-find">{search}</div>
      <Select
        aria-label="Sort by"
        className="browse-order"
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
      </Select>
      {sort.direction && (
        <Button
          type="button"
          icon
          aria-label={directionLabel}
          title={directionLabel}
          onClick={() => sort.onDirectionChange(nextDirection)}
        >
          {sort.direction === 'asc' ? (
            <ArrowUp className="ds-i" data-size="sm" aria-hidden />
          ) : (
            <ArrowDown className="ds-i" data-size="sm" aria-hidden />
          )}
        </Button>
      )}
      {filters && (
        <BrowseFilterPanel count={filterCount}>{filters}</BrowseFilterPanel>
      )}
      {onViewChange && <BrowseViewSwitch view={view} onChange={onViewChange} />}
      {density && view === 'grid' && (
        <BrowseDensitySwitch
          density={density.value}
          onChange={density.onChange}
        />
      )}
      {count != null && <ToolbarCount>{count}</ToolbarCount>}
    </Toolbar>
  )
}
