'use client'

import { useMemo } from 'react'
import {
  Stats,
  type StatItem,
  type StatTrend,
} from '@repo/ui/components/ds/facts'
import { EmptyValue } from '@repo/ui/components/ds/pill'
import { formatCount, formatItemCount } from '@repo/ui/lib/format'
import type { ListeningSeries } from '@repo/schemas/lastfm'
import type { ListeningSeriesKind } from '@/utils/listening-series'
import {
  RECENT_LISTENING_MONTHS,
  recentListeningMonths,
} from '@/utils/listening-months'
import { ListeningDate, useListeningSeries } from './listening-trend'

const SCROBBLE = { one: 'scrobble', other: 'scrobbles' }

function scrobbleTrend(series: ListeningSeries | undefined) {
  if (!series || series.total === 0) return undefined
  const values = recentListeningMonths(series.months, new Date())
  const total = values.reduce((sum, value) => sum + value, 0)
  return {
    values,
    label: `${formatItemCount(total, SCROBBLE)} in the last ${RECENT_LISTENING_MONTHS} months`,
  }
}

/**
 * Scrobbles per month for the last 12 UTC calendar months, from the same
 * request and cache entry as the Listening chart. Undefined while loading,
 * after a failure, or when nothing is scrobbled.
 */
export function useScrobbleTrend(
  kind: ListeningSeriesKind,
  id: string,
): StatTrend | undefined {
  const { data } = useListeningSeries(kind, id)
  return useMemo(() => scrobbleTrend(data), [data])
}

/** Stats with the scrobble trend beside the stat labelled `trendOn`. */
export function ListeningStats({
  kind,
  id,
  trendOn,
  items,
}: {
  kind: ListeningSeriesKind
  id: string
  trendOn: string
  items: readonly StatItem[]
}) {
  const trend = useScrobbleTrend(kind, id)
  return (
    <Stats
      items={
        trend
          ? items.map((item) =>
              item.label === trendOn ? { ...item, trend } : item,
            )
          : items
      }
    />
  )
}

/**
 * Stats led by scrobbles, with their trend, and last played, both read from
 * the listening series: for an artist or playlist, whose detail does not
 * carry them. The two are empty until the series has loaded.
 */
export function ScrobbleStats({
  kind,
  id,
  items,
}: {
  kind: ListeningSeriesKind
  id: string
  items: readonly StatItem[]
}) {
  const { data } = useListeningSeries(kind, id)
  const trend = useMemo(() => scrobbleTrend(data), [data])
  return (
    <Stats
      items={[
        {
          label: 'scrobbles',
          value: data ? formatCount(data.total) : <EmptyValue />,
          trend,
        },
        {
          label: 'last played',
          value: <ListeningDate value={data?.lastDate ?? null} />,
        },
        ...items,
      ]}
    />
  )
}
