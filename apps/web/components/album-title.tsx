'use client'

import React, { type MouseEventHandler } from 'react'
import type { AlbumListItem } from '@repo/schemas/media'
import { albumSpotifyDestination } from '../utils/album-links'
import ExternalLink from './external-link'

export default function AlbumTitle({
  item,
  className,
  onOpenDetails,
}: {
  item: Pick<
    AlbumListItem,
    'title' | 'spotifyUrl' | 'links' | 'providerReferences'
  >
  className?: string
  onOpenDetails?: MouseEventHandler<HTMLButtonElement>
}) {
  const href = albumSpotifyDestination(item)
  if (href)
    return (
      <ExternalLink
        href={href}
        className={`${className ?? ''} text-[#087339] hover:underline`}
        title={`Open ${item.title} on Spotify (new tab)`}
        aria-label={`${item.title} on Spotify (opens in a new tab)`}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        {item.title}
      </ExternalLink>
    )
  return onOpenDetails ? (
    <button
      className={className}
      title={`Open details for ${item.title}`}
      onClick={onOpenDetails}
    >
      {item.title}
    </button>
  ) : (
    <>{item.title}</>
  )
}
