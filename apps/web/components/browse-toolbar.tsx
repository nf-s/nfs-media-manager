'use client'

import type { ReactNode } from 'react'
import { ArrowDown, ArrowUp, Columns3, Filter, Settings2 } from 'lucide-react'
import { Button } from '@repo/ui/components/ui/button'
import { SortPicker } from '@repo/ui/components/ds/sort-picker'
import {
  FilterLine,
  Toolbar,
  ToolbarCount,
  ToolbarEnd,
} from '@repo/ui/components/ds/toolbar'
import type { BrowseView, GridDensity } from '@/utils/media-grid'
import { libraryScopeFilterCount } from '@/utils/library-scope'
import { BrowseDensitySwitch, BrowseViewSwitch } from './browse-controls'
import BrowseFilterPanel, { FilterPanelSection } from './browse-filter-panel'
import { ColumnFilterOptions, type ColumnFilterProps } from './secondary-table'
import {
  LibraryScopeSections,
  LibraryScopeToggle,
  type LibraryScopeControl,
} from './library-scope-controls'

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

type BrowseDensity = {
  value: GridDensity
  onChange: (density: GridDensity) => void
}

/**
 * The View section, first in the Filters drawer: grid size while the Grid
 * view is on, then the list's own options. Nothing when it has neither.
 */
export function BrowseViewSection({
  view,
  density,
  children,
}: {
  view: BrowseView
  density?: BrowseDensity
  children?: ReactNode
}) {
  const gridSize = density && view === 'grid'
  if (!gridSize && !children) return null
  return (
    <FilterPanelSection
      title="View"
      icon={<Settings2 className="ds-i" data-size="sm" aria-hidden />}
      defaultOpen
    >
      <div className="browse-form browse-view-options">
        {gridSize && (
          <BrowseDensitySwitch
            density={density.value}
            onChange={density.onChange}
          />
        )}
        {children}
      </div>
    </FilterPanelSection>
  )
}

/**
 * The browse toolbar. Order: actions, search, sort, direction, view, the
 * Filters button, count, end. Grid size is the first control of the View
 * section in the Filters drawer, followed by `viewOptions`.
 *
 * With `compact`, for a list inside a detail, the Filters button is the icon
 * with its count. A compact list with `end` or `activeFilters` has a line
 * under the toolbar that holds the active filters, the count and `end`.
 */
export default function BrowseToolbar<Key extends string>({
  actions,
  addActions,
  search,
  sort,
  filters,
  filterCount = 0,
  view,
  onViewChange,
  density,
  viewOptions,
  count,
  end,
  compact = false,
  activeFilters,
  libraryScope,
}: {
  actions?: ReactNode
  /** Library additions share the search row on phones. */
  addActions?: ReactNode
  search: ReactNode
  sort: BrowseSort<Key>
  /** The sections of the Filters drawer after View. */
  filters?: ReactNode
  filterCount?: number
  view: BrowseView
  /** Absent on a list fixed to one view, which shows no view switch. */
  onViewChange?: (view: BrowseView) => void
  /** Card size, offered in the Filters drawer while the Grid view is active. */
  density?: BrowseDensity
  /** The list's own controls of the View section, after grid size. */
  viewOptions?: ReactNode
  count?: ReactNode
  /** Links that leave the list, such as Show in Tracks inside a detail. */
  end?: ReactNode
  /** Inside a detail. */
  compact?: boolean
  /** With `compact`: the active filter pills and Clear all. */
  activeFilters?: ReactNode
  libraryScope?: LibraryScopeControl
}) {
  const nextDirection = sort.direction === 'asc' ? 'desc' : 'asc'
  const directionLabel =
    nextDirection === 'asc' ? 'Sort ascending' : 'Sort descending'
  const hasView = Boolean((density && view === 'grid') || viewOptions)
  const line = compact && Boolean(end || activeFilters)
  const find = <div className="browse-find">{search}</div>

  return (
    <>
      <Toolbar>
        {actions}
        {addActions ? (
          <div className="browse-toolbar-start">
            {addActions}
            {find}
          </div>
        ) : (
          find
        )}
        <SortPicker
          value={sort.key}
          options={sort.options}
          onChange={sort.onChange}
        />
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
        {onViewChange && (
          <BrowseViewSwitch view={view} onChange={onViewChange} />
        )}
        {libraryScope && <LibraryScopeToggle {...libraryScope} />}
        {(hasView || Boolean(filters) || libraryScope) && (
          <BrowseFilterPanel
            count={
              filterCount +
              (libraryScope ? libraryScopeFilterCount(libraryScope.value) : 0)
            }
            short={compact}
          >
            <BrowseViewSection view={view} density={density}>
              {viewOptions}
            </BrowseViewSection>
            {libraryScope && <LibraryScopeSections {...libraryScope} />}
            {filters}
          </BrowseFilterPanel>
        )}
        {!line && count != null && <ToolbarCount>{count}</ToolbarCount>}
        {!line && end && <ToolbarEnd>{end}</ToolbarEnd>}
      </Toolbar>
      {line && (
        <FilterLine>
          {activeFilters}
          {count != null && <ToolbarCount>{count}</ToolbarCount>}
          {end}
        </FilterLine>
      )}
    </>
  )
}
