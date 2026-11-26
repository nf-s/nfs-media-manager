'use client'

import { ReadButton } from './read-button'
import Link from 'next/link'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  AlbumListeningSchema,
  type AlbumListening as AlbumListeningData,
  type ListeningSource,
} from '@repo/schemas/lastfm'
import type { LibraryChange } from '@repo/schemas/library-changes'
import { Section, Stats } from '@repo/ui/components/ds/facts'
import { Notice, State } from '@repo/ui/components/ds/feedback'
import { Meter } from '@repo/ui/components/ds/meter'
import { EmptyValue, Pill } from '@repo/ui/components/ds/pill'
import { Select } from '@repo/ui/components/ds/toolbar'
import { TrendChart } from '@repo/ui/components/ds/trend-chart'
import { Button, mutationFeedback } from '@repo/ui/components/ui/button'
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
import { useTableWidths } from './secondary-table'
import { DetailLink } from './detail-link'
import {
  ScrobbledNamePicker,
  useLastfmLinkUpdate,
} from './lastfm-link-controls'
import { errorMessage } from './lastfm-sync'
import { AlbumChangeNotice, albumNameMoveAdapter } from './album-merge-review'
import { useMerge } from './merge-bar'
import {
  ListeningDate,
  ListeningSkeleton,
  useListeningSeries,
} from './listening-trend'
import { fetchApiData } from '@/utils/api'
import { albumNameKey } from '@/utils/album-merges'
import {
  albumListeningPath,
  busiestMonth,
  formatListeningMonth,
} from '@/utils/listening-series'

const TOP_TRACKS = 6
const nameColumns = [
  { key: 'albumName', label: 'Scrobbled as', width: 220, fill: true },
  { key: 'artistName', label: 'Artist', width: 160 },
  { key: 'scrobbles', label: 'Scrobbles', width: 88 },
]
/** Room for Link or Unlink. */
const nameActionsWidth = 84
const trackColumns = [
  { key: 'position', label: '#', width: 48 },
  { key: 'title', label: 'Title', width: 200, fill: true },
  { key: 'scrobbles', label: 'Scrobbles', width: 88 },
  { key: 'share', label: 'Share', width: 120 },
  { key: 'lastListenedAt', label: 'Last played', width: 104 },
]

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
  // The last name merged here, with Undo; kept apart so Undo can update it.
  const [moved, setMoved] = useState<LibraryChange | null>(null)
  const [linkingKey, setLinkingKey] = useState<string | null>(null)
  const move = useMerge(albumNameMoveAdapter, { onMerge: setMoved })
  const pending = update.isPending || move.pending
  const widths = useTableWidths('album-scrobble-names', nameColumns)
  const layout = widths.layout([
    ...nameColumns.map((column) => column.key),
    nameActionsWidth,
  ])
  // Linking a name merges it into this album, as a change that can be undone.
  const link = (name: { artistName: string; albumName: string }) => {
    if (pending) return
    setMoved(null)
    update.reset()
    const key = albumNameKey(name)
    setLinkingKey(key)
    void move.merge([key], albumId)
  }
  const unlink = (name: { artistName: string; albumName: string }) => {
    if (pending) return
    setMoved(null)
    move.clearError()
    setLinkingKey(null)
    update.mutate({
      action: 'unlink',
      artistName: name.artistName,
      albumName: name.albumName,
    })
  }
  const names: ScrobbleName[] = [
    ...data.sources.map((source) => ({ ...source, linked: true })),
    ...data.similarUnlinked.map((source) => ({ ...source, linked: false })),
  ]
  return (
    <div className="data-stack">
      {names.length > 0 && (
        <Table aria-label="Scrobble names" {...layout.table}>
          {layout.colgroup}
          <TableHeader>
            <TableRow>
              <TableHead
                sticky={0}
                stickyEdge
                resizer={widths.resizer('albumName')}
              >
                Scrobbled as
              </TableHead>
              <TableHead resizer={widths.resizer('artistName')}>
                Artist
              </TableHead>
              <TableHead align="end" resizer={widths.resizer('scrobbles')}>
                Scrobbles
              </TableHead>
              <TableHead align="end">
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
                      disabled={pending}
                      aria-label={`${name.linked ? 'Unlink' : 'Link'} ${label}`}
                      feedback={
                        linkingKey === albumNameKey(name)
                          ? move.feedback
                          : update.variables?.artistName === name.artistName &&
                              update.variables.albumName === name.albumName
                            ? mutationFeedback(update, {
                                pending: 'Unlinking…',
                                success: 'Unlinked',
                                error: 'Could not unlink',
                              })
                            : undefined
                      }
                      onClick={() => (name.linked ? unlink(name) : link(name))}
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
        <ScrobbledNamePicker
          disabled={pending}
          onPick={link}
          feedback={(name) =>
            linkingKey === albumNameKey(name) ? move.feedback : undefined
          }
        />
      )}
      {update.isSuccess && update.variables && (
        <p role="status">Unlinked {update.variables.albumName}.</p>
      )}
      {moved && (
        <AlbumChangeNotice
          change={moved}
          onChange={setMoved}
          onDismiss={() => setMoved(null)}
        />
      )}
      {move.error && !move.review && (
        <Notice tone="danger">{move.error}</Notice>
      )}
      {update.isError && (
        <Notice tone="danger">
          {errorMessage(update.error, 'Could not update the link.')}
        </Notice>
      )}
      {move.dialog}
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
  const widths = useTableWidths('album-track-scrobbles', trackColumns)
  if (!tracks.length) return null
  const layout = widths.layout(trackColumns.map((column) => column.key))
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
      <Table aria-label="Scrobbles by track" {...layout.table}>
        {layout.colgroup}
        <TableHeader>
          <TableRow>
            <TableHead align="end" resizer={widths.resizer('position')}>
              #
            </TableHead>
            <TableHead resizer={widths.resizer('title')}>Title</TableHead>
            <TableHead align="end" resizer={widths.resizer('scrobbles')}>
              Scrobbles
            </TableHead>
            <TableHead resizer={widths.resizer('share')}>
              <span className="sr-only">Share</span>
            </TableHead>
            <TableHead resizer={widths.resizer('lastListenedAt')}>
              Last played
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {shown.map((track) => (
            <TableRow key={track.key}>
              <TableCell align="end" className="ds-muted ds-num">
                {track.position ?? <EmptyValue />}
              </TableCell>
              <TableCell>
                {track.trackId ? (
                  <DetailLink
                    className="ds-cell-title"
                    kind="track"
                    id={track.trackId}
                    tab="sources"
                    title={track.title}
                  >
                    {track.title}
                  </DetailLink>
                ) : (
                  <span className="ds-cell-title" title={track.title}>
                    {track.title}
                  </span>
                )}
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
            <ReadButton
              read={() =>
                Promise.all([
                  series.isError && series.refetch(),
                  listening.isError && listening.refetch(),
                ])
              }
            >
              Retry
            </ReadButton>
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
            from={summary.historyFrom ?? undefined}
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
