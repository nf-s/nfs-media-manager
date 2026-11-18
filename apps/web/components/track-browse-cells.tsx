'use client'

import type { BrowseField, BrowseFilter } from '@repo/schemas/browse'
import { getTrackBrowseValues, type TrackListItem } from '@repo/schemas/tracks'
import { EmptyValue, Pill, PillLabel, Pills } from '@repo/ui/components/ds/pill'
import { formatFieldValue, textValues } from '@/utils/browse-items'
import { BrowseTagBadges } from './browse-controls'
import { TrackArtistLinks } from './creator-links'
import { DetailLink } from './detail-link'

export function TrackBrowseAlbum({ track }: { track: TrackListItem }) {
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
    <span className="ds-muted" title="Not in the album library">
      {track.albumName}
    </span>
  ) : null
}

export function TrackBrowseTags({
  track,
  field = 'genre',
  onFilter,
}: {
  track: TrackListItem
  field?: string
  onFilter: (filter: BrowseFilter, keepOpen?: boolean) => void
}) {
  return (
    <BrowseTagBadges
      field={field}
      tags={field === 'artistTag' ? track.artistTags : track.albumTags}
      artistTags={field === 'genre' ? track.artistTags : undefined}
      onFilter={onFilter}
      max={2}
    />
  )
}

export function TrackBrowseValue({
  track,
  field,
  onFilter,
}: {
  track: TrackListItem
  field: BrowseField
  onFilter: (filter: BrowseFilter, keepOpen?: boolean) => void
}) {
  if (field.key === 'artist') return <TrackArtistLinks track={track} />
  if (field.key === 'album')
    return track.album || track.albumName ? (
      <TrackBrowseAlbum track={track} />
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
      <TrackBrowseTags track={track} field={field.key} onFilter={onFilter} />
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
              type="button"
              title={`Filter ${field.label}: ${value}`}
              onClick={() => onFilter({ field: field.key, value })}
            >
              <PillLabel>{value}</PillLabel>
            </button>
          </Pill>
        ))}
      </Pills>
    )
  }
  return formatFieldValue(field, value)
}
