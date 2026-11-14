'use client'

import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import { Button } from '@repo/ui/components/ui/button'
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

function TrackListening({
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
              <li key={`${source.artistName}\u0000${source.trackName}`}>
                {source.artistName} — {source.trackName} ·{' '}
                <span className="tabular-nums">
                  {source.count.toLocaleString()}
                </span>{' '}
                <span className="quiet">
                  · {trackScrobbleRuleLabels[source.strategy]}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
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
        <div>
          <h1>{item.title}</h1>
          <FilterValues
            field="artist"
            values={item.artists}
            onFilter={onFilter}
          />
          <div className="detail-facts items-center">
            <span>{item.albumName ?? '-'}</span>
            {item.album ? (
              <Button asChild size="sm" variant="outline">
                <Link href={albumHref(item.album.id)}>Open album</Link>
              </Button>
            ) : (
              <span>Not in the album library</span>
            )}
          </div>
          {item.spotifyUrl && (
            <ServiceIconLinks
              links={[
                { provider: 'spotify', label: 'Spotify', url: item.spotifyUrl },
              ]}
            />
          )}
          <LibraryTrackPlayButtons track={item} />
          {!item.spotifyTrackId && (
            <p className="quiet text-sm">No Spotify match for playback.</p>
          )}
        </div>
      </header>
      <dl className="detail-metrics">
        <div>
          <dt>Duration</dt>
          <dd>{formatTrackDuration(item.durationSec)}</dd>
        </div>
        <div>
          <dt>Added</dt>
          <dd>{item.dateAdded?.slice(0, 10) ?? '-'}</dd>
        </div>
        <div>
          <dt>Released</dt>
          <dd>{item.releaseDate?.slice(0, 10) ?? '-'}</dd>
        </div>
        <div>
          <dt>ISRC</dt>
          <dd className="select-text">{item.isrc ?? '-'}</dd>
        </div>
      </dl>
      <div className="detail-metadata">
        <section>
          <h2>Spotify match</h2>
          <FilterValues
            field="spotifyMatch"
            values={[trackSpotifyMatchLabels[item.spotifyMatch]]}
            onFilter={onFilter}
          />
          <p className="quiet text-sm">
            {item.spotifyMatch === 'spotify-import'
              ? item.lastfmSources.some((source) => source.manuallyMatched)
                ? 'The Spotify ID came from a playlist or Liked Songs import. This recording was chosen manually for the Last.fm names marked below.'
                : item.sources.includes('lastfm')
                  ? 'The Spotify ID came from a playlist or Liked Songs import. Last.fm was matched to this track by a unique artist and title match, with compatible album information.'
                  : 'The Spotify ID came directly from a playlist or Liked Songs import.'
              : item.spotifyMatch === 'album-track-list'
                ? 'The Spotify ID comes from the linked album’s stored track list, where exactly one track has the same title. This automatic match has not been checked against Spotify.'
                : 'No imported Spotify ID or unique match in the linked album’s track list is available. Spotify has not been searched for this track.'}
          </p>
          <TrackMerge
            track={item}
            onMerged={(targetId) => {
              if (onMerged) onMerged(targetId)
              else
                window.location.assign(
                  `/tracks/${encodeURIComponent(targetId)}`,
                )
            }}
          />
        </section>
        {item.sources.length > 0 && (
          <section>
            <h2>Source</h2>
            <FilterValues
              field="source"
              values={item.sources.map((source) => trackSourceLabels[source])}
              onFilter={onFilter}
            />
          </section>
        )}
        {item.playlists.length > 0 && (
          <section>
            <h2>Playlists</h2>
            <PlaylistValues
              playlists={item.playlists}
              onOpenPlaylist={onOpenPlaylist}
            />
          </section>
        )}
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
        {item.lastfmSources.length > 0 && (
          <section>
            <h2>Recorded by Last.fm</h2>
            <ul className="text-sm">
              {item.lastfmSources.map((source) => (
                <li key={JSON.stringify([source.artistName, source.trackName])}>
                  <strong>{source.trackName}</strong> — {source.artistName}
                  {source.manuallyMatched && (
                    <span className="quiet"> · Manually matched</span>
                  )}
                  <p className="quiet">
                    Album:{' '}
                    {source.albumNames.length
                      ? source.albumNames.join(' · ')
                      : 'Not supplied'}{' '}
                    · {source.count.toLocaleString()} scrobbles
                  </p>
                </li>
              ))}
            </ul>
            <p className="quiet text-sm">
              These stored names give this track its Last.fm source. Listening
              totals below can also include broader name matches.
            </p>
          </section>
        )}
        <section>
          <h2>Listening</h2>
          <TrackListening listening={item.listening} />
        </section>
      </div>
    </div>
  )
}
