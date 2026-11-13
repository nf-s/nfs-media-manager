'use client'

import Link from 'next/link'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  AlbumListeningSchema,
  type AlbumListening as AlbumListeningData,
  type ListeningSource,
} from '@repo/schemas/lastfm'
import { Button } from '@repo/ui/components/ui/button'
import { useConfig } from './providers'
import {
  ScrobbledNamePicker,
  useLastfmLinkUpdate,
} from './lastfm-link-controls'
import { errorMessage } from './lastfm-sync'
import { ListeningChart } from './listening-chart'
import { fetchApiData } from '@/utils/api'
import {
  albumListeningPath,
  listeningBars,
  type ListeningChartStyle,
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

function SourceList({
  label,
  sources,
  action,
  disabled,
  onAction,
}: {
  label: string
  sources: ListeningSource[]
  action: string
  disabled: boolean
  onAction: (source: ListeningSource) => void
}) {
  return (
    <section aria-label={label} className="text-sm">
      <h3 className="font-semibold">{label}</h3>
      <ul className="grid gap-1">
        {sources.map((source) => (
          <li
            key={`${source.artistName}\u0000${source.albumName}`}
            className="flex items-center gap-2"
          >
            <Button
              size="sm"
              variant="outline"
              disabled={disabled}
              aria-label={`${action} ${source.artistName} — ${source.albumName}`}
              onClick={() => onAction(source)}
            >
              {action}
            </Button>
            <span>
              {source.artistName} — {source.albumName} ·{' '}
              <span className="tabular-nums">
                {source.count.toLocaleString()}
              </span>
              {source.manual ? ' · Linked manually' : ''}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

export function ListeningSources({
  albumId,
  data,
}: {
  albumId: string
  data: Pick<AlbumListeningData, 'sources' | 'similarUnlinked'>
}) {
  const update = useLastfmLinkUpdate()
  const [adding, setAdding] = useState(false)
  const add = (name: { artistName: string; albumName: string }) =>
    update.mutate({
      action: 'link',
      artistName: name.artistName,
      albumName: name.albumName,
      albumId,
    })
  return (
    <div className="mt-4 grid gap-3">
      {data.sources.length > 0 && (
        <SourceList
          label="Linked scrobble names"
          sources={data.sources}
          action="Remove"
          disabled={update.isPending}
          onAction={(source) =>
            update.mutate({
              action: 'unlink',
              artistName: source.artistName,
              albumName: source.albumName,
            })
          }
        />
      )}
      {data.similarUnlinked.length > 0 && (
        <SourceList
          label="Similar unlinked names"
          sources={data.similarUnlinked}
          action="Add"
          disabled={update.isPending}
          onAction={add}
        />
      )}
      <div className="grid gap-1 text-sm">
        <div className="flex flex-wrap items-center gap-3">
          <Button
            size="sm"
            variant="outline"
            aria-expanded={adding}
            onClick={() => setAdding(!adding)}
          >
            Add scrobbled name
          </Button>
          <Link
            className="underline underline-offset-2"
            href="/imports/lastfm?mediaType=album&reason=unlinked"
          >
            Review scrobble links
          </Link>
        </div>
        {adding && (
          <ScrobbledNamePicker disabled={update.isPending} onPick={add} />
        )}
        {update.isError && (
          <p role="alert">
            {errorMessage(update.error, 'Could not update the link.')}
          </p>
        )}
      </div>
    </div>
  )
}

export default function AlbumListening({ albumId }: { albumId: string }) {
  const [track, setTrack] = useState('')
  const [period, setPeriod] = useState<ListeningPeriod>('month')
  const [chartStyle, setChartStyle] = useState<ListeningChartStyle>('line')
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
    return (
      <div>
        <p className="quiet">No scrobbles linked to this album.</p>
        <ListeningSources albumId={albumId} data={data} />
      </div>
    )
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
        <div role="group" aria-label="Chart style" className="flex gap-1">
          {(['bar', 'line'] satisfies ListeningChartStyle[]).map((value) => (
            <Button
              key={value}
              size="sm"
              variant={chartStyle === value ? 'default' : 'outline'}
              aria-pressed={chartStyle === value}
              onClick={() => setChartStyle(value)}
            >
              {value === 'bar' ? 'Bar' : 'Line'}
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
        <ListeningChart bars={bars} period={period} style={chartStyle} />
      ) : (
        <p className="quiet">No scrobbles for this track.</p>
      )}
      <ListeningSources albumId={albumId} data={data} />
    </div>
  )
}
