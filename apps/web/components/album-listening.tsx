'use client'

import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AlbumListeningSchema } from '@repo/schemas/lastfm'
import { Button } from '@repo/ui/components/ui/button'
import { useConfig } from './providers'
import { fetchApiData } from '@/utils/api'
import {
  albumListeningPath,
  listeningBars,
  type ListeningBar,
  type ListeningPeriod,
} from '@/utils/listening-chart'

export function useAlbumListening(
  albumId: string,
  track: string,
  enabled = true,
) {
  const { apiBaseUrl } = useConfig()
  return useQuery({
    queryKey: ['album-listening', albumId, track],
    enabled,
    // Keep the track list while switching tracks, never across albums.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === albumId ? previous : undefined,
    queryFn: () =>
      fetchApiData(
        apiBaseUrl,
        albumListeningPath(albumId, track),
        AlbumListeningSchema,
      ),
  })
}

function formatDate(value: string | null) {
  return value ? new Date(value).toLocaleDateString() : '-'
}

function scrobbleLabel(count: number) {
  return `${count.toLocaleString()} ${count === 1 ? 'scrobble' : 'scrobbles'}`
}

export function ListeningChart({
  bars,
  period,
}: {
  bars: ListeningBar[]
  period: ListeningPeriod
}) {
  const scroller = useRef<HTMLDivElement>(null)
  const showCounts = period === 'year' || bars.length <= 24
  useEffect(() => {
    const element = scroller.current
    if (element) element.scrollLeft = element.scrollWidth
  }, [bars, period])
  return (
    <div
      ref={scroller}
      className="overflow-x-auto pb-1"
      tabIndex={0}
      aria-label={
        period === 'year' ? 'Scrobbles by year' : 'Scrobbles by month'
      }
      role="group"
    >
      <ol className="flex h-48 items-end gap-0.5 border-b border-slate-300 pt-5">
        {bars.map((bar, index) => {
          const yearStart =
            period === 'year' || index === 0 || bar.period.endsWith('-01')
          return (
            <li
              key={bar.period}
              title={`${bar.period}: ${scrobbleLabel(bar.count)}`}
              className={`relative flex h-full flex-col justify-end ${
                period === 'year' ? 'min-w-6 flex-1' : 'w-2.5 shrink-0'
              }`}
            >
              <span className="sr-only">
                {bar.period}: {scrobbleLabel(bar.count)}
              </span>
              {showCounts && bar.count > 0 && (
                <span
                  aria-hidden="true"
                  className="text-center text-[11px] tabular-nums text-slate-600"
                >
                  {bar.count.toLocaleString()}
                </span>
              )}
              <span
                aria-hidden="true"
                className="block bg-slate-500 hover:bg-slate-700"
                style={{ height: `${bar.share}%` }}
              />
              {yearStart && (
                <span
                  aria-hidden="true"
                  className={`absolute top-full mt-1 whitespace-nowrap text-[11px] tabular-nums text-slate-600 ${
                    period === 'year' ? 'inset-x-0 text-center' : 'left-0'
                  }`}
                >
                  {bar.year}
                </span>
              )}
            </li>
          )
        })}
      </ol>
      <div className="h-5" aria-hidden="true" />
    </div>
  )
}

export default function AlbumListening({ albumId }: { albumId: string }) {
  const [track, setTrack] = useState('')
  const [period, setPeriod] = useState<ListeningPeriod>('year')
  const listening = useAlbumListening(albumId, track)
  if (listening.isPending) return <p>Loading listening history...</p>
  if (listening.isError)
    return (
      <p role="alert">
        Listening history unavailable.{' '}
        <Button onClick={() => listening.refetch()}>Retry</Button>
      </p>
    )
  const data = listening.data
  if (!track && data.total === 0)
    return <p className="quiet">No scrobbles linked to this album.</p>
  const bars = listeningBars(data.months, period)
  return (
    <div>
      <dl className="detail-metrics">
        <div>
          <dt>Scrobbles</dt>
          <dd>{data.total.toLocaleString()}</dd>
        </div>
        <div>
          <dt>First listened</dt>
          <dd>{formatDate(data.firstListenedAt)}</dd>
        </div>
        <div>
          <dt>Last listened</dt>
          <dd>{formatDate(data.lastListenedAt)}</dd>
        </div>
      </dl>
      <div className="mb-4 flex flex-wrap items-center gap-3 text-sm">
        <label className="flex items-center gap-2">
          Track
          <select
            value={track}
            onChange={(event) => setTrack(event.target.value)}
          >
            <option value="">All tracks</option>
            {data.tracks.map((item) => (
              <option key={item.key} value={item.key}>
                {item.position === null ? '' : `${item.position}. `}
                {item.title} ({item.count.toLocaleString()})
              </option>
            ))}
          </select>
        </label>
        <div role="group" aria-label="Chart period" className="flex gap-1">
          {(['year', 'month'] satisfies ListeningPeriod[]).map((value) => (
            <Button
              key={value}
              size="sm"
              variant={period === value ? 'default' : 'outline'}
              aria-pressed={period === value}
              onClick={() => setPeriod(value)}
            >
              {value === 'year' ? 'Year' : 'Month'}
            </Button>
          ))}
        </div>
        {listening.isPlaceholderData && (
          <span role="status" className="quiet">
            Loading...
          </span>
        )}
      </div>
      {bars.length ? (
        <ListeningChart bars={bars} period={period} />
      ) : (
        <p className="quiet">No scrobbles for this track.</p>
      )}
    </div>
  )
}
