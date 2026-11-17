'use client'

import { useSearchParams } from 'next/navigation'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AudioLines, Disc3 } from 'lucide-react'
import { musicDisplayTags } from '@repo/schemas/music-tags'
import { sameBrowseFilter, type BrowseFilter } from '@repo/schemas/browse'
import {
  TrackDetailSchema,
  trackSourceLabels,
  trackSpotifyMatchLabels,
  type TrackDetail,
} from '@repo/schemas/tracks'
import { Thumb } from '@repo/ui/components/ds/artwork'
import {
  DetailActionsSpacer,
  DetailHeader,
} from '@repo/ui/components/ds/detail-header'
import { Facts, Section } from '@repo/ui/components/ds/facts'
import { List, ListRow, RowTitle } from '@repo/ui/components/ds/list-row'
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
import { useConfig } from './providers'
import { fetchApiData } from '@/utils/api'
import { lastfmTrackUrl, trackServiceLinks } from '@/utils/track-links'
import {
  parseTrackFilters,
  trackFilter,
  trackScrobbleRuleLabels,
  tracksHref,
} from '@/utils/track-browse'
import { TrackArtistLinks } from './creator-links'
import { CreatorDetailState } from './creator-detail-state'
import { DetailLink } from './detail-link'
import {
  DetailArt,
  DetailTabs,
  FilterPill,
  OpenAtProvider,
  PlaylistPills,
  useDetailTab,
} from './detail-frame'
import { TrackHeaderPlay } from './detail-play'
import { ListeningStats } from './listening-stats'
import { ListeningTrend } from './listening-trend'
import ServiceIconLinks, { serviceLinks } from './service-icon-links'
import { canMergeLastfmTrack, TrackMergePanel } from './track-merge'
import { DetailMore } from './detail-more'
import TrackAppearsOn from './track-playlist-additions'

type OnFilter = (filter: BrowseFilter, keepOpen?: boolean) => void
type TrackTab = 'overview' | 'sources'
const trackTabs: readonly [TrackTab, ...TrackTab[]] = ['overview', 'sources']
/** Playlists and Listening were tabs before they joined the Overview. */
const trackTabAliases = {
  playlists: 'overview',
  listening: 'overview',
  history: 'sources',
} satisfies Record<string, TrackTab>

/** Values that filter Tracks: in place inside a browser, otherwise as a link. */
function FilterValues({
  field,
  values,
  onFilter,
}: {
  field: string
  values: readonly string[]
  onFilter?: OnFilter
}) {
  const params = useSearchParams()
  const active = parseTrackFilters(params.get('filters'))
  return (
    <span className="ds-pills" data-wrap="">
      {values.map((value) => {
        const filter = trackFilter({ field, value })
        const current = active.find((item) => sameBrowseFilter(item, filter))
        const mode = current ? (current.mode ?? 'any') : undefined
        return onFilter ? (
          <FilterPill
            key={value}
            label={value}
            mode={mode}
            title={`Filter ${field}: ${value}. Shift-click to keep details open.`}
            onClick={(event) => onFilter(filter, event.shiftKey)}
          />
        ) : (
          <FilterPill
            key={value}
            label={value}
            mode={mode}
            href={tracksHref([filter])}
          />
        )
      })}
    </span>
  )
}

/** Why the track has its Spotify ID, or why it has none. */
function spotifyMatchNote(item: TrackDetail) {
  if (item.spotifyMatch === 'spotify-import')
    return item.lastfmSources.some((source) => source.manuallyMatched)
      ? 'Imported from Spotify. The Last.fm names marked below were chosen manually for this recording.'
      : item.sources.includes('lastfm')
        ? 'Imported from Spotify. Last.fm was matched by a unique artist and title match, with compatible album information.'
        : 'The Spotify ID came from a playlist or Liked Songs import.'
  return item.spotifyMatch === 'album-track-list'
    ? 'The linked album’s stored track list has exactly one track with the same title. This automatic match has not been checked against Spotify.'
    : 'No Spotify match for playback. Choose an imported library track to merge into; Spotify has not been searched for this track.'
}

/** The track's Spotify match and the Last.fm names that count towards it. */
export function TrackSources({ item }: { item: TrackDetail }) {
  return (
    <>
      <Section title="Spotify match" flush>
        <p>{trackSpotifyMatchLabels[item.spotifyMatch]}</p>
        <p className="ds-help">{spotifyMatchNote(item)}</p>
      </Section>
      {item.lastfmSources.length > 0 && (
        <Section
          title="Recorded by Last.fm"
          note={formatCount(item.lastfmSources.length)}
        >
          <Table aria-label="Recorded by Last.fm">
            <TableHeader>
              <TableRow>
                <TableHead>Track</TableHead>
                <TableHead>Artist</TableHead>
                <TableHead>Albums</TableHead>
                <TableHead align="end">Scrobbles</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {item.lastfmSources.map((source) => {
                const url = lastfmTrackUrl(source.artistName, source.trackName)
                return (
                  <TableRow
                    key={JSON.stringify([source.artistName, source.trackName])}
                  >
                    <TableCell>
                      <span className="ds-cell-id">
                        <span className="ds-cell-title">
                          {source.trackName}
                        </span>
                        {url && (
                          <ServiceIconLinks
                            links={[
                              { provider: 'lastfm', label: 'Last.fm', url },
                            ]}
                          />
                        )}
                      </span>
                    </TableCell>
                    <TableCell>{source.artistName}</TableCell>
                    <TableCell>
                      {source.albumNames.length
                        ? source.albumNames.join(' · ')
                        : 'Album not supplied'}
                      {source.manuallyMatched && (
                        <span className="ds-muted"> · Manually matched</span>
                      )}
                    </TableCell>
                    <TableCell align="end">
                      {formatCount(source.count)}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
          <p className="ds-help">
            These recorded names give this track its Last.fm source. Scrobbled
            names below include any broader name matches.
          </p>
        </Section>
      )}
      {item.listening.sources.length > 0 && (
        <Section
          title="Scrobbled names"
          note={formatCount(item.listening.sources.length)}
        >
          <Table aria-label="Scrobbled names">
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Match</TableHead>
                <TableHead align="end">Scrobbles</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {item.listening.sources.map((source) => (
                <TableRow key={`${source.artistName}\u0000${source.trackName}`}>
                  <TableCell>
                    <span className="ds-cell-id">
                      <span className="ds-truncate">
                        {source.artistName} — {source.trackName}
                      </span>
                      <ServiceIconLinks
                        links={trackServiceLinks({
                          title: source.trackName,
                          artists: [source.artistName],
                          spotifyUrl: null,
                        })}
                      />
                    </span>
                  </TableCell>
                  <TableCell>
                    {trackScrobbleRuleLabels[source.strategy]}
                  </TableCell>
                  <TableCell align="end">{formatCount(source.count)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Section>
      )}
    </>
  )
}

function TrackOverview({
  item,
  onFilter,
  onResolved,
  showSources,
}: {
  item: TrackDetail
  onFilter?: OnFilter
  onResolved: (id: string) => void
  showSources: () => void
}) {
  const artistTags = musicDisplayTags(item.albumTags, item.artistTags)
    .filter((tag) => tag.source === 'artist')
    .map((tag) => tag.name)
  const tags = [
    { label: 'Album tags', field: 'albumTag', values: item.albumTags },
    { label: 'Artist tags', field: 'artistTag', values: artistTags },
  ].filter((group) => group.values.length > 0)
  return (
    <div className="dtl-overview">
      <div className="dtl-main">
        <Section flush>
          <ListeningStats
            kind="track"
            id={item.id}
            trendOn="scrobbles"
            items={[
              { label: 'scrobbles', value: formatCount(item.scrobbles) },
              { label: 'last played', value: formatDate(item.lastListenedAt) },
              { label: 'added', value: formatDate(item.dateAdded) },
            ]}
          />
        </Section>
        <ListeningTrend kind="track" id={item.id} />
        <TrackAppearsOn track={item} onResolved={onResolved}>
          {(item.album || item.albumName) && (
            <List compact>
              <ListRow
                thumb={
                  <Thumb size={40}>
                    {item.artworkUrl ? (
                      <img className="ds-artimg" src={item.artworkUrl} alt="" />
                    ) : (
                      <Disc3 className="ds-i" aria-hidden="true" />
                    )}
                  </Thumb>
                }
                title={
                  item.album ? (
                    <RowTitle>
                      <DetailLink kind="album" id={item.album.id}>
                        {item.album.title}
                      </DetailLink>
                    </RowTitle>
                  ) : (
                    <span className="ds-row-title">{item.albumName}</span>
                  )
                }
                by={item.album ? 'Album' : 'Album, not in the library'}
              />
            </List>
          )}
          <PlaylistPills playlists={item.playlists} />
        </TrackAppearsOn>
      </div>
      <div className="dtl-side">
        {tags.map((group) => (
          <Section key={group.field} title={group.label}>
            <FilterValues
              field={group.field}
              values={group.values}
              onFilter={onFilter}
            />
          </Section>
        ))}
        <Section
          title="Details"
          aside={
            <Button variant="link" size="xs" onClick={showSources}>
              View source details
            </Button>
          }
        >
          <Facts
            items={[
              {
                label: 'Length',
                value: formatTrackLength(
                  item.durationSec === null ? null : item.durationSec * 1000,
                ),
              },
              {
                label: 'Released',
                value: item.releaseDate?.slice(0, 10) ?? EMPTY_VALUE,
              },
              { label: 'Added', value: formatDate(item.dateAdded) },
              {
                label: 'ISRC',
                value: item.isrc ? (
                  <span className="ds-mono">{item.isrc}</span>
                ) : (
                  EMPTY_VALUE
                ),
              },
              {
                label: 'Source',
                value: item.sources.length ? (
                  <FilterValues
                    field="source"
                    values={item.sources.map(
                      (source) => trackSourceLabels[source],
                    )}
                    onFilter={onFilter}
                  />
                ) : (
                  EMPTY_VALUE
                ),
              },
              {
                label: 'Spotify match',
                value: (
                  <FilterValues
                    field="spotifyMatch"
                    values={[trackSpotifyMatchLabels[item.spotifyMatch]]}
                    onFilter={onFilter}
                  />
                ),
              },
            ]}
          />
        </Section>
      </div>
    </div>
  )
}

export default function TrackDetailView({
  id,
  onFilter,
  onMerged,
}: {
  id: string
  /** Applies a filter in the surrounding browser; without it values link to /tracks. */
  onFilter?: OnFilter
  /** Replaces the discarded track with the retained Spotify track after merging. */
  onMerged?: (targetId: string) => void
}) {
  const { apiBaseUrl } = useConfig()
  const { tab, setTab } = useDetailTab(trackTabs, { aliases: trackTabAliases })
  const [merging, setMerging] = useState(false)
  const detail = useQuery({
    queryKey: ['track', id],
    queryFn: () =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/tracks/${encodeURIComponent(id)}`,
        TrackDetailSchema,
      ),
  })
  if (!detail.data)
    return (
      <CreatorDetailState
        pending={detail.isPending}
        retry={() => detail.refetch()}
        subject="track"
      />
    )
  const item = detail.data
  function openResolvedTrack(targetId: string) {
    if (onMerged) onMerged(targetId)
    else window.location.assign(`/tracks/${encodeURIComponent(targetId)}`)
  }
  const [primaryLink, ...otherLinks] = serviceLinks(trackServiceLinks(item))
  return (
    <article className="dtl-detail">
      {detail.isRefetchError && (
        <CreatorDetailState
          stale
          retry={() => detail.refetch()}
          subject="track"
        />
      )}
      <DetailHeader
        art={
          <DetailArt
            src={item.artworkUrl}
            fallback={<AudioLines className="ds-i" aria-hidden="true" />}
          />
        }
        kind="Track"
        title={item.title}
        by={
          <>
            {item.artists.length > 0 && (
              <>
                by <TrackArtistLinks track={item} />
              </>
            )}
            {(item.album || item.albumName) && (
              <>
                {item.artists.length > 0 ? ' · on ' : 'on '}
                {item.album ? (
                  <DetailLink kind="album" id={item.album.id}>
                    {item.album.title}
                  </DetailLink>
                ) : (
                  item.albumName
                )}
              </>
            )}
          </>
        }
        facts={[
          item.durationSec === null
            ? null
            : formatTrackLength(item.durationSec * 1000),
          item.releaseDate?.slice(0, 4),
        ]}
        actions={
          <>
            <TrackHeaderPlay track={item} />
            <DetailActionsSpacer />
            {otherLinks.length > 0 && <ServiceIconLinks links={otherLinks} />}
            {primaryLink && (
              <OpenAtProvider label={primaryLink.label} url={primaryLink.url} />
            )}
            <DetailMore
              crumb={{ title: item.title }}
              items={
                canMergeLastfmTrack(item)
                  ? [
                      {
                        label: 'Merge with Spotify track',
                        onSelect: () => setMerging(true),
                      },
                    ]
                  : []
              }
            />
          </>
        }
      />
      {merging && canMergeLastfmTrack(item) && (
        <TrackMergePanel
          key={item.id}
          track={item}
          onClose={() => setMerging(false)}
          onMerged={openResolvedTrack}
        />
      )}
      <DetailTabs
        label="Track details"
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'overview', label: 'Overview' },
          { value: 'sources', label: 'Sources' },
        ]}
      >
        <TabsContent value="overview">
          <TrackOverview
            item={item}
            onFilter={onFilter}
            onResolved={openResolvedTrack}
            showSources={() => setTab('sources')}
          />
        </TabsContent>
        <TabsContent value="sources">
          <TrackSources item={item} />
        </TabsContent>
      </DetailTabs>
    </article>
  )
}
