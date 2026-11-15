'use client'

import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import {
  ArtistAlbumPageSchema,
  ArtistDetailSchema,
  ArtistPlaylistPageSchema,
  ArtistTrackPageSchema,
  type ArtistDetail as Artist,
  type ArtistPlaylist,
} from '@repo/schemas/creators'
import type { AlbumListItem } from '@repo/schemas/media'
import type { TrackListItem } from '@repo/schemas/tracks'
import { Button } from '@repo/ui/components/ui/button'
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@repo/ui/components/ui/tabs'
import { fetchApiData } from '@/utils/api'
import { artistBrowseHref, artistTagBrowseHref } from '@/utils/creator-browse'
import { safeRatingHref } from '@/utils/provider-ratings'
import { formatTrackDuration } from '@/utils/track-browse'
import {
  ArtistProfileLinks,
  ArtistProfileSources,
} from './artist-profile-sources'
import { CreatorDetailState } from './creator-detail-state'
import {
  CreatorLibraryDate,
  CreatorLibraryTable,
  CreatorLibraryTitle,
  type CreatorLibraryColumn,
} from './creator-library-table'
import { useDetailView } from './detail-inspector-context'
import MediaArtwork from './media-artwork'
import {
  AlbumInlinePlayButton,
  LibraryTrackInlinePlayButtons,
} from './play-controls'
import { PlaylistPlayButton } from './playlist-detail'
import { useConfig } from './providers'

const albumColumns: CreatorLibraryColumn<AlbumListItem>[] = [
  {
    key: 'title',
    label: 'Album',
    required: true,
    render: (album) => (
      <CreatorLibraryTitle
        kind="album"
        id={album.id}
        title={album.title}
        action={<AlbumInlinePlayButton album={album} />}
      />
    ),
  },
  {
    key: 'releaseDate',
    label: 'Released',
    render: (album) => <CreatorLibraryDate value={album.releaseDate} />,
  },
  {
    key: 'dateAdded',
    label: 'Added',
    render: (album) => <CreatorLibraryDate value={album.dateAdded} />,
  },
]

const trackColumns: CreatorLibraryColumn<TrackListItem>[] = [
  {
    key: 'title',
    label: 'Track',
    required: true,
    render: (track) => (
      <CreatorLibraryTitle
        kind="track"
        id={track.id}
        title={track.title}
        context={track.album?.title ?? track.albumName ?? undefined}
        action={<LibraryTrackInlinePlayButtons track={track} />}
      />
    ),
  },
  {
    key: 'durationSec',
    label: 'Duration',
    className: 'numeric',
    render: (track) =>
      track.durationSec === null ? '-' : formatTrackDuration(track.durationSec),
  },
  {
    key: 'scrobbles',
    label: 'Scrobbles',
    className: 'numeric',
    render: (track) => track.scrobbles.toLocaleString(),
  },
  {
    key: 'releaseDate',
    label: 'Released',
    render: (track) => <CreatorLibraryDate value={track.releaseDate} />,
  },
  {
    key: 'dateAdded',
    label: 'Added',
    defaultVisible: false,
    render: (track) => <CreatorLibraryDate value={track.dateAdded} />,
  },
]

const playlistColumns: CreatorLibraryColumn<ArtistPlaylist>[] = [
  {
    key: 'name',
    label: 'Playlist',
    required: true,
    render: (playlist) => (
      <CreatorLibraryTitle
        kind="playlist"
        id={playlist.id}
        title={playlist.name}
        action={<PlaylistPlayButton playlist={playlist} />}
      />
    ),
  },
  {
    key: 'trackCount',
    label: 'Artist tracks',
    className: 'numeric',
    render: (playlist) => playlist.trackCount.toLocaleString(),
  },
  {
    key: 'albumCount',
    label: 'Artist albums',
    className: 'numeric',
    render: (playlist) => playlist.albumCount.toLocaleString(),
  },
  {
    key: 'createdAt',
    label: 'Added',
    defaultVisible: false,
    render: (playlist) => <CreatorLibraryDate value={playlist.createdAt} />,
  },
]

const tabs = [
  { value: 'overview', label: 'Overview' },
  { value: 'albums', label: 'Albums' },
  { value: 'tracks', label: 'Tracks' },
  { value: 'playlists', label: 'Playlists' },
  { value: 'sources', label: 'Sources' },
]

function ArtistOverview({ artist }: { artist: Artist }) {
  const { profile } = artist
  return (
    <>
      {profile.summary && (
        <p className="detail-summary whitespace-pre-line break-words">
          {profile.summary}
        </p>
      )}
      <dl className="detail-metrics">
        <div>
          <dt>Albums</dt>
          <dd>{artist.albumCount.toLocaleString()}</dd>
        </div>
        <div>
          <dt>Tracks</dt>
          <dd>{artist.trackCount.toLocaleString()}</dd>
        </div>
        <div>
          <dt>Playlists</dt>
          <dd>{artist.playlistCount.toLocaleString()}</dd>
        </div>
        {profile.name && profile.name !== artist.name && (
          <div>
            <dt>Profile name</dt>
            <dd>{profile.name}</dd>
          </div>
        )}
        {profile.country && (
          <div>
            <dt>Country</dt>
            <dd>{profile.country}</dd>
          </div>
        )}
        {profile.type && (
          <div>
            <dt>Type</dt>
            <dd>{profile.type}</dd>
          </div>
        )}
      </dl>
      {profile.tags.length > 0 && (
        <div className="detail-metadata">
          <section>
            <h2>Artist tags</h2>
            <div className="detail-tags detail-tags-scroll">
              {profile.tags.map((tag) => {
                const library = artist.albumCount > 0 ? 'albums' : 'tracks'
                return (
                  <Link
                    className="metadata-tag"
                    key={tag}
                    href={artistTagBrowseHref(library, tag)}
                    title={`Filter ${library} by artist tag ${tag}`}
                  >
                    {tag}
                  </Link>
                )
              })}
            </div>
          </section>
        </div>
      )}
    </>
  )
}

export function ArtistDetail({ id }: { id: string }) {
  const { apiBaseUrl } = useConfig()
  const view = useDetailView()
  const activeTab =
    view.params.get('tab') === 'history' ? 'sources' : view.params.get('tab')
  const tab = tabs.find(({ value }) => value === activeTab)?.value ?? 'overview'
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

  function setTab(next: string) {
    if (next === 'overview') view.params.delete('tab')
    else view.params.set('tab', next)
    for (const key of ['q', 'sortBy', 'direction', 'view'])
      view.params.delete(key)
    view.replace(view.params)
  }

  return (
    <article className="media-detail">
      {query.isRefetchError && (
        <CreatorDetailState stale retry={query.refetch} subject="artist" />
      )}
      <header className={artwork ? 'detail-heading' : 'mb-4'}>
        {artwork && (
          <MediaArtwork
            src={artwork}
            alt=""
            fallbackLabel="No artist artwork"
            containerClassName="detail-art"
            imageClassName="aspect-square w-full object-cover"
            fallbackClassName="aspect-square"
          />
        )}
        <div className="min-w-0">
          <h1 className="break-words text-xl font-semibold">
            {artist.name} <ArtistProfileLinks snapshots={artist.providers} />
          </h1>
          <div className="form-actions mt-2">
            <Button asChild size="sm" variant="outline">
              <Link href={artistBrowseHref('albums', artist.id)}>
                Filter albums
              </Link>
            </Button>
            <Button asChild size="sm" variant="outline">
              <Link href={artistBrowseHref('tracks', artist.id)}>
                Filter tracks
              </Link>
            </Button>
          </div>
        </div>
      </header>
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList
          aria-label="Artist details"
          className="max-w-full justify-start overflow-x-auto"
        >
          {tabs.map(({ value, label }) => (
            <TabsTrigger key={value} value={value}>
              {label}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="overview">
          <ArtistOverview artist={artist} />
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
              actions: <AlbumInlinePlayButton album={album} />,
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
                formatTrackDuration(track.durationSec),
              actions: <LibraryTrackInlinePlayButtons track={track} />,
            })}
            label="tracks"
            defaultSort={{ key: 'title', direction: 'asc' }}
          />
        </TabsContent>
        <TabsContent value="playlists">
          <CreatorLibraryTable
            kind="playlist"
            queryKey={['artist', id, 'playlists']}
            path={`${path}/playlists`}
            schema={ArtistPlaylistPageSchema}
            columns={playlistColumns}
            card={(playlist) => ({
              title: playlist.name,
              artworkUrl: playlist.artworkUrl,
              metadata: [
                playlist.trackCount
                  ? `${playlist.trackCount.toLocaleString()} artist ${playlist.trackCount === 1 ? 'track' : 'tracks'}`
                  : undefined,
                playlist.albumCount
                  ? `${playlist.albumCount.toLocaleString()} artist ${playlist.albumCount === 1 ? 'album' : 'albums'}`
                  : undefined,
              ]
                .filter(Boolean)
                .join(' · '),
              actions: <PlaylistPlayButton playlist={playlist} />,
            })}
            label="playlists"
            defaultSort={{ key: 'name', direction: 'asc' }}
          />
        </TabsContent>
        <TabsContent value="sources">
          <ArtistProfileSources id={id} snapshots={artist.providers} />
        </TabsContent>
      </Tabs>
    </article>
  )
}
