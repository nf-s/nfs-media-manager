'use client'

import type { ReactNode } from 'react'
import type { BrowseField, BrowseFilter } from '@repo/schemas/browse'
import {
  trackPlayabilityLabels,
  type TrackMatchDiagnosticsQuery,
} from '@repo/schemas/match-diagnostics'
import { Select } from '@repo/ui/components/ds/toolbar'
import { useRailSlot } from '@/hooks/useRailSlot'
import {
  clearCreatorScope,
  type CreatorBrowseScope,
} from '@/utils/creator-browse'
import {
  applyTrackMatchPreset,
  trackMatchPreset,
  trackMatchPresets,
} from '@/utils/match-diagnostics'
import {
  ActiveFiltersSection,
  ColumnChoices,
  PlacedFilters,
} from './browse-items'
import { BrowseFilterPill, RangeEditor } from './browse-controls'
import BrowseToolbar, { BrowseColumnsSection } from './browse-toolbar'
import {
  TrackBrowseFilterChips,
  TrackBrowseSearch,
} from './track-browse-controls'

type TrackMatchesQueryState = Omit<TrackMatchDiagnosticsQuery, 'page' | 'size'>
type SetParams = (updates: Record<string, string | null>) => void

export function clearTrackMatchesFilters(setParams: SetParams) {
  setParams({
    q: null,
    filters: null,
    playability: null,
    ranges: null,
    limitResults: null,
    ...clearCreatorScope,
  })
}

export default function TrackMatchesToolbar({
  query,
  fields,
  sortFields,
  columnFields,
  visibleColumns,
  count,
  onSort,
  onOpenItem,
  onAddFilter,
  setParams,
  onColumnOrder,
  onResetOrder,
}: {
  query: TrackMatchesQueryState
  fields: BrowseField[]
  sortFields: BrowseField[]
  columnFields: BrowseField[]
  visibleColumns: string[]
  count: ReactNode
  onSort: (key: string) => void
  onOpenItem: (id: string, trigger?: HTMLElement) => void
  onAddFilter: (filter: BrowseFilter) => void
  setParams: SetParams
  onColumnOrder: (keys: string[]) => void
  onResetOrder?: () => void
}) {
  const railSlot = useRailSlot()
  const {
    q = '',
    filters,
    ranges,
    limitResults,
    creatorId,
    playability = 'all',
  } = query
  const creator: CreatorBrowseScope | undefined = creatorId
    ? { creatorId }
    : undefined
  const activeCount =
    Number(Boolean(q)) +
    Number(Boolean(creator)) +
    Number(limitResults !== undefined) +
    Number(playability !== 'all') +
    filters.length +
    ranges.length
  const pills = activeCount ? (
    <>
      {playability !== 'all' && (
        <BrowseFilterPill
          mode="required"
          removeLabel="Remove playability filter"
          onRemove={() => setParams({ playability: 'all' })}
        >
          {trackPlayabilityLabels[playability]}
        </BrowseFilterPill>
      )}
      <TrackBrowseFilterChips
        q={q}
        filters={filters}
        ranges={ranges}
        creator={creator}
        fields={fields}
        limitResults={limitResults}
        setParams={setParams}
      />
    </>
  ) : null
  const preset = trackMatchPreset(filters)
  function clearFilters() {
    clearTrackMatchesFilters(setParams)
  }
  return (
    <>
      <BrowseToolbar
        actions={
          <>
            <Select
              aria-label="Match status"
              className="browse-order"
              value={preset}
              onChange={(event) => {
                const next = applyTrackMatchPreset(filters, event.target.value)
                setParams({
                  filters: next.length ? JSON.stringify(next) : null,
                })
              }}
            >
              {preset === 'custom' && (
                <option value="custom" disabled>
                  Custom match filters
                </option>
              )}
              {trackMatchPresets.map(({ key, label }) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </Select>
            <Select
              aria-label="Playability"
              className="browse-order"
              value={playability}
              onChange={(event) =>
                setParams({ playability: event.target.value })
              }
            >
              {Object.entries(trackPlayabilityLabels).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </Select>
          </>
        }
        search={
          <TrackBrowseSearch
            matches
            fields={fields}
            filters={filters}
            creator={creator}
            queryIdentity={JSON.stringify(query)}
            onOpenItem={onOpenItem}
            onAddFilter={onAddFilter}
            setParams={setParams}
          />
        }
        sort={{
          key: query.sortBy,
          direction: query.direction,
          options: sortFields,
          onChange: onSort,
          onDirectionChange: (direction) => setParams({ direction }),
        }}
        filters={
          <>
            {pills && (
              <ActiveFiltersSection count={activeCount} onClear={clearFilters}>
                {pills}
              </ActiveFiltersSection>
            )}
            <RangeEditor
              presentation="panel"
              fields={fields.filter((field) => field.filterable)}
              ranges={ranges}
              onChange={(next) =>
                setParams({ ranges: next.length ? JSON.stringify(next) : null })
              }
            />
            <BrowseColumnsSection>
              <ColumnChoices
                fields={columnFields}
                selected={visibleColumns}
                required="title"
                onChange={(keys) => setParams({ columns: keys.join(',') })}
                onOrderChange={onColumnOrder}
                onResetOrder={onResetOrder}
              />
            </BrowseColumnsSection>
          </>
        }
        filterCount={activeCount}
        view="table"
        count={count}
      />
      {pills && (
        <PlacedFilters railSlot={railSlot} onClear={clearFilters}>
          {pills}
        </PlacedFilters>
      )}
    </>
  )
}
