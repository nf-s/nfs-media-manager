'use client'

import { useSearchParams } from 'next/navigation'
import { mediaScope, scopedHref } from '@/utils/media-scope'
import { CollectionEntries } from '../collection-detail'
import { DetailPage } from '../detail-frame'

export default function CollectionPageClient({
  collectionId,
}: {
  collectionId: string
}) {
  const mediaType = mediaScope(useSearchParams().get('mediaType'))
  return (
    <DetailPage
      back={{
        href: scopedHref('/collections', mediaType),
        label: 'Back to collections',
      }}
    >
      <CollectionEntries id={collectionId} mediaType={mediaType} />
    </DetailPage>
  )
}
