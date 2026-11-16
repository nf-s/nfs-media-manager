'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import TrackDetailView from '../track-detail'
import { DetailPage } from '../detail-frame'

export default function TrackDetailPageClient({
  trackId,
}: {
  trackId: string
}) {
  const params = useSearchParams()
  const router = useRouter()
  return (
    <DetailPage
      back={{
        href: `/tracks${params.size ? `?${params}` : ''}`,
        label: 'Back to tracks',
      }}
    >
      <TrackDetailView
        id={trackId}
        onMerged={(targetId) =>
          router.replace(`/tracks/${encodeURIComponent(targetId)}`)
        }
      />
    </DetailPage>
  )
}
