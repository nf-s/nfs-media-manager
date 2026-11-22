'use client'

import {
  formatBrowseFilterValue,
  type BrowseField,
  type BrowseFilter,
} from '@repo/schemas/browse'
import { getTrackBrowseValues, type TrackListItem } from '@repo/schemas/tracks'
import { EmptyValue, Pill, PillLabel, Pills } from '@repo/ui/components/ds/pill'
import {
  formatFieldValue,
  textValues,
  type BrowseFilterHref,
} from '@/utils/browse-items'
import { workspaceTabLinkProps } from '@/utils/workspace-tab-destination'
import { BrowseTagBadges } from './browse-controls'
import { TrackArtistLinks } from './creator-links'
import { DetailLink } from './detail-link'

export function TrackBrowseAlbum({
  track,
  filterHref,
}: {
  track: TrackListItem
  filterHref?: BrowseFilterHref
}) {
  if (track.album)
    return (
      <DetailLink
        kind="album"
        id={track.album.id}
        title={`Open ${track.album.title} in the album library`}
      >
        {track.albumName ?? track.album.title}
      </DetailLink>
    )
  return track.albumName ? (
    <span
      {...(filterHref
        ? {
            ...workspaceTabLinkProps(
              filterHref({ field: 'album', value: track.albumName }),
              track.albumName,
            ),
            tabIndex: 0,
          }
        : undefined)}
      className="ds-muted"
      title="Not in the album library"
    >
      {track.albumName}
    </span>
  ) : null
}

export function TrackBrowseTags({
  track,
  field = 'genre',
  onFilter,
  filterHref,
}: {
  track: TrackListItem
  field?: string
  onFilter: (filter: BrowseFilter, keepOpen?: boolean) => void
  filterHref?: BrowseFilterHref
}) {
  return (
    <BrowseTagBadges
      field={field}
      tags={field === 'artistTag' ? track.artistTags : track.albumTags}
      artistTags={field === 'genre' ? track.artistTags : undefined}
      onFilter={onFilter}
      filterHref={filterHref}
      max={2}
    />
  )
}

export function TrackBrowseValue({
  track,
  field,
  onFilter,
  filterHref,
}: {
  track: TrackListItem
  field: BrowseField
  onFilter: (filter: BrowseFilter, keepOpen?: boolean) => void
  filterHref?: BrowseFilterHref
}) {
  if (field.key === 'artist')
    return (
      <TrackArtistLinks
        track={track}
        fallbackHref={
          filterHref
            ? (value) => filterHref({ field: 'artist', value })
            : undefined
        }
      />
    )
  if (field.key === 'album')
    return track.album || track.albumName ? (
      <TrackBrowseAlbum track={track} filterHref={filterHref} />
    ) : (
      <EmptyValue />
    )
  if (field.key === 'playlist')
    return track.playlists.length ? (
      <Pills max={2} label="Playlists">
        {track.playlists.map((playlist) => (
          <Pill asChild key={playlist.id}>
            <DetailLink
              kind="playlist"
              id={playlist.id}
              title={`Open ${playlist.name}`}
            >
              <PillLabel>{playlist.name}</PillLabel>
            </DetailLink>
          </Pill>
        ))}
      </Pills>
    ) : (
      <EmptyValue />
    )
  const value = getTrackBrowseValues(track)[field.key]
  if (['genre', 'albumTag', 'artistTag'].includes(field.key))
    return textValues(value).length ? (
      <TrackBrowseTags
        track={track}
        field={field.key}
        onFilter={onFilter}
        filterHref={filterHref}
      />
    ) : (
      <EmptyValue />
    )
  if (field.type === 'text' && field.filterable) {
    const values = textValues(value)
    if (!values.length) return <EmptyValue />
    return (
      <Pills max={2} label={field.label}>
        {values.map((value) => (
          <Pill asChild key={value}>
            <button
              {...(filterHref
                ? workspaceTabLinkProps(
                    filterHref({ field: field.key, value }),
                    value,
                  )
                : undefined)}
              type="button"
              title={`Filter ${field.label}: ${formatBrowseFilterValue(field.key, value)}`}
              onClick={() => onFilter({ field: field.key, value })}
            >
              <PillLabel>{formatBrowseFilterValue(field.key, value)}</PillLabel>
            </button>
          </Pill>
        ))}
      </Pills>
    )
  }
  return formatFieldValue(field, value)
}
