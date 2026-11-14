'use client'
import TrackDetailView from '../track-detail'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
export default function TrackDetailPageClient({
  trackId,
}: {
  trackId: string
}) {
  const params = useSearchParams()
  const router = useRouter()
  return (
    <div className="detail-page">
      <Link href={`/tracks${params.size ? `?${params}` : ''}`}>
        Back to tracks
      </Link>
      <TrackDetailView
        id={trackId}
        onMerged={(targetId) =>
          router.replace(`/tracks/${encodeURIComponent(targetId)}`)
        }
      />
    </div>
  )
}
