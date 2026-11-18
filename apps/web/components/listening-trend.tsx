'use client'

import { useQuery } from '@tanstack/react-query'
import { ListeningSeriesSchema } from '@repo/schemas/lastfm'
import { Section, Stats } from '@repo/ui/components/ds/facts'
import { Skeleton, State } from '@repo/ui/components/ds/feedback'
import { EmptyValue } from '@repo/ui/components/ds/pill'
import { TrendChart } from '@repo/ui/components/ds/trend-chart'
import { Button } from '@repo/ui/components/ui/button'
import { formatCount } from '@repo/ui/lib/format'
import { fetchApiData } from '@/utils/api'
import {
  listeningSeriesKey,
  listeningSeriesPath,
  type ListeningSeriesKind,
} from '@/utils/listening-series'
import { useConfig } from './providers'

export type ListeningTrendKind = ListeningSeriesKind

/** Daily and monthly scrobble counts for one album, track, artist or playlist. */
export function useListeningSeries(
  kind: ListeningTrendKind,
  id: string,
  enabled = true,
) {
  const { apiBaseUrl } = useConfig()
  return useQuery({
    queryKey: listeningSeriesKey(kind, id),
    enabled,
    queryFn: ({ signal }) =>
      fetchApiData(
        apiBaseUrl,
        listeningSeriesPath(kind, id),
        ListeningSeriesSchema,
        { signal },
      ),
  })
}

/** A stored UTC date, shown as stored. */
export function ListeningDate({ value }: { value: string | null }) {
  return value ? <>{value}</> : <EmptyValue />
}

/** The skeleton of a stats row and a chart. */
export function ListeningSkeleton({ height = 168 }: { height?: number }) {
  return (
    <div className="data-stack" role="status" aria-busy="true">
      <span className="sr-only">Loading listening history</span>
      <Skeleton height={36} width="60%" />
      <Skeleton height={height} />
    </div>
  )
}

/** The scrobble trend for one album, track, artist or playlist. */
export function ListeningTrend({
  kind,
  id,
}: {
  kind: ListeningTrendKind
  id: string
}) {
  const series = useListeningSeries(kind, id)
  const data = series.data
  return (
    <Section title="Listening">
      {!data ? (
        series.isError ? (
          <State
            title="Could not load listening history"
            error
            size="sm"
            action={
              <Button size="xs" onClick={() => series.refetch()}>
                Retry
              </Button>
            }
          />
        ) : (
          <ListeningSkeleton />
        )
      ) : data.total === 0 ? (
        <State title="No scrobbles yet" size="sm" />
      ) : (
        <>
          <Stats
            items={[
              { label: 'scrobbles', value: formatCount(data.total) },
              {
                label: 'first played',
                value: <ListeningDate value={data.firstDate} />,
              },
              {
                label: 'last played',
                value: <ListeningDate value={data.lastDate} />,
              },
            ]}
          />
          <TrendChart
            days={data.days}
            months={data.months}
            from={data.historyFrom ?? undefined}
          />
        </>
      )}
    </Section>
  )
}
