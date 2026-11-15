'use client'

import React, { type MouseEventHandler } from 'react'
import type { AlbumListItem } from '@repo/schemas/media'

export default function AlbumTitle({
  item,
  className,
  onOpenDetails,
}: {
  item: Pick<AlbumListItem, 'title'>
  className?: string
  onOpenDetails?: MouseEventHandler<HTMLButtonElement>
}) {
  return onOpenDetails ? (
    <button
      type="button"
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
