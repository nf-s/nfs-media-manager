'use client'

import Link from 'next/link'
import { useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import { Button } from '@repo/ui/components/ui/button'
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@repo/ui/components/ui/tabs'
import { sameBrowseFilter, type BrowseFilter } from '@repo/schemas/browse'
import {
  TrackDetailSchema,
  trackSourceLabels,
  trackSpotifyMatchLabels,
  type TrackDetail,
} from '@repo/schemas/tracks'
import { useConfig } from './providers'
import { fetchApiData } from '@/utils/api'
import { monthBars } from '@/utils/listening-chart'
import { playlistHref } from '@/utils/playlist-links'
import { lastfmTrackUrl, trackServiceLinks } from '@/utils/track-links'
import {
  albumHref,
  formatTrackDuration,
  parseTrackFilters,
  trackFilter,
  trackScrobbleRuleLabels,
  tracksHref,
} from '@/utils/track-browse'
import { filterModeClass } from './browse-controls'
import { FilterButton } from './filter-affordance'
import { ListeningChart } from './listening-chart'
import MediaArtwork from './media-artwork'
import { LibraryTrackPlayButtons } from './play-controls'
import ServiceIconLinks from './service-icon-links'
import TrackMerge from './track-merge'
import TrackPlaylistAdditions from './track-playlist-additions'

type OnFilter = (filter: BrowseFilter, keepOpen?: boolean) => void

function FilterValue({
  field,
  value,
  onFilter,
}: {
  field: string
  value: string
  onFilter?: OnFilter
}) {
  const params = useSearchParams()
  const filter = trackFilter({ field, value })
  const active = parseTrackFilters(params.get('filters')).find((item) =>
    sameBrowseFilter(item, filter),
  )
  const className = `metadata-tag ${active ? filterModeClass(active.mode) : ''}`
  if (!onFilter)
    return (
      <Link className={className} href={tracksHref([filter])}>
        {value}
      </Link>
    )
  return (
    <FilterButton
      className={className}
      title={`Filter ${field}: ${value}. Shift-click to keep details open.`}
      onClick={(event) => onFilter(filter, event.shiftKey)}
    >
      {value}
    </FilterButton>
  )
}

function FilterValues({
  field,
  values,
  onFilter,
}: {
  field: string
  values: string[]
  onFilter?: OnFilter
}) {
  return (
    <div className="detail-tags">
      {values.map((value) => (
        <FilterValue
          key={value}
          field={field}
          value={value}
          onFilter={onFilter}
        />
      ))}
    </div>
  )
}

type OnOpenPlaylist = (id: string, trigger: HTMLElement) => void

/** The track's playlists; each opens the playlist drawer, which can filter by it. */
function PlaylistValues({
  playlists,
  onOpenPlaylist,
}: {
  playlists: TrackDetail['playlists']
  onOpenPlaylist?: OnOpenPlaylist
}) {
  return (
    <div className="detail-tags">
      {playlists.map((playlist) =>
        onOpenPlaylist ? (
          <button
            key={playlist.id}
            type="button"
            className="metadata-tag"
            title={`Open ${playlist.name}`}
            onClick={(event) =>
              onOpenPlaylist(playlist.id, event.currentTarget)
            }
          >
            {playlist.name}
          </button>
        ) : (
          <Link
            key={playlist.id}
            className="metadata-tag"
            href={playlistHref(playlist.id)}
          >
            {playlist.name}
          </Link>
        ),
      )}
    </div>
  )
}

function formatDate(value: string | null) {
  return value ? new Date(value).toLocaleDateString() : '-'
}

export function TrackListening({
  listening,
}: {
  listening: TrackDetail['listening']
}) {
  if (listening.total === 0)
    return <p className="quiet">No scrobbles linked to this track.</p>
  const bars = monthBars(listening.months)
  return (
    <>
      <dl className="detail-metrics">
        <div>
          <dt>Scrobbles</dt>
          <dd>{listening.total.toLocaleString()}</dd>
        </div>
        <div>
          <dt>First listened</dt>
          <dd>{formatDate(listening.firstListenedAt)}</dd>
        </div>
        <div>
          <dt>Last listened</dt>
          <dd>{formatDate(listening.lastListenedAt)}</dd>
        </div>
      </dl>
      {bars.length > 0 && (
        <ListeningChart bars={bars} period="month" style="bar" />
      )}
      {listening.sources.length > 0 && (
        <section aria-label="Scrobbled names" className="mt-4 text-sm">
          <h3 className="font-semibold">Scrobbled names</h3>
          <ul className="grid gap-1">
            {listening.sources.map((source) => (
              <li
                className="flex flex-wrap items-center gap-x-2"
                key={`${source.artistName}\u0000${source.trackName}`}
              >
                {source.artistName} — {source.trackName} ·{' '}
                <span className="tabular-nums">
                  {source.count.toLocaleString()}
                </span>{' '}
                <span className="quiet">
                  · {trackScrobbleRuleLabels[source.strategy]}
                </span>
                <ServiceIconLinks
                  links={trackServiceLinks({
                    title: source.trackName,
                    artists: [source.artistName],
                    spotifyUrl: null,
                  })}
                />
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  )
}

export function TrackSources({ item }: { item: TrackDetail }) {
  return (
    <div className="detail-metadata">
      <section>
        <h2>Spotify match</h2>
        <p>{trackSpotifyMatchLabels[item.spotifyMatch]}</p>
        <p className="quiet">
          {item.spotifyMatch === 'spotify-import'
            ? item.lastfmSources.some((source) => source.manuallyMatched)
              ? 'Imported from Spotify. The Last.fm names marked below were chosen manually for this recording.'
              : item.sources.includes('lastfm')
                ? 'Imported from Spotify. Last.fm was matched by a unique artist and title match, with compatible album information.'
                : 'The Spotify ID came from a playlist or Liked Songs import.'
            : item.spotifyMatch === 'album-track-list'
              ? 'The linked album’s stored track list has exactly one track with the same title. This automatic match has not been checked against Spotify.'
              : 'No Spotify match for playback. Choose an imported library track to merge into; Spotify has not been searched for this track.'}
        </p>
      </section>
      {item.lastfmSources.length > 0 && (
        <section>
          <h2>Recorded by Last.fm</h2>
          <ul className="grid gap-3 text-sm">
            {item.lastfmSources.map((source) => {
              const url = lastfmTrackUrl(source.artistName, source.trackName)
              return (
                <li key={JSON.stringify([source.artistName, source.trackName])}>
                  <div className="flex flex-wrap items-center gap-2">
                    <strong>{source.trackName}</strong>
                    {url && (
                      <ServiceIconLinks
                        links={[{ provider: 'lastfm', label: 'Last.fm', url }]}
                      />
                    )}
                  </div>
                  <p>{source.artistName}</p>
                  <p className="quiet">
                    {source.albumNames.length
                      ? source.albumNames.join(' · ')
                      : 'Album not supplied'}
                    {' · '}
                    {source.count.toLocaleString()} scrobbles
                    {source.manuallyMatched && ' · Manually matched'}
                  </p>
                </li>
              )
            })}
          </ul>
          <p className="quiet mt-3">
            These recorded names give this track its Last.fm source. The
            Listening tab also includes any broader name matches.
          </p>
        </section>
      )}
    </div>
  )
}

export default function TrackDetailView({
  id,
  onFilter,
  onOpenPlaylist,
  onMerged,
}: {
  id: string
  /** Applies a filter in the surrounding browser; without it values link to /tracks. */
  onFilter?: OnFilter
  /** Opens a playlist's drawer in the surrounding browser; without it playlists link to the Playlists page. */
  onOpenPlaylist?: OnOpenPlaylist
  /** Replaces the discarded track with the retained Spotify track after merging. */
  onMerged?: (targetId: string) => void
}) {
  const { apiBaseUrl } = useConfig()
  const [tab, setTab] = useState('overview')
  const detail = useQuery({
    queryKey: ['track', id],
    queryFn: () =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/tracks/${encodeURIComponent(id)}`,
        TrackDetailSchema,
      ),
  })
  if (detail.isPending) return <p className="browse-empty">Loading...</p>
  if (!detail.data)
    return (
      <p role="alert">
        Could not load this track.{' '}
        <Button onClick={() => detail.refetch()}>Retry</Button>
      </p>
    )
  const item = detail.data
  function openResolvedTrack(targetId: string) {
    if (onMerged) onMerged(targetId)
    else window.location.assign(`/tracks/${encodeURIComponent(targetId)}`)
  }
  return (
    <div className="media-detail">
      <header className="detail-heading">
        <MediaArtwork
          src={item.artworkUrl}
          alt={item.title}
          fallbackLabel="No artwork"
          containerClassName="detail-art"
          imageClassName="aspect-square object-cover w-full"
          fallbackClassName="aspect-square"
        />
        <div className="min-w-0">
          <h1 className="break-words">{item.title}</h1>
          <FilterValues
            field="artist"
            values={item.artists}
            onFilter={onFilter}
          />
          {item.album ? (
            <Link
              className="text-sm underline underline-offset-2"
              href={albumHref(item.album.id)}
            >
              {item.album.title}
            </Link>
          ) : item.albumName ? (
            <p className="text-sm">{item.albumName}</p>
          ) : null}
          <div className="detail-facts mt-2">
            {item.releaseDate && <span>{item.releaseDate.slice(0, 10)}</span>}
            {item.durationSec !== null && (
              <span>{formatTrackDuration(item.durationSec)}</span>
            )}
          </div>
          <ServiceIconLinks links={trackServiceLinks(item)} />
          <LibraryTrackPlayButtons track={item} />
          <div className="mt-2">
            <TrackMerge track={item} onMerged={openResolvedTrack} />
          </div>
        </div>
      </header>
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList aria-label="Track details">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="listening">Listening</TabsTrigger>
          <TabsTrigger value="sources">Sources</TabsTrigger>
        </TabsList>
        <TabsContent value="overview">
          <dl className="detail-metrics">
            <div>
              <dt>Scrobbles</dt>
              <dd>{item.scrobbles.toLocaleString()}</dd>
            </div>
            {item.lastListenedAt && (
              <div>
                <dt>Last listened</dt>
                <dd>{formatDate(item.lastListenedAt)}</dd>
              </div>
            )}
            {item.dateAdded && (
              <div>
                <dt>Added</dt>
                <dd>{formatDate(item.dateAdded)}</dd>
              </div>
            )}
            {item.isrc && (
              <div>
                <dt>ISRC</dt>
                <dd className="select-text">{item.isrc}</dd>
              </div>
            )}
          </dl>
          <div className="detail-metadata">
            {item.sources.length > 0 && (
              <section>
                <h2>Source</h2>
                <FilterValues
                  field="source"
                  values={item.sources.map(
                    (source) => trackSourceLabels[source],
                  )}
                  onFilter={onFilter}
                />
              </section>
            )}
            <section>
              <h2>Spotify match</h2>
              <div className="flex flex-wrap items-center gap-2">
                <FilterValues
                  field="spotifyMatch"
                  values={[trackSpotifyMatchLabels[item.spotifyMatch]]}
                  onFilter={onFilter}
                />
                <button
                  type="button"
                  className="quiet underline underline-offset-2"
                  onClick={() => setTab('sources')}
                >
                  View source details
                </button>
              </div>
            </section>
            <section>
              <h2>Playlists</h2>
              <PlaylistValues
                playlists={item.playlists}
                onOpenPlaylist={onOpenPlaylist}
              />
              <TrackPlaylistAdditions
                track={item}
                onResolved={openResolvedTrack}
              />
            </section>
            {item.albumTags.length > 0 && (
              <section>
                <h2>Album tags</h2>
                <FilterValues
                  field="genre"
                  values={item.albumTags}
                  onFilter={onFilter}
                />
              </section>
            )}
          </div>
        </TabsContent>
        <TabsContent value="listening">
          <TrackListening listening={item.listening} />
        </TabsContent>
        <TabsContent value="sources">
          <TrackSources item={item} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
