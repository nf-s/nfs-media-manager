'use client'

import { useSearchParams } from 'next/navigation'
import MediaDetail from '../media-detail'
import { DetailPage } from '../detail-frame'

export default function FilmDetailPageClient({ filmId }: { filmId: string }) {
  const params = useSearchParams()
  return (
    <DetailPage
      back={{
        href: `/films${params.size ? `?${params}` : ''}`,
        label: 'Back to films',
      }}
    >
      <MediaDetail mediaType="film" id={filmId} />
    </DetailPage>
  )
}
