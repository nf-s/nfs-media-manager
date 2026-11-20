'use client'

import type { TrackListItem } from '@repo/schemas/tracks'
import { Fragment } from 'react'
import { Pill, PillLabel, Pills } from '@repo/ui/components/ds/pill'
import { workspaceTabLinkProps } from '@/utils/workspace-tab-destination'
import { DetailLink } from './detail-link'

export function CreatorLinks({
  creators,
  kind,
  pills = false,
  fallbackHref,
}: {
  creators: Array<{ id: string | null; name: string }>
  kind: 'artist' | 'person'
  pills?: boolean
  fallbackHref?: (name: string) => string
}) {
  function fallbackProps(name: string) {
    return fallbackHref
      ? { ...workspaceTabLinkProps(fallbackHref(name), name), tabIndex: 0 }
      : undefined
  }
  if (pills)
    return (
      <Pills wrap>
        {creators.map((creator) =>
          creator.id ? (
            <Pill asChild size="md" key={creator.id}>
              <DetailLink
                kind={kind}
                id={creator.id}
                title={`Open ${creator.name}`}
              >
                <PillLabel>{creator.name}</PillLabel>
              </DetailLink>
            </Pill>
          ) : (
            <Pill size="md" key={creator.name} {...fallbackProps(creator.name)}>
              {creator.name}
            </Pill>
          ),
        )}
      </Pills>
    )
  return (
    <span className="inline-values">
      {creators.map((creator, index) => (
        <Fragment key={creator.id ?? creator.name}>
          {index > 0 && ', '}
          {creator.id ? (
            <DetailLink
              className="hover:underline"
              kind={kind}
              id={creator.id}
              title={`Open ${creator.name}`}
            >
              {creator.name}
            </DetailLink>
          ) : (
            <span {...fallbackProps(creator.name)}>{creator.name}</span>
          )}
        </Fragment>
      ))}
    </span>
  )
}

export function TrackArtistLinks({
  track,
  pills = false,
  fallbackHref,
}: {
  track: Pick<TrackListItem, 'artists' | 'artistCredits'>
  pills?: boolean
  fallbackHref?: (name: string) => string
}) {
  const creators = track.artists.map((name) => ({
    id: track.artistCredits.find((credit) => credit.name === name)?.id ?? null,
    name,
  }))
  return (
    <CreatorLinks
      creators={creators}
      kind="artist"
      pills={pills}
      fallbackHref={fallbackHref}
    />
  )
}
