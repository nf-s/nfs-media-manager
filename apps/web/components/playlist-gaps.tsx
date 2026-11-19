'use client'

import { useState } from 'react'
import { X } from 'lucide-react'
import { Segmented } from '@repo/ui/components/ds/segmented'
import { Select } from '@repo/ui/components/ds/toolbar'
import { Button } from '@repo/ui/components/ui/button'
import { formatItemCount } from '@repo/ui/lib/format'
import {
  gapActionLabel,
  gapFilterOptions,
  gapFilterValue,
  gapVerbs,
  parseGapFilterValue,
  selectionGaps,
  selectionQueueIds,
  type GapFilter,
} from '@/utils/coverage-entries'
import { coverageUnavailableLabels } from '@/utils/metadata-coverage'
import {
  CoverageQueueStatus,
  useCoverage,
  useCoverageQueue,
} from './metadata-coverage'
import { SecondaryTableSelectionBar } from './secondary-table'
import type { IndexedTrackEntry } from './track-entries-table'

type Show = 'all' | 'gaps'

/** All entries or a specific metadata gap. */
export function GapFilterControls({
  playlistId,
  filter,
  onChange,
}: {
  playlistId: string
  filter: GapFilter | null
  onChange: (filter: GapFilter | null) => void
}) {
  const coverage = useCoverage('playlist', playlistId)
  return (
    <>
      {filter && (
        <Select
          aria-label="Metadata gap"
          value={gapFilterValue(filter)}
          onChange={(event) => {
            const next = parseGapFilterValue(event.target.value)
            if (next) onChange(next)
          }}
        >
          {gapFilterOptions(coverage.data?.providers ?? [], filter).map(
            (option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ),
          )}
        </Select>
      )}
      <Segmented<Show>
        label="Show"
        value={filter ? 'gaps' : 'all'}
        options={[
          { value: 'all', label: 'All' },
          { value: 'gaps', label: 'Metadata gaps' },
        ]}
        onChange={(show) =>
          onChange(show === 'all' ? null : (filter ?? { gap: 'missing' }))
        }
      />
    </>
  )
}

/** Which rows are selected, whatever order they were picked in. */
export function gapSelectionKey(
  rows: readonly Pick<IndexedTrackEntry, 'key'>[],
) {
  return JSON.stringify(rows.map((row) => row.key).sort())
}

/**
 * The selection bar of the gap list: the provider that fills the selected
 * rows' gap, chosen from a list when several do, then the review step
 * Coverage uses. Key it by the gap filter so a review never outlives it.
 */
export function GapSelection({
  playlistId,
  filter,
  rows,
  onClear,
}: {
  playlistId: string
  filter: GapFilter
  rows: readonly IndexedTrackEntry[]
  onClear: () => void
}) {
  const coverage = useCoverage('playlist', playlistId)
  const state = useCoverageQueue(
    'playlist',
    playlistId,
    coverage.data?.olderThanDays,
    onClear,
  )
  const [chosen, setChosen] = useState<string | null>(null)
  // A review is for the rows it was opened with; another selection drops it.
  const rowsKey = gapSelectionKey(rows)
  const [reviewRowsKey, setReviewRowsKey] = useState(rowsKey)
  if (reviewRowsKey !== rowsKey) {
    setReviewRowsKey(rowsKey)
    if (state.review) state.cancel()
  }
  const gaps = selectionGaps(rows)
  const providerOf = (provider: string) =>
    coverage.data?.providers.find((item) => item.provider === provider)
  // The chosen provider, else the first that can run now, else the first.
  const active =
    gaps.find((gap) => gap.provider === chosen) ??
    gaps.find((gap) => {
      const provider = providerOf(gap.provider)
      return provider && !provider.unavailableReason
    }) ??
    gaps[0]
  const provider = active && providerOf(active.provider)
  const reason = provider?.unavailableReason
  return (
    <>
      {rows.length > 0 && (
        <SecondaryTableSelectionBar selectedCount={rows.length}>
          {active && gaps.length === 1 && (
            <span className="ds-muted">
              {filter.gap === 'missing'
                ? `Missing ${active.displayName} metadata`
                : `Stale ${active.displayName} metadata`}
            </span>
          )}
          <span className="ds-actions ds-toolbar-end">
            {active && gaps.length > 1 && (
              <Select
                aria-label="Provider"
                value={active.provider}
                disabled={state.queue.isPending}
                onChange={(event) => {
                  setChosen(event.target.value)
                  state.cancel()
                }}
              >
                {gaps.map((gap) => (
                  <option key={gap.provider} value={gap.provider}>
                    {gap.displayName} ·{' '}
                    {formatItemCount(gap.albumIds.length, {
                      one: 'album',
                      other: 'albums',
                    })}
                  </option>
                ))}
              </Select>
            )}
            {active && (
              <Button
                variant="primary"
                disabled={!provider || Boolean(reason) || state.queue.isPending}
                title={reason ? coverageUnavailableLabels[reason] : undefined}
                onClick={() =>
                  provider &&
                  state.open({
                    provider,
                    gap: filter.gap,
                    ids: selectionQueueIds(active),
                    count: active.albumIds.length,
                  })
                }
              >
                {gaps.length > 1
                  ? gapVerbs[filter.gap]
                  : gapActionLabel(filter.gap, active.displayName)}
              </Button>
            )}
            <Button
              icon
              aria-label="Clear selection"
              disabled={state.queue.isPending}
              onClick={() => {
                state.cancel()
                onClear()
              }}
            >
              <X className="ds-i" aria-hidden="true" />
            </Button>
          </span>
        </SecondaryTableSelectionBar>
      )}
      <CoverageQueueStatus state={state} />
    </>
  )
}
