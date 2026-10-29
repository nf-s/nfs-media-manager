'use client'
import MediaDetail from '../media-detail'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
export default function AlbumDetailPageClient({
  albumId,
}: {
  albumId: string
}) {
  const params = useSearchParams()
  return (
    <div className="detail-page">
      <Link href={`/albums${params.size ? `?${params}` : ''}`}>
        Back to albums
      </Link>
      <MediaDetail mediaType="album" id={albumId} />
    </div>
  )
}
