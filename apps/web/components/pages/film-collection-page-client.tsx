'use client'

import Link from 'next/link'
import { FilmCollectionEntries } from '../film-collection-detail'

export default function FilmCollectionPageClient({
  collectionId,
}: {
  collectionId: string
}) {
  return (
    <div className="detail-page flex h-full min-h-0 w-full max-w-none flex-1 flex-col gap-3">
      <Link href="/collections">Back to collections</Link>
      <FilmCollectionEntries id={collectionId} />
    </div>
  )
}
