'use client'

import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import type {
  RatingsRange,
  RatingsSource,
  RatingsSourcesPage,
  RatingsSourcesRequest,
} from '@repo/schemas/ratings-explorer'
import { Facts, Section, Stats } from '@repo/ui/components/ds/facts'
import { Notice } from '@repo/ui/components/ds/feedback'
import { Histogram } from '@repo/ui/components/ds/histogram'
import { Progress } from '@repo/ui/components/ds/meter'
import { Button } from '@repo/ui/components/ui/button'
import { EMPTY_VALUE, formatCount } from '@repo/ui/lib/format'
import { clientQueryDefaults } from '@/utils/query-cache'
import {
  fetchRatingsSources,
  ratingSourcesKey,
} from '@/utils/ratings-explorer-api'
import { ReadButton } from './read-button'
import { useConfig } from './providers'
import { settingFor } from './ratings-explorer-scoring'

type Distribution = RatingsSourcesPage['histograms'][number]
export type RatingSelection = {
  range: RatingsRange
  label: string
  interval: string
}

const number = new Intl.NumberFormat('en', { maximumFractionDigits: 2 })
function value(n?: number | null) {
  return n == null ? EMPTY_VALUE : number.format(n)
}

export function RatingsSources({
  request,
  ready,
  onSources,
  onSelect,
}: {
  request: RatingsSourcesRequest
  ready: boolean
  onSources: (sources: RatingsSource[]) => void
  onSelect: (dimension: string, selection?: RatingSelection) => void
}) {
  const { apiBaseUrl } = useConfig()
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
  const library = request.library
  function distribution(hist: Distribution) {
    const { dimension, bins } = hist
    const source = page?.sources.find((s) => dimension === 'native.' + s.key)
    const label =
      source?.label ??
      (dimension === 'counted'
        ? 'Ratings counted'
        : dimension === 'score'
          ? 'Score'
          : 'Spread')
    const active = request.ranges.find((r) => r.dimension === dimension)
    const binLabel = (index: number) =>
      dimension === 'spread' && index === 9 ? '36+' : value(bins[index]?.lower)
    function pick(index: number) {
      if (active?.first === index && active.last === index) {
        onSelect(dimension)
        return
      }
      const extend = active && (index < active.first || index > active.last)
      const first = extend ? Math.min(index, active.first) : index
      const last = extend ? Math.max(index, active.last) : index
      const lo = bins[first],
        hi = bins[last]
      if (!lo || !hi) return
      const interval =
        dimension === 'spread' && last === 9
          ? value(lo.lower) + '+'
          : lo.lower === hi.upper
            ? value(lo.lower)
            : value(lo.lower) + '–' + value(hi.upper)
      onSelect(dimension, {
        range: { dimension, first, last },
        label,
        interval,
      })
    }
    const coverage = source && page?.coverage.find((c) => c.key === source.key)
    return (
      <Section
        key={dimension}
        title={label}
        note={
          source
            ? 'out of ' + value(source.scale)
            : dimension === 'score'
              ? '0–100'
              : dimension === 'counted'
                ? 'per item'
                : 'points between ratings'
        }
        aside={
          active && (
            <Button size="xs" onClick={() => onSelect(dimension)}>
              Clear
            </Button>
          )
        }
      >
        <Histogram
          label={label + ' distribution'}
          bars={bins.map((b, i) => ({
            label: binLabel(i),
            title:
              label +
              ' from ' +
              binLabel(i) +
              ': ' +
              formatCount(b.count) +
              ' items',
            state:
              active && i >= active.first && i <= active.last
                ? 'selected'
                : undefined,
          }))}
          counts={bins.map((b) => b.count)}
          onSelect={pick}
        />
        {(source || dimension === 'score') && (
          <Progress
            done={bins.reduce((sum, b) => sum + b.count, 0)}
            total={hist.population}
          />
        )}
        {source && (
          <Facts
            items={[
              { label: 'Median', value: value(hist.quartiles?.[1]) },
              {
                label: 'Middle half',
                value: hist.quartiles
                  ? value(hist.quartiles[0]) + '–' + value(hist.quartiles[2])
                  : EMPTY_VALUE,
              },
              { label: 'Typical votes', value: value(hist.typicalVotes) },
              {
                label: 'Weight',
                value: '×' + settingFor(source, request.settings).weight,
              },
              ...(coverage
                ? [
                    {
                      label: 'Recorded',
                      value:
                        formatCount(coverage.recorded) +
                        ' of ' +
                        formatCount(page?.total ?? 0),
                    },
                    {
                      label: 'Score-eligible',
                      value:
                        formatCount(coverage.eligible) +
                        ' of ' +
                        formatCount(page?.total ?? 0),
                    },
                  ]
                : []),
            ]}
          />
        )}
        {dimension === 'spread' && (
          <p className="ds-help">
            Standard deviation of the counted ratings. Low means the sources
            agree.
          </p>
        )}
        {dimension === 'counted' && (
          <p className="ds-help">How many weighted sources rate each item.</p>
        )}
      </Section>
    )
  }
  return (
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
          <Stats
            items={[
              { label: library + 's shown', value: formatCount(page.total) },
              { label: 'With a score', value: formatCount(page.scored) },
              {
                label: 'Ratings per item, median',
                value: value(page.medianCounted),
              },
              { label: 'Spread, median', value: value(page.medianSpread) },
            ]}
          />
          <p className="ds-help">
            Pick bars to keep only the items in that range. Each chart counts
            the items that pass every other filter.
          </p>
          <div className="ratings-distributions">
            {[
              ...page.histograms.filter(
                (h) => !h.dimension.startsWith('native.'),
              ),
              ...page.histograms.filter((h) =>
                h.dimension.startsWith('native.'),
              ),
            ].map(distribution)}
          </div>
        </>
      )}
    </div>
  )
}
