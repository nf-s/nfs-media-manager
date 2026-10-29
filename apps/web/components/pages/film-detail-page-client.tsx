'use client'
import MediaDetail from '../media-detail'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
export default function FilmDetailPageClient({ filmId }: { filmId: string }) {
  const params = useSearchParams()
  return (
    <div className="detail-page">
      <Link href={`/films${params.size ? `?${params}` : ''}`}>
        Back to films
      </Link>
      <MediaDetail mediaType="film" id={filmId} />
    </div>
  )
}
