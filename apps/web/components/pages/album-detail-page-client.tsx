'use client'

import { useSearchParams } from 'next/navigation'
import MediaDetail from '../media-detail'
import { DetailPage } from '../detail-frame'

export default function AlbumDetailPageClient({
  albumId,
}: {
  albumId: string
}) {
  const params = useSearchParams()
  return (
    <DetailPage
      back={{
        href: `/albums${params.size ? `?${params}` : ''}`,
        label: 'Back to albums',
      }}
    >
      <MediaDetail mediaType="album" id={albumId} />
    </DetailPage>
  )
}
