'use client'

import { ReadButton } from '@/components/read-button'
import Link from 'next/link'
import { useContext, useEffect, useState, type ReactNode } from 'react'
import { useDetailPerformance } from '@/hooks/useDetailPerformance'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { z } from 'zod'
import { Disc3, UserRound } from 'lucide-react'
import {
  ArtistAlbumPageSchema,
  ArtistDetailSchema,
  ArtistPlaylistPageSchema,
  ArtistTrackPageSchema,
  type ArtistDetail as Artist,
} from '@repo/schemas/creators'
import {
  SubscriptionItemPageSchema,
  type SubscriptionItem,
} from '@repo/schemas/subscriptions'
import { formatTagName } from '@repo/schemas/tags'
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
import { EMPTY_VALUE, formatCount, formatDate } from '@repo/ui/lib/format'
import { fetchApiData } from '@/utils/api'
import { artistBrowseHref, artistTagBrowseHref } from '@/utils/creator-browse'
import { detailPageHref } from '@/utils/detail-inspector'
import { browseStateKeys } from '@/utils/embedded-browse'
import { safeRatingHref } from '@/utils/provider-ratings'
import { workspaceTabLinkProps } from '@/utils/workspace-tab-destination'
import {
  formatSubscriptionDuration,
  formatSubscriptionPublished,
  subscriptionArtworkUrl,
} from '@/utils/subscriptions'
import {
  ArtistProfileLinks,
  ArtistProfileSources,
} from './artist-profile-sources'
import { ArtistAlbums } from './artist-albums'
import { ArtistMergePicker } from './artist-merge-picker'
import { artistMergeAdapter } from './artist-merge-review'
import { CatalogDiscoveries, CatalogLibraryAction } from './catalog-detail'
import { CreatorDetailState } from './creator-detail-state'
import {
  InspectorEntryContext,
  useDetailInspector,
} from './detail-inspector-context'
import { DetailMore } from './detail-more'
import {
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
import { libraryItemMore } from './item-more'
import { ScrobbleStats } from './listening-stats'
import { EmbeddedTrackBrowser } from './track-browser'
import { ListeningTrend } from './listening-trend'
import { LibraryRecordChanges } from './library-changes'
import { MetadataCoverage } from './metadata-coverage'
import MetadataSourceControl from './metadata-source-control'
import { useMerge } from './merge-bar'
import { useConfig } from './providers'
import { useTableWidths } from './secondary-table'
import { TrackAlbumTableValue } from './track-browse-cells'
import { TrackSpotifyMatchAction } from './track-spotify-match-action'

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
  enabled: boolean,
) {
  const { apiBaseUrl } = useConfig()
  const search = new URLSearchParams({ page: '1', ...params })
  return useQuery({
    queryKey: ['artist-overview', path, key, search.toString()],
    enabled,
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
  retry: () => Promise<unknown>
}) {
  if (pending) return <Skeleton height={64} />
  return (
    <Notice
      tone="danger"
      action={
        <ReadButton size="xs" read={retry}>
          Retry
        </ReadButton>
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
  tabHref,
}: {
  artist: Artist
  path: string
  showTab: (tab: ArtistTab) => void
  tabHref: (tab: ArtistTab) => string
}) {
  const { profile } = artist
  const hasAlbums = artist.albumCount > 0
  const hasTracks = artist.trackCount > 0
  const hasPlaylists = artist.playlistCount > 0
  const hasMixes = artist.mixCount > 0
  const albums = useOverviewList(
    path,
    'albums',
    { size: '6', sortBy: 'releaseDate', direction: 'desc' },
    ArtistAlbumPageSchema,
    hasAlbums,
  )
  const tracks = useOverviewList(
    path,
    'tracks',
    { size: '5', sortBy: 'scrobbles', direction: 'desc' },
    ArtistTrackPageSchema,
    hasTracks,
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
    hasPlaylists,
  )
  const mixes = useOverviewList(
    path,
    'mixes',
    { size: '5', sortBy: 'publishedAt', direction: 'desc' },
    SubscriptionItemPageSchema,
    hasMixes,
  )
  const library = hasAlbums ? 'albums' : 'tracks'
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
      {hasAlbums && (
        <Section
          title="Albums"
          note={formatCount(artist.albumCount)}
          aside={
            <>
              <Button
                {...workspaceTabLinkProps(tabHref('albums'), 'All albums')}
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
                    <Art
                      overlay={
                        <AlbumPlay
                          album={album}
                          place="tile"
                          more={libraryItemMore('albums', album)}
                        />
                      }
                    >
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
      {hasTracks && (
        <Section
          title="Top tracks"
          note={formatCount(artist.trackCount)}
          aside={
            <>
              <Button
                {...workspaceTabLinkProps(tabHref('tracks'), 'All tracks')}
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
                        play={
                          <>
                            <TrackSpotifyMatchAction track={track} />
                            <TrackRowPlay
                              track={track}
                              more={libraryItemMore('tracks', track)}
                            />
                          </>
                        }
                      />
                    </TableCell>
                    <TableCell>
                      <TrackAlbumTableValue track={track} />
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
      {hasMixes && (
        <Section
          title="Latest mixes"
          note={formatCount(artist.mixCount)}
          aside={
            <Button
              {...workspaceTabLinkProps(tabHref('mixes'), 'All mixes')}
              variant="link"
              size="xs"
              onClick={() => showTab('mixes')}
            >
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
      {hasPlaylists && (
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
                action={
                  <MetadataSourceControl
                    field="artistTag"
                    name={tag}
                    resource={{ kind: 'artist', id: artist.id }}
                  />
                }
              />
            ))}
          </span>
        </Section>
      )}
    </>
  )
}

/** The page of the artist a merged name was merged into, keeping the page's view. */
export function keptArtistHref(
  keptId: string,
  location: { search: string; hash: string },
) {
  return `${detailPageHref({ kind: 'artist', id: keptId }, new URLSearchParams(location.search))}${location.hash}`
}

export function ArtistDetail({ id: requestedId }: { id: string }) {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const drawer = useContext(InspectorEntryContext)
  const navigation = useDetailInspector()
  const { tab, setTab, tabHref } = useDetailTab(artistTabs, {
    aliases: artistTabAliases,
    // Each tab's list has its own search, filters, sort and view.
    reset: browseStateKeys,
  })
  // A merged name answers with the artist it was merged into, which the page then shows.
  const [shown, setShown] = useState({ requestedId, id: requestedId })
  if (shown.requestedId !== requestedId)
    setShown({ requestedId, id: requestedId })
  const id = shown.requestedId === requestedId ? shown.id : requestedId
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
  useDetailPerformance('artists', id, query)
  /** Shows another artist in place of this one, replacing the URL. */
  function showArtist(nextId: string) {
    if (drawer && navigation) {
      navigation.replace({
        kind: 'artist',
        id: nextId,
        view: drawer.active?.view,
      })
      return
    }
    setShown({ requestedId, id: nextId })
    window.history.replaceState(
      null,
      '',
      keptArtistHref(nextId, window.location),
    )
  }
  const [mergeArtistId, setMergeArtistId] = useState<string | null>(null)
  const merge = useMerge(artistMergeAdapter, {
    requireReview: true,
    onMerge: (change) => {
      if (change.target && change.target.id !== id) showArtist(change.target.id)
    },
  })
  const loaded = query.data
  useEffect(() => {
    if (!loaded || loaded.id === id) return
    client.setQueryData(['artist', loaded.id], loaded)
    showArtist(loaded.id)
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
          artist.inLibrary === false ? 'Outside library' : undefined,
          profile.country,
          profile.type,
          `${formatCount(artist.albumCount)} ${artist.albumCount === 1 ? 'album' : 'albums'}`,
          `${formatCount(artist.trackCount)} ${artist.trackCount === 1 ? 'track' : 'tracks'}`,
          artist.keptNames.length
            ? `Also known as ${artist.keptNames.map(({ name }) => `“${name}”`).join(', ')}`
            : undefined,
        ]}
        links={
          <ArtistProfileLinks
            snapshots={artist.providers}
            identifiers={artist.identifiers}
          />
        }
        actions={
          <>
            <CatalogLibraryAction
              key={artist.id}
              id={artist.id}
              kind="artist"
              title={artist.name}
              inLibrary={artist.inLibrary ?? true}
            />
            <DetailActionsSpacer />
            <DetailMore
              crumb={{ title: artist.name }}
              feedback={merge.feedback}
              items={[
                {
                  label: 'Merge with…',
                  disabled: merge.pending,
                  onSelect: () => {
                    merge.clearError()
                    setMergeArtistId(artist.id)
                  },
                },
              ]}
            />
          </>
        }
      />
      {mergeArtistId === artist.id && (
        <ArtistMergePicker
          artist={artist}
          onClose={() => setMergeArtistId(null)}
          onPick={(candidateId) => {
            setMergeArtistId(null)
            void merge.merge([artist.id, candidateId])
          }}
        />
      )}
      {merge.dialog}
      {merge.error && !merge.review && (
        <Notice tone="danger">{merge.error}</Notice>
      )}
      {merge.result}
      <DetailTabs
        label="Artist details"
        value={shownTab}
        onChange={setTab}
        tabs={tabs}
        reset={browseStateKeys}
      >
        <TabsContent value="overview">
          <ArtistOverview
            artist={artist}
            path={path}
            showTab={(next) => setTab(next)}
            tabHref={tabHref}
          />
        </TabsContent>
        <TabsContent value="albums">
          <ArtistAlbums
            key={artist.id}
            artistId={artist.id}
            showSources={() => setTab('sources')}
          />
        </TabsContent>
        <TabsContent value="tracks">
          <EmbeddedTrackBrowser
            creator={{ creatorId: artist.id }}
            storage="artist-tracks"
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
          <CatalogDiscoveries id={artist.id} kind="artist" />
          <ArtistProfileSources
            id={artist.id}
            snapshots={artist.providers}
            identifiers={artist.identifiers}
          />
          <LibraryRecordChanges
            key={`changes-${artist.id}`}
            kind="artist"
            recordId={artist.id}
            onResolved={showArtist}
          />
        </TabsContent>
      </DetailTabs>
    </article>
  )
}
