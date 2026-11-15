'use client'

import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { PlaylistInspectorContent } from '../detail-inspector'
import { detailLocation } from '@/utils/detail-inspector'

export default function PlaylistDetailPageClient({
  playlistId,
}: {
  playlistId: string
}) {
  const params = new URLSearchParams(useSearchParams())
  for (const key of ['inspect', 'tab', 'view', 'playlistView'])
    params.delete(key)
  return (
    <div className="detail-page flex h-full min-h-0 w-full max-w-none flex-1 flex-col gap-3">
      <Link href={detailLocation('/playlists', params)}>Back to playlists</Link>
      <PlaylistInspectorContent id={playlistId} />
    </div>
  )
}
