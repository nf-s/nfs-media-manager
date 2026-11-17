'use client'

import { useSearchParams } from 'next/navigation'
import { PlaylistInspectorContent } from '../detail-inspector'
import { DetailPage } from '../detail-frame'
import { detailLocation } from '@/utils/detail-inspector'

export default function PlaylistDetailPageClient({
  playlistId,
}: {
  playlistId: string
}) {
  const params = new URLSearchParams(useSearchParams())
  for (const key of [
    'inspect',
    'tab',
    'view',
    'playlistView',
    'coverage',
    'playlistGaps',
  ])
    params.delete(key)
  return (
    <DetailPage
      back={{
        href: detailLocation('/playlists', params),
        label: 'Back to playlists',
      }}
    >
      <PlaylistInspectorContent id={playlistId} />
    </DetailPage>
  )
}
