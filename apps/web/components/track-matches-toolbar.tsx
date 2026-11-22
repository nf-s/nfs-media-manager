'use client'

import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Layers } from 'lucide-react'
import type { BrowseField, BrowseFilter } from '@repo/schemas/browse'
import {
  trackPlayabilityLabels,
  type TrackMatchDiagnosticsQuery,
} from '@repo/schemas/match-diagnostics'
import { Select, ToolbarToggle } from '@repo/ui/components/ds/toolbar'
import { useRailSlot } from '@/hooks/useRailSlot'
import type { BrowseFilterHref } from '@/utils/browse-items'
import {
  clearCreatorScope,
  type CreatorBrowseScope,
} from '@/utils/creator-browse'
import {
  applyTrackMatchPreset,
  trackMatchPreset,
  trackMatchPresets,
} from '@/utils/match-diagnostics'
import { clientQueryDefaults } from '@/utils/query-cache'
import {
  loadTrackDuplicateCount,
  trackDuplicateCountKey,
} from '@/utils/track-duplicates'
import {
  ActiveFiltersSection,
  ColumnChoices,
  PlacedFilters,
} from './browse-items'
import { BrowseFilterPill, RangeEditor } from './browse-controls'
import BrowseToolbar, { BrowseColumnsSection } from './browse-toolbar'
import { useConfig } from './providers'
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
  filterHref,
  activeFilterHref,
  searchHref,
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
  filterHref: BrowseFilterHref
  activeFilterHref: BrowseFilterHref
  searchHref: (value: string) => string
  setParams: SetParams
  onColumnOrder: (keys: string[]) => void
  onResetOrder?: () => void
}) {
  const { apiBaseUrl } = useConfig()
  const railSlot = useRailSlot()
  const {
    q = '',
    filters,
    ranges,
    limitResults,
    creatorId,
    playability = 'all',
    duplicates = false,
  } = query
  const duplicateCount = useQuery({
    queryKey: trackDuplicateCountKey(creatorId),
    queryFn: ({ signal }) =>
      loadTrackDuplicateCount(apiBaseUrl, creatorId, signal),
    ...clientQueryDefaults,
    retry: false,
  })
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
        filterHref={activeFilterHref}
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
            <ToolbarToggle
              pressed={duplicates}
              onPressedChange={(pressed) =>
                setParams({ duplicates: pressed ? 'true' : null })
              }
              icon={<Layers className="ds-i" data-size="sm" aria-hidden />}
              count={
                duplicateCount.data?.ready
                  ? duplicateCount.data.count
                  : undefined
              }
            >
              Possible duplicates
            </ToolbarToggle>
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
            filterHref={filterHref}
            searchHref={searchHref}
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
