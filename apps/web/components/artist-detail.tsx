'use client'

import Link from 'next/link'
import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { z } from 'zod'
import { Disc3, UserRound } from 'lucide-react'
import {
  ArtistAlbumPageSchema,
  ArtistDetailSchema,
  ArtistPlaylistPageSchema,
  ArtistTrackPageSchema,
  type ArtistDetail as Artist,
} from '@repo/schemas/creators'
import type { AlbumListItem } from '@repo/schemas/media'
import {
  SubscriptionItemPageSchema,
  type SubscriptionItem,
} from '@repo/schemas/subscriptions'
import { formatTagName } from '@repo/schemas/tags'
import type { TrackListItem } from '@repo/schemas/tracks'
import { Art, ArtFallback } from '@repo/ui/components/ds/artwork'
import { Card, CardGrid, CardTitle } from '@repo/ui/components/ds/card'
import {
  DetailActionsSpacer,
  DetailHeader,
} from '@repo/ui/components/ds/detail-header'
import { Section } from '@repo/ui/components/ds/facts'
import { Notice, Skeleton } from '@repo/ui/components/ds/feedback'
import { Button } from '@repo/ui/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@repo/ui/components/ui/table'
import { TabsContent } from '@repo/ui/components/ui/tabs'
import {
  EMPTY_VALUE,
  formatCount,
  formatDate,
  formatTrackLength,
} from '@repo/ui/lib/format'
import { fetchApiData } from '@/utils/api'
import { artistBrowseHref, artistTagBrowseHref } from '@/utils/creator-browse'
import { safeRatingHref } from '@/utils/provider-ratings'
import {
  formatSubscriptionDuration,
  formatSubscriptionPublished,
  subscriptionArtworkUrl,
} from '@/utils/subscriptions'
import {
  ArtistProfileLinks,
  ArtistProfileSources,
} from './artist-profile-sources'
import { CreatorDetailState } from './creator-detail-state'
import { DetailMore } from './detail-more'
import {
  CreatorLibraryDate,
  CreatorLibraryTable,
  CreatorLibraryTitle,
  type CreatorLibraryColumn,
} from './creator-library-table'
import { DetailLink } from './detail-link'
import {
  DetailArt,
  DetailTabs,
  FilterPill,
  PlaylistPills,
  useDetailTab,
  type DetailTabItem,
} from './detail-frame'
import { AlbumPlay, TrackRowPlay } from './detail-play'
import { ScrobbleStats } from './listening-stats'
import { ListeningTrend } from './listening-trend'
import { MetadataCoverage } from './metadata-coverage'
import { useConfig } from './providers'
import { useTableWidths } from './secondary-table'

type ArtistTab =
  | 'overview'
  | 'albums'
  | 'tracks'
  | 'mixes'
  | 'listening'
  | 'coverage'
  | 'sources'
const artistTabs: readonly [ArtistTab, ...ArtistTab[]] = [
  'overview',
  'albums',
  'tracks',
  'mixes',
  'listening',
  'coverage',
  'sources',
]
/** Playlists were a tab before they joined the Overview. */
const artistTabAliases = {
  playlists: 'overview',
  history: 'sources',
} satisfies Record<string, ArtistTab>
/** Table settings that belong to the Albums and Tracks tabs. */
const tabViewKeys = ['q', 'sortBy', 'direction', 'view']

/** A title cell: the link, then the play pair at its end. */
function TitleCell({
  kind,
  id,
  title,
  context,
  play,
}: {
  kind: 'album' | 'track'
  id: string
  title: string
  context?: string
  play: ReactNode
}) {
  return (
    <span
      className="ds-cell-id"
      title={context ? `${title} · ${context}` : title}
    >
      <DetailLink className="ds-cell-title" kind={kind} id={id}>
        {title}
      </DetailLink>
      {context && <span className="ds-cell-sub ds-truncate">{context}</span>}
      {play}
    </span>
  )
}

const albumColumns: CreatorLibraryColumn<AlbumListItem>[] = [
  {
    key: 'title',
    label: 'Album',
    width: 300,
    fill: true,
    required: true,
    render: (album) => (
      <TitleCell
        kind="album"
        id={album.id}
        title={album.title}
        play={<AlbumPlay album={album} place="row" />}
      />
    ),
  },
  {
    key: 'releaseDate',
    label: 'Released',
    width: 110,
    render: (album) => <CreatorLibraryDate value={album.releaseDate} />,
  },
  {
    key: 'dateAdded',
    label: 'Added',
    width: 110,
    render: (album) => <CreatorLibraryDate value={album.dateAdded} />,
  },
]

const trackColumns: CreatorLibraryColumn<TrackListItem>[] = [
  {
    key: 'title',
    label: 'Track',
    width: 240,
    fill: true,
    required: true,
    render: (track) => (
      <TitleCell
        kind="track"
        id={track.id}
        title={track.title}
        context={track.album?.title ?? track.albumName ?? undefined}
        play={<TrackRowPlay track={track} />}
      />
    ),
  },
  {
    key: 'durationSec',
    label: 'Duration',
    width: 90,
    align: 'end',
    render: (track) =>
      formatTrackLength(
        track.durationSec === null ? null : track.durationSec * 1000,
      ),
  },
  {
    key: 'scrobbles',
    label: 'Scrobbles',
    width: 100,
    align: 'end',
    render: (track) => formatCount(track.scrobbles),
  },
  {
    key: 'releaseDate',
    label: 'Released',
    width: 110,
    render: (track) => <CreatorLibraryDate value={track.releaseDate} />,
  },
  {
    key: 'dateAdded',
    label: 'Added',
    width: 110,
    defaultVisible: false,
    render: (track) => <CreatorLibraryDate value={track.dateAdded} />,
  },
]

function MixBroadcast({ mix }: { mix: SubscriptionItem }) {
  return (
    <time dateTime={mix.publishedAt}>
      {formatSubscriptionPublished(mix.publishedAt, mix.publishedPrecision)}
    </time>
  )
}

/** Mixes billing the artist or named after it; the show opens its details. */
const mixColumns: CreatorLibraryColumn<SubscriptionItem>[] = [
  {
    key: 'title',
    label: 'Mix',
    required: true,
    render: (mix) => (
      <CreatorLibraryTitle kind="mix" id={mix.id} title={mix.title} />
    ),
  },
  {
    key: 'source',
    label: 'Show',
    render: (mix) => (
      <DetailLink kind="show" id={mix.sourceId}>
        {mix.sourceTitle}
      </DetailLink>
    ),
  },
  {
    key: 'publishedAt',
    label: 'Broadcast',
    className: 'whitespace-nowrap',
    render: (mix) => <MixBroadcast mix={mix} />,
  },
  {
    key: 'durationSec',
    label: 'Duration',
    align: 'end',
    render: formatSubscriptionDuration,
  },
]

/** A short list for the Overview, read from the same endpoint as its tab. */
const topTrackColumns = [
  { key: 'title', label: 'Title', width: 260, fill: true },
  { key: 'album', label: 'Album', width: 200 },
  { key: 'scrobbles', label: 'Scrobbles', width: 90 },
]

function useOverviewList<Schema extends z.ZodTypeAny>(
  path: string,
  key: string,
  params: Record<string, string>,
  schema: Schema,
) {
  const { apiBaseUrl } = useConfig()
  const search = new URLSearchParams({ page: '1', ...params })
  return useQuery({
    queryKey: ['artist-overview', path, key, search.toString()],
    queryFn: ({ signal }) =>
      fetchApiData(apiBaseUrl, `${path}/${key}?${search}`, schema, { signal }),
  })
}

function ListState({
  pending,
  label,
  retry,
}: {
  pending: boolean
  label: string
  retry: () => void
}) {
  if (pending) return <Skeleton height={64} />
  return (
    <Notice
      tone="danger"
      action={
        <Button size="xs" onClick={retry}>
          Retry
        </Button>
      }
    >
      Could not load {label}.
    </Notice>
  )
}

function ArtistOverview({
  artist,
  path,
  showTab,
}: {
  artist: Artist
  path: string
  showTab: (tab: ArtistTab) => void
}) {
  const { profile } = artist
  const albums = useOverviewList(
    path,
    'albums',
    { size: '6', sortBy: 'releaseDate', direction: 'desc' },
    ArtistAlbumPageSchema,
  )
  const tracks = useOverviewList(
    path,
    'tracks',
    { size: '5', sortBy: 'scrobbles', direction: 'desc' },
    ArtistTrackPageSchema,
  )
  const topTrackWidths = useTableWidths('artist-top-tracks', topTrackColumns)
  const topTrackLayout = topTrackWidths.layout(
    topTrackColumns.map((column) => column.key),
  )
  const playlists = useOverviewList(
    path,
    'playlists',
    { size: '24', sortBy: 'name', direction: 'asc' },
    ArtistPlaylistPageSchema,
  )
  const mixes = useOverviewList(
    path,
    'mixes',
    { size: '5', sortBy: 'publishedAt', direction: 'desc' },
    SubscriptionItemPageSchema,
  )
  const library = artist.albumCount > 0 ? 'albums' : 'tracks'
  return (
    <>
      <Section flush>
        <ScrobbleStats
          kind="artist"
          id={artist.id}
          items={[
            { label: 'playlists', value: formatCount(artist.playlistCount) },
            { label: 'added', value: formatDate(artist.createdAt) },
          ]}
        />
      </Section>
      {profile.summary && (
        <Section title="About">
          <p className="dtl-text">{profile.summary}</p>
        </Section>
      )}
      {artist.albumCount > 0 && (
        <Section
          title="Albums"
          note={formatCount(artist.albumCount)}
          aside={
            <>
              <Button
                variant="link"
                size="xs"
                onClick={() => showTab('albums')}
              >
                All albums
              </Button>
              <Link href={artistBrowseHref('albums', artist.id)}>
                Show in Albums
              </Link>
            </>
          }
        >
          {albums.data ? (
            <CardGrid min={112}>
              {albums.data.items.map((album) => (
                <Card
                  key={album.id}
                  art={
                    <Art overlay={<AlbumPlay album={album} place="tile" />}>
                      <DetailLink
                        kind="album"
                        id={album.id}
                        tabIndex={-1}
                        aria-hidden="true"
                      >
                        {album.artworkUrl ? (
                          <img
                            className="ds-artimg"
                            src={album.artworkUrl}
                            alt=""
                          />
                        ) : (
                          <ArtFallback>
                            <Disc3 className="ds-i" aria-hidden="true" />
                          </ArtFallback>
                        )}
                      </DetailLink>
                    </Art>
                  }
                  title={
                    <CardTitle>
                      <DetailLink kind="album" id={album.id}>
                        {album.title}
                      </DetailLink>
                    </CardTitle>
                  }
                  meta={
                    <>
                      <span>
                        {album.releaseDate?.slice(0, 4) ?? EMPTY_VALUE}
                      </span>
                      {album.listeningScrobbles !== undefined && (
                        <span>
                          {formatCount(album.listeningScrobbles)} scrobbles
                        </span>
                      )}
                    </>
                  }
                />
              ))}
            </CardGrid>
          ) : (
            <ListState
              pending={albums.isPending}
              label="albums"
              retry={() => albums.refetch()}
            />
          )}
        </Section>
      )}
      {artist.trackCount > 0 && (
        <Section
          title="Top tracks"
          note={formatCount(artist.trackCount)}
          aside={
            <>
              <Button
                variant="link"
                size="xs"
                onClick={() => showTab('tracks')}
              >
                All tracks
              </Button>
              <Link href={artistBrowseHref('tracks', artist.id)}>
                Show in Tracks
              </Link>
            </>
          }
        >
          {tracks.data ? (
            <Table aria-label="Top tracks" {...topTrackLayout.table}>
              {topTrackLayout.colgroup}
              <TableHeader>
                <TableRow>
                  <TableHead resizer={topTrackWidths.resizer('title')}>
                    Title
                  </TableHead>
                  <TableHead resizer={topTrackWidths.resizer('album')}>
                    Album
                  </TableHead>
                  <TableHead
                    align="end"
                    resizer={topTrackWidths.resizer('scrobbles')}
                  >
                    Scrobbles
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tracks.data.items.map((track) => (
                  <TableRow key={track.id}>
                    <TableCell>
                      <TitleCell
                        kind="track"
                        id={track.id}
                        title={track.title}
                        play={<TrackRowPlay track={track} />}
                      />
                    </TableCell>
                    <TableCell>
                      {track.album ? (
                        <DetailLink kind="album" id={track.album.id}>
                          {track.album.title}
                        </DetailLink>
                      ) : (
                        (track.albumName ?? EMPTY_VALUE)
                      )}
                    </TableCell>
                    <TableCell align="end">
                      {formatCount(track.scrobbles)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <ListState
              pending={tracks.isPending}
              label="tracks"
              retry={() => tracks.refetch()}
            />
          )}
        </Section>
      )}
      {artist.mixCount > 0 && (
        <Section
          title="Latest mixes"
          note={formatCount(artist.mixCount)}
          aside={
            <Button variant="link" size="xs" onClick={() => showTab('mixes')}>
              All mixes
            </Button>
          }
        >
          {mixes.data ? (
            <Table aria-label="Latest mixes">
              <TableHeader>
                <TableRow>
                  <TableHead>Title</TableHead>
                  <TableHead>Show</TableHead>
                  <TableHead>Broadcast</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {mixes.data.items.map((mix) => (
                  <TableRow key={mix.id}>
                    <TableCell>
                      <DetailLink
                        className="ds-cell-title"
                        kind="mix"
                        id={mix.id}
                      >
                        {mix.title}
                      </DetailLink>
                    </TableCell>
                    <TableCell>
                      <DetailLink kind="show" id={mix.sourceId}>
                        {mix.sourceTitle}
                      </DetailLink>
                    </TableCell>
                    <TableCell>
                      <MixBroadcast mix={mix} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <ListState
              pending={mixes.isPending}
              label="mixes"
              retry={() => mixes.refetch()}
            />
          )}
        </Section>
      )}
      {artist.playlistCount > 0 && (
        <Section title="Playlists" note={formatCount(artist.playlistCount)}>
          {playlists.data ? (
            <PlaylistPills
              playlists={playlists.data.items.map((playlist) => ({
                id: playlist.id,
                name: playlist.name,
                title: `${playlist.name} · ${formatCount(playlist.trackCount)} artist ${playlist.trackCount === 1 ? 'track' : 'tracks'}`,
              }))}
            />
          ) : (
            <ListState
              pending={playlists.isPending}
              label="playlists"
              retry={() => playlists.refetch()}
            />
          )}
        </Section>
      )}
      {profile.tags.length > 0 && (
        <Section title="Tags">
          <span className="ds-pills" data-wrap="">
            {profile.tags.map((tag) => (
              <FilterPill
                key={tag}
                label={formatTagName(tag)}
                href={artistTagBrowseHref(library, tag)}
                title={`Filter ${library} by artist tag ${formatTagName(tag)}`}
              />
            ))}
          </span>
        </Section>
      )}
    </>
  )
}

export function ArtistDetail({ id }: { id: string }) {
  const { apiBaseUrl } = useConfig()
  const { tab, setTab } = useDetailTab(artistTabs, {
    aliases: artistTabAliases,
    reset: tabViewKeys,
  })
  const path = `/api/v1/artists/${encodeURIComponent(id)}`
  const query = useQuery({
    queryKey: ['artist', id],
    queryFn: ({ signal }) =>
      fetchApiData(
        apiBaseUrl,
        `${path}?includeHistory=false`,
        ArtistDetailSchema,
        { signal },
      ),
  })
  if (!query.data)
    return (
      <CreatorDetailState
        pending={query.isPending}
        retry={query.refetch}
        subject="artist"
      />
    )
  const artist = query.data
  const artwork = safeRatingHref(
    artist.profile.artworkUrl ?? artist.artworkUrl ?? undefined,
  )
  const { profile } = artist
  const allTabs: DetailTabItem<ArtistTab>[] = [
    { value: 'overview', label: 'Overview' },
    { value: 'albums', label: 'Albums', count: artist.albumCount },
    { value: 'tracks', label: 'Tracks', count: artist.trackCount },
    { value: 'mixes', label: 'Mixes', count: artist.mixCount },
    { value: 'listening', label: 'Listening' },
    { value: 'coverage', label: 'Coverage' },
    { value: 'sources', label: 'Sources' },
  ]
  // Mixes is shown only for an artist with mixes.
  const tabs = allTabs.filter(
    (item) => item.value !== 'mixes' || artist.mixCount > 0,
  )
  const shownTab = tab === 'mixes' && artist.mixCount === 0 ? 'overview' : tab
  return (
    <article className="dtl-detail">
      {query.isRefetchError && (
        <CreatorDetailState stale retry={query.refetch} subject="artist" />
      )}
      <DetailHeader
        art={
          <DetailArt
            src={artwork}
            ratio="round"
            fallback={<UserRound className="ds-i" aria-hidden="true" />}
          />
        }
        kind="Artist"
        title={artist.name}
        by={
          profile.name && profile.name !== artist.name
            ? `Profile: ${profile.name}`
            : undefined
        }
        facts={[
          profile.country,
          profile.type,
          `${formatCount(artist.albumCount)} ${artist.albumCount === 1 ? 'album' : 'albums'}`,
          `${formatCount(artist.trackCount)} ${artist.trackCount === 1 ? 'track' : 'tracks'}`,
        ]}
        actions={
          <>
            <DetailActionsSpacer />
            <ArtistProfileLinks
              snapshots={artist.providers}
              identifiers={artist.identifiers}
            />
            <DetailMore crumb={{ title: artist.name }} />
          </>
        }
      />
      <DetailTabs
        label="Artist details"
        value={shownTab}
        onChange={setTab}
        tabs={tabs}
      >
        <TabsContent value="overview">
          <ArtistOverview
            artist={artist}
            path={path}
            showTab={(next) => setTab(next)}
          />
        </TabsContent>
        <TabsContent value="albums">
          <CreatorLibraryTable
            kind="album"
            queryKey={['artist', id, 'albums']}
            path={`${path}/albums`}
            schema={ArtistAlbumPageSchema}
            columns={albumColumns}
            card={(album) => ({
              title: album.title,
              artworkUrl: album.artworkUrl,
              metadata: album.releaseDate && (
                <CreatorLibraryDate value={album.releaseDate} />
              ),
              actions: <AlbumPlay album={album} place="row" />,
            })}
            label="albums"
            defaultSort={{ key: 'title', direction: 'asc' }}
          />
        </TabsContent>
        <TabsContent value="tracks">
          <CreatorLibraryTable
            kind="track"
            queryKey={['artist', id, 'tracks']}
            path={`${path}/tracks`}
            schema={ArtistTrackPageSchema}
            columns={trackColumns}
            card={(track) => ({
              title: track.title,
              artworkUrl: track.artworkUrl,
              subtitle: track.album?.title ?? track.albumName ?? undefined,
              metadata:
                track.durationSec !== null &&
                formatTrackLength(track.durationSec * 1000),
              actions: <TrackRowPlay track={track} />,
            })}
            label="tracks"
            defaultSort={{ key: 'title', direction: 'asc' }}
          />
        </TabsContent>
        {artist.mixCount > 0 && (
          <TabsContent value="mixes">
            <CreatorLibraryTable
              kind="mix"
              queryKey={['artist', id, 'mixes']}
              path={`${path}/mixes`}
              schema={SubscriptionItemPageSchema}
              columns={mixColumns}
              card={(mix) => ({
                title: mix.title,
                artworkUrl: subscriptionArtworkUrl(mix),
                subtitle: mix.sourceTitle,
                metadata: <MixBroadcast mix={mix} />,
              })}
              label="mixes"
              defaultSort={{ key: 'publishedAt', direction: 'desc' }}
            />
          </TabsContent>
        )}
        <TabsContent value="listening">
          <ListeningTrend kind="artist" id={artist.id} />
        </TabsContent>
        <TabsContent value="coverage">
          <MetadataCoverage kind="artist" id={artist.id} />
        </TabsContent>
        <TabsContent value="sources">
          <ArtistProfileSources
            id={id}
            snapshots={artist.providers}
            identifiers={artist.identifiers}
          />
        </TabsContent>
      </DetailTabs>
    </article>
  )
}
