'use client'

import { FilmCollectionEntries } from '../film-collection-detail'
import { DetailPage } from '../detail-frame'

export default function FilmCollectionPageClient({
  collectionId,
}: {
  collectionId: string
}) {
  return (
    <DetailPage back={{ href: '/collections', label: 'Back to collections' }}>
      <FilmCollectionEntries id={collectionId} />
    </DetailPage>
  )
}
