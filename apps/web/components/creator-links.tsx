'use client'

import type { TrackListItem } from '@repo/schemas/tracks'
import { Fragment } from 'react'
import { DetailLink } from './detail-link'

export function CreatorLinks({
  creators,
  kind,
  pills = false,
}: {
  creators: Array<{ id: string | null; name: string }>
  kind: 'artist' | 'person'
  pills?: boolean
}) {
  return (
    <span className={pills ? 'detail-tags' : 'inline-values'}>
      {creators.map((creator, index) => (
        <Fragment key={creator.id ?? creator.name}>
          {!pills && index > 0 && ', '}
          {creator.id ? (
            <DetailLink
              className={pills ? 'metadata-tag' : 'hover:underline'}
              kind={kind}
              id={creator.id}
              title={`Open ${creator.name}`}
            >
              {creator.name}
            </DetailLink>
          ) : (
            <span>{creator.name}</span>
          )}
        </Fragment>
      ))}
    </span>
  )
}

export function TrackArtistLinks({
  track,
  pills = false,
}: {
  track: Pick<TrackListItem, 'artists' | 'artistCredits'>
  pills?: boolean
}) {
  const creators = track.artists.map((name) => ({
    id: track.artistCredits.find((credit) => credit.name === name)?.id ?? null,
    name,
  }))
  return <CreatorLinks creators={creators} kind="artist" pills={pills} />
}
