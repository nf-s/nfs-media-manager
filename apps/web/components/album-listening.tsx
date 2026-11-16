'use client'

import Link from 'next/link'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  AlbumListeningSchema,
  type AlbumListening as AlbumListeningData,
  type ListeningSource,
} from '@repo/schemas/lastfm'
import { Section, Stats } from '@repo/ui/components/ds/facts'
import { Notice, State } from '@repo/ui/components/ds/feedback'
import { Meter } from '@repo/ui/components/ds/meter'
import { EmptyValue, Pill } from '@repo/ui/components/ds/pill'
import { Select } from '@repo/ui/components/ds/toolbar'
import { TrendChart } from '@repo/ui/components/ds/trend-chart'
import { Button } from '@repo/ui/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@repo/ui/components/ui/table'
import { formatCount, formatDate } from '@repo/ui/lib/format'
import { useConfig } from './providers'
import {
  ScrobbledNamePicker,
  useLastfmLinkUpdate,
} from './lastfm-link-controls'
import { errorMessage } from './lastfm-sync'
import {
  ListeningDate,
  ListeningSkeleton,
  useListeningSeries,
} from './listening-trend'
import { fetchApiData } from '@/utils/api'
import {
  albumListeningPath,
  busiestMonth,
  formatListeningMonth,
} from '@/utils/listening-series'

const TOP_TRACKS = 6

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

type ScrobbleName = ListeningSource & { linked: boolean }

/**
 * Scrobbled artist and album names linked to the album, then similar names
 * that are not, each with its scrobble count and Link or Unlink.
 */
export function ListeningSources({
  albumId,
  data,
}: {
  albumId: string
  data: Pick<AlbumListeningData, 'sources' | 'similarUnlinked'>
}) {
  const update = useLastfmLinkUpdate()
  const [adding, setAdding] = useState(false)
  const link = (name: { artistName: string; albumName: string }) =>
    update.mutate({
      action: 'link',
      artistName: name.artistName,
      albumName: name.albumName,
      albumId,
    })
  const names: ScrobbleName[] = [
    ...data.sources.map((source) => ({ ...source, linked: true })),
    ...data.similarUnlinked.map((source) => ({ ...source, linked: false })),
  ]
  return (
    <div className="data-stack">
      {names.length > 0 && (
        <Table aria-label="Scrobble names" layout="fixed">
          <TableHeader>
            <TableRow>
              <TableHead sticky={0} stickyEdge>
                Scrobbled as
              </TableHead>
              <TableHead>Artist</TableHead>
              <TableHead align="end" style={{ width: 88 }}>
                Scrobbles
              </TableHead>
              <TableHead align="end" style={{ width: 84 }}>
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {names.map((name) => {
              const label = `${name.artistName} — ${name.albumName}`
              return (
                <TableRow key={`${name.linked}\u0000${label}`}>
                  <TableCell sticky={0} stickyEdge>
                    <span className="ds-cell-id">
                      <span className="ds-cell-title" title={label}>
                        {name.albumName}
                      </span>
                      {name.manual && (
                        <Pill tone="outline">Linked manually</Pill>
                      )}
                    </span>
                  </TableCell>
                  <TableCell>{name.artistName}</TableCell>
                  <TableCell align="end" className="ds-num">
                    {formatCount(name.count)}
                  </TableCell>
                  <TableCell align="end">
                    <Button
                      size="xs"
                      variant={name.linked ? 'ghost' : 'default'}
                      disabled={update.isPending}
                      aria-label={`${name.linked ? 'Unlink' : 'Link'} ${label}`}
                      onClick={() =>
                        name.linked
                          ? update.mutate({
                              action: 'unlink',
                              artistName: name.artistName,
                              albumName: name.albumName,
                            })
                          : link(name)
                      }
                    >
                      {name.linked ? 'Unlink' : 'Link'}
                    </Button>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      )}
      <div className="ds-actions">
        <Button
          size="xs"
          aria-expanded={adding}
          onClick={() => setAdding(!adding)}
        >
          Add scrobbled name
        </Button>
        <Button size="xs" variant="link" asChild>
          <Link href="/imports/lastfm?mediaType=album&reason=unlinked">
            Review scrobble links
          </Link>
        </Button>
      </div>
      {adding && (
        <ScrobbledNamePicker disabled={update.isPending} onPick={link} />
      )}
      {update.isError && (
        <Notice tone="danger">
          {errorMessage(update.error, 'Could not update the link.')}
        </Notice>
      )}
    </div>
  )
}

/** One line per scrobbled track, most played first. */
function TracksByScrobbles({
  tracks,
}: {
  tracks: AlbumListeningData['tracks']
}) {
  const [all, setAll] = useState(false)
  if (!tracks.length) return null
  const ranked = [...tracks].sort((left, right) => right.count - left.count)
  const shown = all ? ranked : ranked.slice(0, TOP_TRACKS)
  const most = ranked[0]?.count ?? 1
  return (
    <Section
      title="By track"
      aside={
        tracks.length > TOP_TRACKS && (
          <Button
            size="xs"
            variant="link"
            aria-expanded={all}
            onClick={() => setAll(!all)}
          >
            {all ? `Top ${TOP_TRACKS}` : `All ${formatCount(tracks.length)}`}
          </Button>
        )
      }
    >
      <Table aria-label="Scrobbles by track" layout="fixed">
        <TableHeader>
          <TableRow>
            <TableHead align="end" style={{ width: 40 }}>
              #
            </TableHead>
            <TableHead>Title</TableHead>
            <TableHead align="end" style={{ width: 88 }}>
              Scrobbles
            </TableHead>
            <TableHead style={{ width: 120 }}>
              <span className="sr-only">Share</span>
            </TableHead>
            <TableHead style={{ width: 104 }}>Last played</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {shown.map((track) => (
            <TableRow key={track.key}>
              <TableCell align="end" className="ds-muted ds-num">
                {track.position ?? <EmptyValue />}
              </TableCell>
              <TableCell>
                <span className="ds-cell-title" title={track.title}>
                  {track.title}
                </span>
              </TableCell>
              <TableCell align="end" className="ds-num">
                {formatCount(track.count)}
              </TableCell>
              <TableCell>
                <Meter value={(track.count / most) * 100} />
              </TableCell>
              <TableCell className="ds-num">
                {formatDate(track.lastListenedAt)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Section>
  )
}

export default function AlbumListening({
  albumId,
  onOpenSources,
}: {
  albumId: string
  /** Opens the Last.fm row in Sources, where scrobble names are matched. Without it the names are listed here. */
  onOpenSources?: () => void
}) {
  const [track, setTrack] = useState('')
  const series = useListeningSeries('album', albumId)
  const listening = useAlbumListening(albumId, track)
  const summary = series.data
  const data = listening.data
  if (!summary || !data) {
    if ((series.isError && !summary) || (listening.isError && !data))
      return (
        <State
          title="Could not load listening history"
          error
          action={
            <Button
              onClick={() => {
                if (series.isError) void series.refetch()
                if (listening.isError) void listening.refetch()
              }}
            >
              Retry
            </Button>
          }
        />
      )
    return <ListeningSkeleton />
  }
  const busiest = busiestMonth(summary.months)
  const names = onOpenSources ? (
    <Notice
      action={
        <Button size="xs" onClick={onOpenSources}>
          Open Sources
        </Button>
      }
    >
      Scrobble names are matched in Sources, under Last.fm.
    </Notice>
  ) : (
    <Section title="Scrobble names">
      <ListeningSources albumId={albumId} data={data} />
    </Section>
  )
  if (summary.total === 0)
    return (
      <div>
        <Section flush>
          <State title="No scrobbles yet" size="sm" />
        </Section>
        {names}
      </div>
    )
  return (
    <div>
      <Section flush>
        <Stats
          items={[
            { label: 'scrobbles', value: formatCount(summary.total) },
            {
              label: 'first played',
              value: <ListeningDate value={summary.firstDate} />,
            },
            {
              label: 'last played',
              value: <ListeningDate value={summary.lastDate} />,
            },
            {
              label: 'busiest month',
              value: busiest ? (
                formatListeningMonth(busiest.month)
              ) : (
                <EmptyValue />
              ),
            },
          ]}
        />
      </Section>
      <Section title="Over time">
        <div aria-busy={listening.isPlaceholderData}>
          <TrendChart
            key={track}
            days={track ? [] : summary.days}
            months={track ? data.months : summary.months}
            monthsOnly={Boolean(track)}
            ranges={track ? ['1y', '5y', 'all'] : undefined}
            extra={
              <Select
                aria-label="Track"
                value={track}
                onChange={(event) => setTrack(event.target.value)}
              >
                <option value="">All tracks</option>
                {data.tracks.map((item) => (
                  <option key={item.key} value={item.key}>
                    {item.position === null ? '' : `${item.position}. `}
                    {item.title} ({formatCount(item.count)})
                  </option>
                ))}
              </Select>
            }
          />
        </div>
      </Section>
      <TracksByScrobbles tracks={data.tracks} />
      {names}
    </div>
  )
}
