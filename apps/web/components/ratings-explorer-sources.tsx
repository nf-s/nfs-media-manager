'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import type {
  RatingsRange,
  RatingsSource,
  RatingsSourcesPage,
  RatingsSourcesRequest,
} from '@repo/schemas/ratings-explorer'
import { Section } from '@repo/ui/components/ds/facts'
import { Notice } from '@repo/ui/components/ds/feedback'
import { Histogram, type HistogramBar } from '@repo/ui/components/ds/histogram'
import { Select } from '@repo/ui/components/ds/toolbar'
import { Button } from '@repo/ui/components/ui/button'
import { formatCount, formatItemCount } from '@repo/ui/lib/format'
import { clientQueryDefaults } from '@/utils/query-cache'
import {
  fetchRatingsSources,
  ratingSourcesKey,
} from '@/utils/ratings-explorer-api'
import { ReadButton } from './read-button'
import { useResultAction } from './result-feedback'
import { useConfig } from './providers'
import { SecondaryTableToolbar } from './secondary-table'

type Distribution = RatingsSourcesPage['histograms'][number]
type Bin = Distribution['bins'][number]

/** Keep the space for the last count while the next request is outstanding. */
export function RatingsCount({
  library,
  total,
  failed,
}: {
  library: RatingsSourcesRequest['library']
  total?: number
  failed: boolean
}) {
  const [previous, setPrevious] = useState(total)
  useEffect(() => {
    if (total !== undefined) setPrevious(total)
  }, [total])
  const count = total ?? previous
  if (count === undefined) return failed ? null : 'Loading ratings…'
  return (
    <span className={total === undefined ? 'invisible' : undefined}>
      {formatItemCount(count, { one: library, other: library + 's' })}
    </span>
  )
}

export type RatingSelection = {
  range: RatingsRange
  label: string
  interval: string
}

const boundary = new Intl.NumberFormat('en', { maximumSignificantDigits: 12 })
function intervalLabel(from: Bin, through: Bin) {
  const lower = boundary.format(from.lower)
  if (from.lower === through.upper) return lower
  return (
    lower +
    (through.upperInclusive ? '–' : '–<') +
    boundary.format(through.upper)
  )
}

function dimensionLabel(dimension: string, source?: RatingsSource) {
  if (source) return source.label
  if (dimension === 'score') return 'Combined score'
  if (dimension === 'spread') return 'Spread'
  return 'Ratings counted'
}

function RangeEditor({
  bins,
  active,
  onApply,
  onCancel,
}: {
  bins: Bin[]
  active: RatingsRange | undefined
  onApply: (first: number, last: number) => void
  onCancel: () => void
}) {
  const [first, setFirst] = useState(active?.first ?? 0)
  const [last, setLast] = useState(active?.last ?? bins.length - 1)
  const start = useRef<HTMLLabelElement>(null)
  useEffect(() => start.current?.querySelector('select')?.focus(), [])
  const options = bins.map((bin, index) => (
    <option key={index} value={index}>
      {intervalLabel(bin, bin)}
    </option>
  ))
  return (
    <div className="data-stack">
      <div className="ratings-fields">
        <label ref={start} className="ratings-field">
          From bin
          <Select
            value={first}
            onChange={(event) => {
              const index = Number(event.target.value)
              setFirst(index)
              setLast(Math.max(last, index))
            }}
          >
            {options}
          </Select>
        </label>
        <label className="ratings-field">
          Through bin
          <Select
            value={last}
            onChange={(event) => {
              const index = Number(event.target.value)
              setLast(index)
              setFirst(Math.min(first, index))
            }}
          >
            {options}
          </Select>
        </label>
      </div>
      <div className="ds-actions">
        <Button
          size="xs"
          variant="primary"
          onClick={() => onApply(first, last)}
        >
          Show in Ranking
        </Button>
        <Button size="xs" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

function SourceDistribution({
  distribution,
  source,
  coverage,
  total,
  active,
  editing,
  onEdit,
  onDrill,
  library,
}: {
  distribution: Distribution
  source?: RatingsSource
  coverage?: RatingsSourcesPage['coverage'][number]
  total: number
  active: RatingsRange | undefined
  editing: boolean
  onEdit: (dimension: string | null) => void
  onDrill: (selection: RatingSelection) => void
  library: RatingsSourcesRequest['library']
}) {
  const { dimension, bins } = distribution
  const label = dimensionLabel(dimension, source)
  const bars = bins.map((bin, index) => {
    const interval = intervalLabel(bin, bin)
    const count = formatItemCount(bin.count, {
      one: library,
      other: library + 's',
    })
    const selected = active && active.first <= index && active.last >= index
    return {
      label: interval,
      title: label + ' ' + interval + ', ' + count,
      state: selected ? 'selected' : undefined,
    } satisfies HistogramBar
  })
  const rankingAction = useResultAction('Ratings view-ranking')
  function drill(first: number, last: number) {
    const from = bins[first],
      through = bins[last]
    if (from && through) {
      rankingAction.begin()
      onDrill({
        range: { dimension, first, last },
        label,
        interval: intervalLabel(from, through),
      })
    }
  }
  return (
    <Section
      title={label}
      note={source ? '/ ' + boundary.format(source.scale) : undefined}
    >
      {coverage && (
        <div className="ds-muted">
          <div>
            {formatCount(coverage.recorded)} of {formatCount(total)} recorded
          </div>
          <div>
            {formatCount(coverage.eligible)} of {formatCount(total)}{' '}
            score-eligible
          </div>
        </div>
      )}
      <Histogram
        label={label + ' distribution'}
        bars={bars}
        counts={bins.map(({ count }) => count)}
        onSelect={(index) => drill(index, index)}
      />
      {editing ? (
        <RangeEditor
          bins={bins}
          active={active}
          onApply={drill}
          onCancel={() => onEdit(null)}
        />
      ) : (
        <div className="ds-actions">
          <Button size="xs" onClick={() => onEdit(dimension)}>
            Select range
          </Button>
        </div>
      )}
    </Section>
  )
}

export function RatingsSources({
  request,
  ready,
  onSources,
  search,
  filters,
  rangeControls,
  editing,
  onEdit,
  onDrill,
}: {
  request: RatingsSourcesRequest
  ready: boolean
  onSources: (sources: RatingsSource[]) => void
  search: ReactNode
  filters: ReactNode
  rangeControls: ReactNode
  editing: string | null
  onEdit: (dimension: string | null) => void
  onDrill: (selection: RatingSelection) => void
}) {
  const { apiBaseUrl } = useConfig()
  const { library, ranges } = request
  const query = useQuery({
    queryKey: ratingSourcesKey(request),
    queryFn: ({ signal }) => fetchRatingsSources(apiBaseUrl, request, signal),
    ...clientQueryDefaults,
    enabled: ready,
    retry: false,
  })
  const page = query.data
  useEffect(() => {
    if (page) onSources(page.sources)
  }, [page, onSources])
  return (
    <>
      <SecondaryTableToolbar
        search={search}
        filters={filters}
        count={
          <RatingsCount
            library={library}
            total={page?.total}
            failed={query.isError}
          />
        }
      />
      {rangeControls}
      <div
        className="sec-scroll ratings-sources"
        role="region"
        aria-label="Rating distributions"
        aria-busy={query.isFetching}
      >
        {query.isError && (
          <Notice
            tone="danger"
            action={
              <ReadButton size="xs" read={() => query.refetch()}>
                Retry
              </ReadButton>
            }
          >
            Could not load rating distributions.
          </Notice>
        )}
        {page && (
          <>
            <p className="ds-muted">
              Select a bar or range to open matching titles in Ranking. Each
              chart includes the other filters and ranges.
            </p>
            <div className="ratings-distributions">
              {page.histograms.map((distribution) => {
                const source = page.sources.find(
                  ({ key }) => distribution.dimension === 'native.' + key,
                )
                return (
                  <SourceDistribution
                    key={distribution.dimension}
                    distribution={distribution}
                    source={source}
                    coverage={
                      source &&
                      page.coverage.find(({ key }) => key === source.key)
                    }
                    total={page.total}
                    active={ranges.find(
                      ({ dimension }) => dimension === distribution.dimension,
                    )}
                    editing={editing === distribution.dimension}
                    onEdit={onEdit}
                    onDrill={onDrill}
                    library={library}
                  />
                )
              })}
            </div>
          </>
        )}
      </div>
    </>
  )
}
